// 연구실에게 물어보기 (읽기 전용 Q&A). 예: "왜 지금 안 사?", "기준이 뭐야?", "레버리지 왜 1배야?"
//   - 답의 재료는 연구실이 이미 저장해 둔 사실뿐(자동 결정, 기준, 가족 구성원, AI 점수, 코인 시장 신호, AI 성적표).
//   - 무료 Workers AI(판단 작업과 같은 모델 순서)가 쉬운 말로 풀어 준다. AI가 없거나 실패하면 규칙으로 만든 답을 준다(항상 답함).
//   - 아무것도 바꾸지 못한다: 주문·설정 변경·전략 선발에 연결된 코드가 없다. 쓰는 것은 하루 사용량 카운터와 감사 기록뿐.
//   - 투자 조언을 하지 않는다(무엇을 사라/팔라고 하지 않음). 답 끝에 항상 안내 문구를 붙인다.
import { kvSetStmt } from '../db/store.js';
import { aiConfigured, aiModels, textOf, AI_SYMBOLS } from './ai.js';
import { criteriaView } from '../core/criteria.js';
import { membersView } from '../core/members.js';
import { DISCLAIMER } from '../core/decision.js';
import { symName } from '../config.js';
import { gatesFrom } from './lifecycle.js';
import { allStrategies } from '../strategies/index.js';
import { familySignal } from '../strategies/family.js';

// 2026-11-23: "왜 이걸 샀어?"에 실제 거래 기록(가상 체결과 그때 규칙이 적은 이유)으로 답한다.
export const TRADE_DAYS = 14, TRADE_MAX = 40;
const kstHM = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ');
/** 최근 가상 체결(이유 포함). 실패하면 빈 목록 — 답을 막지 않는다. */
export async function recentTrades(env, kv, now) {
  try {
    const { results } = await env.DB.prepare("SELECT run_id, t, sym, side, reason, phase FROM fills WHERE t >= ? AND run_id LIKE '%:paper' ORDER BY t DESC, seq DESC LIMIT ?").bind(now - TRADE_DAYS * 86400, TRADE_MAX).all();
    const names = Object.fromEntries(allStrategies(kv).map((s) => [s.id, { name: s.name, bench: !!s.benchmarkOnly, futures: s.kind === 'futures' || /선물/.test(s.name) }]));
    return (results || []).map((r) => {
      const id = String(r.run_id).replace(/:paper$/, '');
      const n = names[id] || { name: id };
      const act = n.futures ? (r.phase === 'entry' ? (r.side === 'BUY' ? '롱 진입' : '숏 진입') : r.phase === 'exit' ? '청산' : r.side === 'BUY' ? '매수' : '매도') : r.side === 'BUY' ? '매수' : '매도';
      return { id, strategy: n.name, sym: r.sym, symName: symName(r.sym), side: r.side, act, t: r.t, when: kstHM(r.t), reason: String(r.reason || '').slice(0, 200) };
    });
  } catch (_) { return []; }
}
// 2026-11-26 (#F-015): "수익률 어때?"에 '+0.0%'만 말하지 않게 — 장부별 가상 수익·거래 수·그냥 들고 있기·가족 장부가 안 산 까닭.
const FAMILY_SYMS = ['278530', '379800'];
/** 모의 장부 요약(첫 평가 → 마지막 평가). 실패하면 null — 답을 막지 않는다. */
export async function ledgerSummary(env, kv, now) {
  try {
    const { results } = await env.DB.prepare(`SELECT r.id,
      (SELECT COUNT(*) FROM fills f WHERE f.run_id = r.id) nf,
      (SELECT equity FROM equity e WHERE e.run_id = r.id ORDER BY t ASC LIMIT 1) e0,
      (SELECT equity FROM equity e WHERE e.run_id = r.id ORDER BY t DESC LIMIT 1) e1,
      (SELECT bench FROM equity e WHERE e.run_id = r.id ORDER BY t ASC LIMIT 1) b0,
      (SELECT bench FROM equity e WHERE e.run_id = r.id ORDER BY t DESC LIMIT 1) b1,
      (SELECT MIN(t) FROM equity e WHERE e.run_id = r.id) t0
      FROM runs r WHERE r.mode = 'paper'`).all();
    const meta = Object.fromEntries(allStrategies(kv).map((s) => [s.id, s]));
    const rows = (results || []).filter((r) => r.e0 > 0 && r.e1 != null).map((r) => {
      const id = String(r.id).replace(/:paper$/, ''), s = meta[id] || {};
      return { id, name: s.name || id, trades: r.nf | 0, ret: r.e1 / r.e0 - 1, bench: r.b0 > 0 ? r.b1 / r.b0 - 1 : null, t0: r.t0, family: /^family_/.test(id), benchOnly: !!s.benchmarkOnly, market: s.market || null };
    });
    if (!rows.length) return null;
    const traded = rows.filter((r) => r.trades > 0).sort((a, b) => b.ret - a.ret);
    const hold = (re) => rows.find((r) => re.test(r.id));
    const fam = rows.filter((r) => r.family);
    let familySig = null;
    if (fam.length) {
      const t0 = Math.min(...fam.map((r) => r.t0));
      familySig = { since: t0, days: 0, buyDays: 0, today: [] };
      for (const sym of FAMILY_SYMS) {
        const { results: c } = await env.DB.prepare(`SELECT t, c FROM candles WHERE market = 'krx' AND tf = '1d' AND sym = ? ORDER BY t DESC LIMIT 120`).bind(sym).all();
        const bars = (c || []).reverse(), closes = bars.map((b) => b.c);
        let n = 0, buys = 0, last = null;
        for (let i = 64; i < bars.length; i++) {
          if (bars[i].t < t0) continue;
          last = familySignal(closes.slice(Math.max(0, i - 69), i + 1));
          n++; if (last[0] === 'BUY') buys++;
        }
        familySig.days = Math.max(familySig.days, n); familySig.buyDays += buys;
        if (last) familySig.today.push(`${symName(sym)} ${last[0] === 'BUY' ? '사는 조건 맞음' : last[2]}`);
      }
    }
    return { n: rows.length, traded: traded.length, idle: rows.length - traded.length, best: traded[0] || null, worst: traded.at(-1) || null, avg: traded.length ? traded.reduce((a, r) => a + r.ret, 0) / traded.length : null,
      krxHold: hold(/^krx_bh_/), cryptoHold: hold(/^crypto_bh_/), family: fam, familySig };
  } catch (_) { return null; }
}
const FIRST_VERDICT = Date.UTC(2026, 11, 5, 20, 17) / 1000; // 2026-12-06 05:17 KST 첫 사전 등록 후보 판정
function ledgerLines(lg, now) {
  if (!lg) return [];
  const L = [`가상 장부 ${lg.n}개 중 ${lg.traded}개가 실제로 가상 거래를 했고, ${lg.idle}개는 사는 조건이 한 번도 안 맞아 현금으로 기다려서 수익이 0%예요(잃지도 벌지도 않음)`];
  if (lg.best) L.push(`가장 좋은 장부: ${lg.best.name} ${p1(lg.best.ret)} / 가장 나쁜 장부: ${lg.worst.name} ${p1(lg.worst.ret)} (모의 시작부터 지금까지, 가상 돈)`);
  if (lg.avg != null) L.push(`거래한 장부 ${lg.traded}개의 단순 평균 가상 수익: ${p1(lg.avg)} (장부마다 시작일이 조금씩 달라요)`);
  const h = [lg.krxHold && `국내 주식 ETF(KODEX 200TR) ${p1(lg.krxHold.ret)}`, lg.cryptoHold && `비트코인 ${p1(lg.cryptoHold.ret)}`].filter(Boolean);
  if (h.length) L.push(`같은 기간 아무 판단 없이 그냥 사서 들고 있었으면: ${h.join(', ')}`);
  if (lg.family.length) {
    const s = lg.familySig;
    L.push(`가족 장부(${lg.family.map((f) => `${f.name.replace(/^가족 장부\((.*?)\).*/, '$1')} ${f.trades ? `${f.trades}번 거래, ${p1(f.ret)}` : '아직 한 번도 안 삼, 0%'}`).join(' / ')})`
      + (s ? `: 사는 조건(종가가 60일 평균 위, 20일 평균이 60일 평균 위, 60일 수익률 2.5% 넘음, 하루 흔들림 3.5% 이하)이 모의 시작 뒤 ${s.days}거래일 동안 ${s.buyDays ? `${s.buyDays}번 맞았어요` : '한 번도 안 맞았어요 — 규칙대로 현금으로 기다린 것이에요'}` : '')
      + (lg.family[0].bench != null ? `. 같은 기간 KODEX 200TR을 그냥 들고 있었으면 ${p1(lg.family[0].bench)}` : ''));
    if (s?.today.length) L.push(`가족 장부 오늘 신호: ${s.today.join(' / ')}`);
  }
  if (now < FIRST_VERDICT + 86400) L.push('미리 등록한 새 전략 후보의 첫 판정은 12-06(일) 새벽이에요');
  return L;
}
const TRADE_RE = /(?<!안\s?)샀|팔았|매수했|매도했|사들|(?<!실)거래|체결|진입|청산|왜\s*(샀|산|팔|매수|매도)/;
/** 질문에 나온 종목·전략으로 거래를 고른다. 없으면 최근 것. */
export function pickTrades(q, trades, n = 5) {
  const words = (s) => String(s || '').replace(/\(.*?\)/g, ' ').split(/[\s·:.,/+]+/).filter((w) => w.length >= 2);
  const hit = trades.filter((x) => [x.symName, x.sym, ...words(x.symName), ...words(x.strategy)].some((w) => w && q.includes(w)));
  return (hit.length ? hit : trades).slice(0, n);
}

export const ASK_MAX_CHARS = 300;
export const ASK_DAILY_MAX_DEFAULT = 30; // 프롬프트 ≈ 2.5~3.5천 자. gpt-oss-120b 1회 ≈ 100~160 neurons(추정) → 하루 최대 ≈ 3~4.8k. 넘으면 AI 없이 기록으로만 답함.
const KST = 9 * 3600;
const dayK = (t) => new Date((t + KST) * 1000).toISOString().slice(0, 10);
const p1 = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`);

export function cleanQuestion(q) {
  return String(q ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ASK_MAX_CHARS);
}

/** 답의 재료(사실 묶음). 모두 이미 저장된 값이고, 여기서 새로 계산·변경하는 것은 없다. */
export async function askContext(env, kv, now) {
  const d = kv['decision:current'] || null;
  const c = criteriaView(gatesFrom(env));
  const m = membersView(kv['family:members']);
  let ai = [];
  try {
    const { results } = await env.DB.prepare(`SELECT sym, t, value, note FROM signals WHERE kind = 'ai_score' AND t >= ? ORDER BY t DESC LIMIT 12`).bind(now - 2 * 86400).all();
    const seen = new Set();
    for (const r of results) if (!seen.has(r.sym) && AI_SYMBOLS.includes(r.sym)) { seen.add(r.sym); ai.push({ sym: r.sym, name: symName(r.sym), score: r.value, why: r.note, t: r.t }); }
  } catch (_) { ai = []; }
  const g = kv['mkt:guard'] || null;
  return {
    now, decision: d, criteria: c, members: m, ai,
    scorecard: kv['ai:scorecard'] || null,
    guard: g ? { damp: g.damp || null, altHold: g.altHold || null } : null,
    criteriaLog: (kv['criteria:log'] || []).slice(-5),
    trades: await recentTrades(env, kv, now),
    ledgers: await ledgerSummary(env, kv, now),
  };
}

/** 프롬프트·규칙 답변이 함께 쓰는 사실 요약(쉬운 말, 짧게). */
export function factLines(ctx) {
  const d = ctx.decision, L = [];
  if (d) {
    L.push(`지금 결론: ${d.headline}`);
    for (const r of d.reasons || []) L.push(`이유: ${r}`);
    L.push(d.connect?.text || '');
    if (d.verdict !== 'ready') L.push(`다음 점검: ${d.nextCheckText}${d.earliestText ? `, 빨라도 ${d.earliestText}쯤` : ''}`);
    for (const k of ['safe', 'growth']) {
      const b = d.books?.[k];
      if (!b) continue;
      L.push(`${b.label}: 기준 통과 ${b.passedCount}개${b.selected.length ? `, 뽑힌 전략 ${b.selected.map((x) => `${x.name}(배수 ${x.leverage}배)`).join(', ')}` : ''}${b.nearest ? `, 가장 가까운 후보 ${b.nearest.name} (기준 ${b.nearest.passed}/${b.nearest.total}개 통과, 실제로 사고판 날 ${b.nearest.rebalances}번, 가상 수익 ${p1(b.nearest.paperRet)})` : ''}`);
    }
    if (d.recommend) L.push(`장부 선택: ${d.recommend.text}`);
    L.push(`적용 중인 기준 버전: v${d.criteriaVersion ?? ctx.criteria.version}`);
  } else L.push('아직 첫 자동 결정이 나오지 않았어요(6시간 안에 나와요).');
  L.push(`가족 구성원: ${ctx.members.members.map((x) => `${x.label} ${Math.round(x.budgetKrw / 10000)}만 원(${ctx.members.profiles[x.profile]?.label || x.profile})`).join(', ')}`);
  if (ctx.ai.length) L.push(`AI의 최근 종목 점수(-1 나쁨 ~ +1 좋음): ${ctx.ai.map((a) => `${a.name} ${a.score.toFixed(2)}${a.why ? ` (${a.why})` : ''}`).join(' / ')}`);
  const sc = ctx.scorecard;
  if (sc?.n) L.push(`AI 성적표: 지난 판단 ${sc.n}개 중 방향이 맞은 비율 ${Math.round((sc.hit ?? 0) * 100)}% (${sc.horizonDays}일 뒤 실제 가격과 비교)${sc.note ? `, ${sc.note}` : ''}`);
  if (ctx.guard?.damp) L.push(`코인 시장 신호: 새 매수 ${ctx.guard.damp.factor === 0 ? '보류' : `×${ctx.guard.damp.factor}`} 상태`);
  for (const x of (ctx.trades || []).slice(0, 12)) L.push(`가상 거래 기록: ${x.when} [${x.strategy}] ${x.symName} ${x.act} — 그때 규칙이 적은 이유: ${x.reason}`);
  if (ctx.trades && !ctx.trades.length) L.push(`최근 ${TRADE_DAYS}일 동안 가상 거래 기록 없음`);
  L.push(...ledgerLines(ctx.ledgers, ctx.now));
  if (ctx.ledgers) L.push('수익률을 물으면: 위 "가장 가까운 후보"의 수익 하나만 말하지 말고, 장부 몇 개가 거래했는지·가장 좋은/나쁜 장부·그냥 들고 있었으면 얼마·가족 장부가 왜 0%인지를 함께 말한다');
  return L.filter(Boolean);
}

const TOPICS = [
  { key: 'buy', re: /왜.*(안\s*사|안\s*샀|매수.*안|사지\s*않)|언제.*(사|매수|시작|연결)|아직|기다/ },
  { key: 'criteria', re: /기준|조건|규칙|어떻게.*(정|뽑|고르)|통과/ },
  { key: 'leverage', re: /레버리지|배수|[0-9]\s*배|선물|공격|안전\s*장부|수익률.*낮|너무\s*낮/ },
  { key: 'members', re: /구성원|가족|엄마|어머니|금액|예산|추가|삭제|빼/ },
  { key: 'ai', re: /ai|인공지능|모델|점수|똑똑|학습|판단/i },
  { key: 'change', re: /바뀌|변경|이력|버전/ },
  { key: 'risk', re: /위험|손해|손실|잃|안전/ },
  { key: 'real', re: /실제\s*돈|실거래|진짜|연결|주문/ },
  { key: 'return', re: /수익|이익|손익|벌었|벌고|성적|성과|몇\s*퍼|%|얼마/ },
];

/** AI 없이도 항상 줄 수 있는 답(사실 요약을 주제에 맞게 골라 이어 붙임). */
export function ruleAnswer(q, ctx) {
  const d = ctx.decision, c = ctx.criteria;
  const hit = TOPICS.filter((t) => t.re.test(q)).map((t) => t.key);
  if (TRADE_RE.test(q)) hit.push('trade');
  const out = [];
  if (hit.includes('trade')) {
    const tr = pickTrades(q, ctx.trades || []);
    if (tr.length) {
      out.push('가상 장부가 실제로 사고판 기록이에요(가상 돈, 실제 주문 없음):');
      for (const x of tr) out.push(`· ${x.when} [${x.strategy}] ${x.symName} ${x.act} — 이유: ${x.reason}`);
      out.push('이유는 그 장부의 규칙이 그때 숫자를 보고 스스로 적은 것이에요. 규칙은 미리 정해져 있고, 결과를 보고 바꾸지 않아요.');
    } else out.push(`최근 ${TRADE_DAYS}일 동안 가상 장부가 사고판 기록이 없어요. 규칙의 사는 조건이 맞지 않아 현금으로 기다리는 중이에요.`);
  }
  if (hit.includes('return')) {
    const lines = ledgerLines(ctx.ledgers, ctx.now);
    out.push(...(lines.length ? lines.map((l) => `· ${l}`) : ['아직 가상 장부의 평가 기록이 없어요.']));
  }
  const sec = (title) => c.plain.find((x) => x.title.startsWith(title))?.lines || [];
  if (!hit.length || hit.includes('buy') || hit.includes('real')) {
    if (d) {
      out.push(d.headline, ...(d.reasons || []).map((r) => `· ${r}`), d.connect?.text || '');
      if (d.verdict !== 'ready') out.push(`기준을 넘는 전략이 나오면 화면 맨 위 결론이 "연결해도 되는 단계"로 바뀌어요. 다음 점검은 ${d.nextCheckText}${d.earliestText ? ` (빨라도 ${d.earliestText}쯤)` : ''}예요.`);
    } else out.push('아직 첫 자동 결정이 나오지 않았어요. 6시간 안에 나와요.');
    out.push('가상 장부들은 각자 규칙대로 이미 사고팔고 있어요. "안 산다"는 것은 실제 돈을 아직 연결하지 않는다는 뜻이에요.');
  }
  if (hit.includes('criteria')) out.push(`지금 적용 중인 기준(v${c.version}):`, ...sec('전략이 뽑히려면').map((l) => `· ${l}`));
  if (hit.includes('leverage')) {
    out.push(...sec('안전 장부와 공격 장부').map((l) => `· ${l}`));
    const g = d?.books?.growth;
    if (g) out.push(`지금 공격 장부: 기준 통과 ${g.passedCount}개${g.nearest ? `, 가장 가까운 후보는 ${g.nearest.name} (가상 수익 ${p1(g.nearest.paperRet)})` : ''}.`);
    if (d?.recommend) out.push(d.recommend.text);
    out.push('1배로만 두는 것은 안전 장부예요. 배수를 올리면 버는 폭과 잃는 폭이 함께 커지고 실력은 늘지 않아서, 공격 장부는 가상 돈으로 따로 굴리며 숫자로 증명될 때만 권해요.');
  }
  if (hit.includes('members')) out.push(`지금 구성원: ${ctx.members.members.map((x) => `${x.label} ${Math.round(x.budgetKrw / 10000)}만 원`).join(', ')}.`, ...sec('가족 구성원과 금액').slice(0, 2).map((l) => `· ${l}`));
  if (hit.includes('ai')) {
    out.push('AI(무료 모델)는 6시간마다 가격 흐름·흔들림·시장 폭·뉴스 제목·세계 지표를 읽고 종목 점수를 매겨요. 점수는 비교용 가상 장부에만 쓰이고, 전략 선발은 위 기준(숫자)으로만 해요.');
    if (ctx.ai.length) out.push(`최근 점수: ${ctx.ai.map((a) => `${a.name} ${a.score.toFixed(2)}`).join(', ')}.`);
    const sc = ctx.scorecard;
    out.push(sc?.n ? `AI 성적표: 지난 판단 ${sc.n}개 중 방향이 맞은 비율 ${Math.round((sc.hit ?? 0) * 100)}%. 이 성적을 다음 판단 때 AI에게 다시 알려 줘서 스스로 고치게 해요.` : 'AI 성적표는 판단 뒤 7일이 지나야 채점돼서, 아직 쌓이는 중이에요.');
  }
  if (hit.includes('change')) out.push(...sec('기준이 바뀌면').map((l) => `· ${l}`), ...(ctx.criteriaLog.length ? [`최근 변경: ${ctx.criteriaLog[ctx.criteriaLog.length - 1].text}`] : []));
  if (hit.includes('risk') && !hit.includes('leverage')) out.push(`목표는 "${c.goal}"이에요.`, ...sec('안전 장부와 공격 장부').slice(0, 2).map((l) => `· ${l}`));
  return out.filter(Boolean).join('\n');
}

export function askPrompt(q, ctx) {
  return [
    '너는 "모의투자 연구실"의 안내원이다. 사용자는 주식·코인을 전혀 모른다.',
    '규칙: (1) 아래 "사실"에 있는 내용만으로 답한다. 없는 내용은 "그건 연구실 기록에 없어요"라고 한다. (2) 쉬운 한국어, 존댓말(~요), 3~6문장. 전문 용어를 쓰면 바로 풀어 쓴다.',
    '(3) 무엇을 사라/팔라고 권하지 않는다. 수익을 약속하지 않는다. (4) 사용자에게 판단을 떠넘기지 않는다: 시스템이 무엇을 어떻게 정했는지 설명한다. (5) 너는 아무것도 바꿀 수 없다. 바꿔 달라는 요청에는 어느 화면(탭)에서 되는지만 알려 준다. (6) 모든 숫자는 가상 돈 기록이다.',
    '', '사실:', ...factLines(ctx).map((l) => `- ${l}`),
    '', '기준 설명:', ...ctx.criteria.plain.flatMap((s) => [`[${s.title}]`, ...s.lines.map((l) => `- ${l}`)]),
  ].join('\n').slice(0, 9000 - 20 - q.length) + `\n\n질문: ${q}`; // 2026-11-23: 길어도 질문은 잘리지 않게(사실 쪽을 자름)
}

const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-z]*|```/g, '').trim();

/** 질문 하나에 답한다. 반환 { answer, source: 'ai'|'rule', model, left }. */
export async function ask(env, kv, question, now = Math.floor(Date.now() / 1000), { fetcher = fetch } = {}) {
  const q = cleanQuestion(question);
  if (q.length < 2) return { error: '질문을 적어 주세요.' };
  const ctx = await askContext(env, kv, now);
  const fallback = ruleAnswer(q, ctx);
  const max = Math.max(0, Number(env.ASK_DAILY_MAX ?? ASK_DAILY_MAX_DEFAULT) | 0);
  const quota = kv['ask:quota']?.day === dayK(now) ? kv['ask:quota'] : { day: dayK(now), n: 0 };
  let answer = null, model = null, note = '';
  if (aiConfigured(env) && quota.n < max) {
    quota.n += 1;
    const messages = [{ role: 'system', content: '쉬운 한국어로만 답한다. 마크다운 표·코드 금지.' }, { role: 'user', content: askPrompt(q, ctx) }];
    if (env.AI_ENDPOINT && env.AI_API_KEY && env.AI_MODEL) {
      try {
        const res = await fetcher(`${String(env.AI_ENDPOINT).replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` }, body: JSON.stringify({ model: env.AI_MODEL, temperature: 0.2, messages }) });
        if (res.ok) { answer = stripThink(textOf(await res.json().catch(() => null))); model = String(env.AI_MODEL); } else note = `HTTP_${res.status}`;
      } catch (e) { note = String(e?.message || e).slice(0, 80); }
    } else {
      for (const m of aiModels(env)) {
        try {
          const out = await env.AI.run(m, { messages, temperature: 0.2, max_tokens: 1500, ...(m.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}) });
          const t = stripThink(textOf(out));
          if (t && t.length >= 10) { answer = t; model = m; break; }
          note += `${m.split('/').pop()}:EMPTY; `;
        } catch (e) { note += `${m.split('/').pop()}:${String(e?.message || e).slice(0, 40)}; `; }
      }
    }
  } else if (aiConfigured(env)) note = '오늘 AI 질문 한도를 다 써서 기록으로만 답해요';
  const source = answer ? 'ai' : 'rule';
  const text = `${(answer || fallback).slice(0, 1800)}\n\n※ ${DISCLAIMER} 모든 숫자는 가상 돈 기록이에요.`;
  try {
    await env.DB.batch([
      kvSetStmt(env.DB, 'ask:quota', quota),
      env.DB.prepare('INSERT INTO ai_audit (t, model, prompt, response, ok, note) VALUES (?,?,?,?,?,?)').bind(now, String(model || 'rule'), `[질문] ${q}`, text.slice(0, 4000), answer ? 1 : 0, `qa; ${note}`.slice(0, 200)),
    ]);
  } catch (_) { /* 기록 실패가 답을 막지 않게 */ }
  return { answer: text, source, model: model ? model.split('/').pop() : null, left: Math.max(0, max - quota.n), note: source === 'rule' && note ? note.slice(0, 80) : undefined };
}
