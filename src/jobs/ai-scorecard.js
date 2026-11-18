// AI 성적표: AI가 매긴 점수(예측)를 며칠 뒤 실제 가격(결과)과 대조해 채점하고, 그 성적을 다음 프롬프트에 되돌려 준다.
//   예측(ai_score, 6시간마다) → 실제(7일 뒤 종가) → 점수화(방향 적중률·치우침·상관) → 프롬프트 반영(스스로 보정)
// 가중치(trust)는 기록만 한다: 채점된 판단이 TRUST_MIN_N개 이상 쌓이기 전에는 어떤 장부에도 쓰지 않는다(표본이 작으면 운).
// Pure 부분(scoreJudgments, calibrationLines)은 테스트로 고정. 하루 한 번 aiTask 안에서 계산(추가 크론·AI 호출 없음).
import { DAY } from '../core/calendar.js';
import { kvSetStmt } from '../db/store.js';
import { symName } from '../config.js';

export const SCORE_HORIZON_DAYS = 7;
export const TRUST_MIN_N = 40;
const KST = 9 * 3600;
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param signals [{sym, t, value, note}] ai_score rows (any order)
 * @param closes  {sym: [{t, c}]} daily closes, oldest → newest (t = 봉 라벨, UTC 자정)
 * @returns {n, hit, bias, meanScore, meanRet, ic, bySym, horizonDays, scored:[{sym,t,score,ret}]}
 */
export function scoreJudgments(signals, closes, { now, horizonDays = SCORE_HORIZON_DAYS } = {}) {
  // 하루(KST)·종목당 마지막 판단 하나만: 6시간 간격 판단은 서로 거의 같아서 그대로 세면 표본 수가 부풀려진다
  const byDay = new Map();
  for (const s of signals || []) {
    if (!Number.isFinite(s.value) || String(s.note || '').startsWith('AI 결과 없음')) continue;
    const k = `${s.sym}|${Math.floor((s.t + KST) / DAY)}`;
    if (!byDay.has(k) || byDay.get(k).t < s.t) byDay.set(k, s);
  }
  const asOf = (bars, t) => { let x = null; for (const b of bars) { if (b.t <= t) x = b; else break; } return x; };
  const scored = [];
  for (const s of byDay.values()) {
    const bars = closes?.[s.sym];
    if (!bars?.length || s.t + (horizonDays + 1) * DAY > now) continue; // 아직 결과가 안 나온 판단
    const a = asOf(bars, s.t - DAY), b = asOf(bars, s.t + horizonDays * DAY); // 판단 시점에 이미 끝난 봉 → 7일 뒤까지 끝난 봉
    if (!a || !b || b.t <= a.t || b.t < s.t + (horizonDays - 4) * DAY || !(a.c > 0)) continue;
    scored.push({ sym: s.sym, t: s.t, score: s.value, ret: b.c / a.c - 1 });
  }
  const stat = (rows) => {
    if (!rows.length) return { n: 0 };
    const dir = rows.filter((r) => Math.abs(r.score) > 0.05 && r.ret !== 0);
    const ms = rows.reduce((x, r) => x + r.score, 0) / rows.length, mr = rows.reduce((x, r) => x + r.ret, 0) / rows.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (const r of rows) { sxy += (r.score - ms) * (r.ret - mr); sxx += (r.score - ms) ** 2; syy += (r.ret - mr) ** 2; }
    return { n: rows.length, nDir: dir.length, hit: dir.length ? r3(dir.filter((r) => Math.sign(r.score) === Math.sign(r.ret)).length / dir.length) : null,
      meanScore: r3(ms), meanRet: r3(mr), ic: sxx > 0 && syy > 0 ? r3(sxy / Math.sqrt(sxx * syy)) : null };
  };
  const all = stat(scored);
  const bySym = {};
  for (const sym of [...new Set(scored.map((r) => r.sym))]) bySym[sym] = stat(scored.filter((r) => r.sym === sym));
  // 치우침: 점수 평균과 실제 수익 평균의 방향이 반대이면서 점수가 한쪽으로 쏠려 있으면 '너무 비관/낙관'
  let bias = 'none';
  if (all.n >= 5 && all.meanScore <= -0.3 && all.meanRet > 0) bias = 'too_pessimistic';
  else if (all.n >= 5 && all.meanScore >= 0.3 && all.meanRet < 0) bias = 'too_optimistic';
  const trust = all.n >= TRUST_MIN_N && all.hit != null ? r3(Math.max(0, Math.min(1, (all.hit - 0.4) / 0.2))) : null;
  const note = bias === 'too_pessimistic' ? '지나치게 비관적이었음' : bias === 'too_optimistic' ? '지나치게 낙관적이었음' : '';
  return { ...all, bias, trust, note, bySym, horizonDays, scored: scored.sort((a, b) => a.t - b.t).slice(-60) };
}

/** 프롬프트에 붙일 성적 피드백(영어, 짧게). 채점된 판단이 5개 미만이면 빈 배열. */
export function calibrationLines(sc) {
  if (!sc || !(sc.n >= 5)) return [];
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const L = [`Your own track record (scores vs. the real price change ${sc.horizonDays} days later, ${sc.n} graded judgments):`];
  L.push(`- Direction hit rate: ${sc.hit == null ? 'n/a' : `${Math.round(sc.hit * 100)}%`} (50% = coin flip). Average score ${sc.meanScore}, average realized change ${pct(sc.meanRet)}.${sc.ic != null ? ` Correlation of score with outcome: ${sc.ic}.` : ''}`);
  if (sc.bias === 'too_pessimistic') L.push('- You have been TOO PESSIMISTIC: scores were strongly negative while prices rose. Do not default to -1; reserve it for clear, multi-signal downside.');
  if (sc.bias === 'too_optimistic') L.push('- You have been TOO OPTIMISTIC: scores were strongly positive while prices fell. Demand stronger evidence before a positive score.');
  if (sc.hit != null && sc.hit < 0.45 && sc.nDir >= 10) L.push('- Your directional calls were worse than a coin flip. Use scores closer to 0 unless trend, volatility and breadth all agree.');
  for (const [sym, s] of Object.entries(sc.bySym || {})) if (s.n >= 5) L.push(`- ${sym} (${symName(sym)}): avg score ${s.meanScore}, realized ${pct(s.meanRet)}, hit ${s.hit == null ? 'n/a' : `${Math.round(s.hit * 100)}%`}`);
  L.push('Use this only to calibrate how confident you are. Do not simply flip your scores.');
  return L;
}

/** 하루 한 번 성적표를 다시 계산해 kv 'ai:scorecard'에 저장. 반환: 최신 성적표(없으면 이전 것). */
export async function scorecardTask(env, kv, now, syms) {
  const prev = kv['ai:scorecard'] || null;
  if (prev && (prev.at || 0) > now - DAY) return prev;
  const { results: sig } = await env.DB.prepare(`SELECT sym, t, value, note FROM signals WHERE kind = 'ai_score' AND t >= ? AND sym IN (${syms.map(() => '?').join(',')})`).bind(now - 60 * DAY, ...syms).all();
  const closes = {};
  for (const [market, list] of [['krx', syms.filter((s) => !s.startsWith('KRW-'))], ['crypto', syms.filter((s) => s.startsWith('KRW-'))]]) {
    if (!list.length) continue;
    const { results } = await env.DB.prepare(`SELECT sym, t, c FROM candles WHERE market = ? AND tf = '1d' AND sym IN (${list.map(() => '?').join(',')}) AND t >= ? ORDER BY sym, t`).bind(market, ...list, now - 70 * DAY).all();
    for (const r of results) (closes[r.sym] ||= []).push({ t: r.t, c: r.c });
  }
  const sc = { ...scoreJudgments(sig, closes, { now }), at: now };
  kv['ai:scorecard'] = sc;
  await env.DB.batch([kvSetStmt(env.DB, 'ai:scorecard', sc)]);
  return sc;
}
