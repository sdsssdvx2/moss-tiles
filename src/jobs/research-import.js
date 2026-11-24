// Import of weekly research results (pushed to /api/import, or pulled from RESEARCH_URL by the tick).
import { byId as staticById, variantStrategies, MAX_ACTIVE_VARIANTS } from '../strategies/index.js';
import { backtestStmt, kvAll, kvSetStmt } from '../db/store.js';
import { candidateById, candidateStrategies, releaseAt } from '../strategies/candidates.js';

/**
 * Results of the offline/GitHub-Actions research job: backtest evidence for strategies and
 * NEW variants that passed G1 (they then start the paper pipeline from scratch).
 * Variants can only reference existing code (base strategy) with new parameters.
 */
export async function importResearch(env, body) {
  const kv = await kvAll(env.DB);
  const stmts = [];
  const known = new Set([...Object.keys(staticById), ...variantStrategies(kv.variants).map((v) => v.id), ...candidateStrategies(kv['candidates:released'], new Set(Object.keys(staticById))).map((c) => c.id)]);
  // 사전 등록 후보: 주간 연구가 공개 날짜 뒤 과거 검증을 통과시킨 것만 온다. 코드에 있는 id·공개 날짜가 지난 것만 받는다(시계로 여는 게 아니라 거르기만).
  const nowSec = Math.floor(Date.now() / 1000);
  const released = Array.isArray(kv['candidates:released']) ? [...kv['candidates:released']] : [];
  let addedCandidates = 0;
  for (const c of (Array.isArray(body?.candidates) ? body.candidates : []).slice(0, 10)) {
    const s = candidateById[c?.id];
    if (!s || known.has(s.id) || releaseAt(s) > nowSec) continue;
    released.push({ id: s.id, releasedAt: nowSec });
    known.add(s.id); addedCandidates++;
    stmts.push(env.DB.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)').bind(nowSec, 'stage', s.id, `🧪 사전 등록 후보 ${s.name} 공개 — 과거 검증(시도 수 보정) 통과, 오늘부터 가상 돈 모의 검증 시작`));
  }
  if (addedCandidates) stmts.push(kvSetStmt(env.DB, 'candidates:released', released));
  if (body?.candidateStatus && typeof body.candidateStatus === 'object') {
    const st = {};
    for (const [id, v] of Object.entries(body.candidateStatus).slice(0, 20)) if (candidateById[id]) st[id] = { status: String(v?.status || '').slice(0, 20), note: String(v?.note || '').slice(0, 200), at: Number(v?.at) | 0 };
    stmts.push(kvSetStmt(env.DB, 'candidates:status', st));
  }
  const variants = Array.isArray(kv.variants) ? kv.variants : [];
  let addedVariants = 0;
  for (const v of (body?.variants || []).slice(0, 4)) {
    const b = staticById[v.base];
    if (!b || b.benchmarkOnly || typeof v.params !== 'object' || known.has(v.id) || v.id !== `${b.family}_v${v.version}`) continue;
    variants.push({ id: v.id, base: v.base, version: v.version | 0, params: v.params, trials: v.trials | 0, registeredAt: Math.floor(Date.now() / 1000), note: String(v.note || '').slice(0, 200) });
    known.add(v.id); addedVariants++;
    stmts.push(env.DB.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)').bind(Math.floor(Date.now() / 1000), 'stage', v.id, `🧪 자동 연구가 새 변형 ${v.id} 을(를) 찾아 모의 검증 파이프라인에 등록 (시도 ${v.trials}번 보정 후 통과)`));
  }
  if (addedVariants) stmts.push(kvSetStmt(env.DB, 'variants', variants.slice(-MAX_ACTIVE_VARIANTS)));
  if (body?.trials && typeof body.trials === 'object') {
    const t = { ...(kv['research:trials'] || {}) };
    for (const [f, n] of Object.entries(body.trials)) t[f] = Math.max(t[f] || 0, n | 0); // trial counts only ever grow
    stmts.push(kvSetStmt(env.DB, 'research:trials', t));
  }
  // 레버리지 배수 비교(모의 전용 선물 시뮬레이션) 표: 숫자·짧은 문자열만, 최대 40줄
  if (body?.leverage && Array.isArray(body.leverage.rows)) {
    const num = (x) => (Number.isFinite(+x) ? +x : null);
    const rows = body.leverage.rows.slice(0, 40).map((r) => ({ label: String(r.label || '').slice(0, 60), lev: num(r.lev), account: num(r.account), stop: !!r.stop, funding: num(r.funding),
      period: String(r.period || '').slice(0, 20), totalReturn: num(r.totalReturn), cagr: num(r.cagr), mdd: num(r.mdd), liquidations: num(r.liquidations), entries: num(r.entries), skipped: num(r.skipped), costShare: num(r.costShare) }));
    stmts.push(kvSetStmt(env.DB, 'research:leverage', { generatedAt: Number(body.generatedAt) | 0, range: String(body.leverage.range || '').slice(0, 40), note: String(body.leverage.note || '').slice(0, 300), rows }));
  }
  let bt = 0;
  for (const r of (body?.backtests || []).slice(0, 60)) {
    if (!known.has(r.strategy_id) || !['wf', 'grid'].includes(r.kind)) continue;
    stmts.push(backtestStmt(env.DB, r.strategy_id, r.kind, String(r.source || 'research'), r.summary, r.curve || null)); bt++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, backtests: bt, variants: addedVariants, candidates: addedCandidates };
}

