// 연구실 자기 점검 (2026-11-23, #F-002 ①). '전체 평가가 안 돎'이 11-18~11-23 5일간 아무도 모르게 지나갔다.
// /health는 문제를 알지만 아무도 안 본다 → Worker 안(기존 10분 크론)에서 6시간마다 스스로 보고, 문제가 있으면
// 텔레그램 한 줄(같은 문제는 하루 한 번). 새 크론·외부 서비스 없이 Claude가 없어도 돈다.
import { kvSetStmt, eventStmt } from '../db/store.js';

const H = 3600, D = 86400;
export const SELFCHECK_EVERY = 6 * H;   // 점검 간격
export const SELFCHECK_REPEAT = D;      // 같은 문제를 다시 알리는 간격
export const LIMITS = Object.freeze({ fullPassH: 48, weeklyD: 8, researchD: 9, crypto1dD: 3, krx1dD: 7 });

const hrs = (s) => Math.round(s / H);
const days = (s) => Math.round(s / D);

/** 지금 kv로 본 문제 목록 [{key, text}]. 쉬운 말, 무엇이 멈췄고 무엇이 안 나가는지. */
export function selfCheckProblems(kv, now) {
  const out = [];
  const fullAt = kv['lc:fullAt'] || 0, fullTry = kv['lc:fullTry'] || 0;
  if ((fullAt || fullTry) && now - fullAt > LIMITS.fullPassH * H) {
    out.push({ key: 'full', text: fullAt ? `자동 결정(전체 평가)이 ${hrs(now - fullAt)}시간째 안 돌았어요 — 월요일 결론·성과표가 안 나갈 수 있어요` : '자동 결정(전체 평가)이 시도만 되고 한 번도 끝나지 않았어요' });
  }
  // 11-18~11-23 실제로 난 상태: 평가(lc:at)는 도는데 자동 결정이 한 번도 없음
  if (!kv['decision:current'] && kv['lc:at'] && !out.length) out.push({ key: 'nodecision', text: '평가는 도는데 자동 결정이 한 번도 안 나왔어요 — 월요일 결론이 안 나가요' });
  const wk = kv['decision:weeklyAt'] || 0;
  if (wk && now - wk > LIMITS.weeklyD * D) out.push({ key: 'weekly', text: `월요일 결론이 ${days(now - wk)}일째 안 나갔어요` });
  const imp = kv['research:lastImport']?.at || 0;
  if (imp && now - imp > LIMITS.researchD * D) out.push({ key: 'research', text: `주간 연구 결과가 ${days(now - imp)}일째 안 들어왔어요(GitHub Actions 'weekly' 확인)` });
  const c1d = kv['ready:crypto:1d'] || 0;
  if (c1d && now - c1d > LIMITS.crypto1dD * D) out.push({ key: 'crypto1d', text: `코인 일봉 시세가 ${days(now - c1d)}일째 안 들어와요` });
  const k1d = kv['ready:krx:1d'] || 0;
  if (k1d && now - k1d > LIMITS.krx1dD * D) out.push({ key: 'krx1d', text: `국내 ETF 시세가 ${days(now - k1d)}일째 안 들어와요` });
  return out;
}

/** 6시간마다: 새 문제(또는 하루 지난 같은 문제)가 있으면 이벤트 1건(kind self_check → 즉시 텔레그램). */
export async function selfCheckTask(env, kv, now) {
  if ((kv['selfcheck:at'] || 0) > now - SELFCHECK_EVERY) return false;
  const probs = selfCheckProblems(kv, now);
  const prev = kv['selfcheck:sent'] || {};
  const fresh = probs.filter((p) => !prev[p.key] || now - prev[p.key] >= SELFCHECK_REPEAT);
  const sent = {};
  for (const p of probs) sent[p.key] = fresh.includes(p) ? now : prev[p.key]; // 나아진 문제는 지워져 다음에 다시 알릴 수 있음
  const stmts = [kvSetStmt(env.DB, 'selfcheck:at', now), kvSetStmt(env.DB, 'selfcheck:sent', sent)];
  if (fresh.length) stmts.push(eventStmt(env.DB, { t: now, kind: 'self_check', strategy_id: null, message: `🩺 연구실 자기 점검: ${fresh.map((p) => p.text).join(' / ')}` }));
  kv['selfcheck:at'] = now; kv['selfcheck:sent'] = sent;
  await env.DB.batch(stmts);
  return fresh.length > 0;
}
