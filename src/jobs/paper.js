// Forward paper ledger + in-worker chunked backtest. Both use core/engine.stepBar().
import { Feed, createState, stepBar, timelineOf } from '../core/engine.js';
import { buildOpts } from '../core/backtest.js';
import { computeMetrics, riskMatched } from '../core/metrics.js';
import { DAY, HOUR } from '../core/calendar.js';
import { getRuns, loadSeries, runUpsertStmt, fillStmts, equityStmts, eventStmt, equityPoints, fillsOf, backtestStmt, downsample, kvSetStmt } from '../db/store.js';
import { activeStrategies } from '../strategies/index.js';
import { cryptoUniverse } from './collect.js';
import { aiConfigured } from './ai.js';
import { guardFor } from './market-signals.js';
import { kstAt } from '../core/calendar.js';
import { INITIAL_CASH, krxMeta, RULES_20261118_FROM } from '../config.js';
import { mergeCosts } from '../core/costs.js';

export function universeFor(strategy, kv) {
  return strategy.dynamicUniverse ? cryptoUniverse(kv) : strategy.universe;
}
const barSec = (tf) => (tf === '1h' ? HOUR : DAY);
const span = (s) => Math.ceil((s.lookback || 100) * barSec(s.timeframe) * (s.market === 'krx' ? 1.6 : 1.05)) + 5 * DAY;

const barClose = (s, t) => (s.timeframe === '1h' ? t + HOUR : s.market === 'krx' ? kstAt(t, 15, 30) : t + DAY);

/** Per-bar signal view (as of the bar's close, max 2 days old) for overlay strategies. Paper mode only. */
export async function signalsFor(env, strategy, from, toT) {
  if (!strategy.overlayOf && !strategy.usesSignals) return undefined;
  const { results } = await env.DB.prepare("SELECT sym, t, kind, value, note FROM signals WHERE t >= ? AND t <= ? AND kind IN ('news_veto', 'ai_score', 'ai_score_disc', 'ai_score_nl') ORDER BY t")
    .bind(from - 3 * DAY, barClose(strategy, toT)).all();
  const vetoRequired = String(env.NEWS_VETO_PROVIDER || 'none') !== 'none';
  const aiRequired = aiConfigured(env);
  return (t) => {
    const close = barClose(strategy, t);
    const fresh = results.filter((r) => r.t <= close && r.t > close - 2 * DAY);
    const out = { vetoRequired, aiRequired, ai: {}, aiDisc: {}, aiNl: {} };
    for (const r of fresh) {
      if (r.kind === 'news_veto' && r.sym === `*${strategy.market}`) out.veto = { value: r.value, note: r.note };
      if (r.kind === 'ai_score') out.ai[r.sym] = { score: r.value, reason: r.note };
      if (r.kind === 'ai_score_disc') out.aiDisc[r.sym] = { score: r.value, reason: r.note };
      if (r.kind === 'ai_score_nl') out.aiNl[r.sym] = { score: r.value, reason: r.note };
    }
    return out;
  };
}

/** Advance one run by up to maxBars bars. Returns {run, fills, points, events} (not yet persisted). */
export async function advanceRun(env, kv, strategy, run, toT, maxBars, { windowFrom = null } = {}) {
  const universe = universeFor(strategy, kv);
  const from = Math.max(run.last_t ?? -Infinity, run.start_after ?? -Infinity);
  const signals = run.mode === 'paper' ? await signalsFor(env, strategy, from, toT) : undefined;
  const guard = run.mode === 'paper' ? await guardFor(env, strategy, from, toT) : undefined; // 코인 시장 신호 (paper only)
  // 모의 장부: 2026-11-18 묶음(ETF 매매차익 세금)은 RULES_20261118_FROM 봉부터 (이전 저장 체결은 옛 규칙으로 1:1 재생)
  const costs = run.mode === 'paper' ? { ...mergeCosts(strategy.market), gainTaxFrom: RULES_20261118_FROM } : undefined;
  const opts = buildOpts(strategy, { universe, meta: strategy.market === 'krx' ? krxMeta : {}, signals, guard, costs });
  const syms = [...new Set([...universe, ...Object.keys(run.state.kind === 'futures' ? {} : run.state.pos || {}), strategy.benchSym].filter(Boolean))];
  const series = await loadSeries(env.DB, strategy.market, strategy.timeframe, syms, from - span(strategy), Math.min(toT, Math.max(from, windowFrom ?? from) + (maxBars + 3) * barSec(strategy.timeframe) * (strategy.market === 'krx' ? 3 : 1.2)));
  const feed = new Feed(series);
  const benchSeries = strategy.benchSym && series[strategy.benchSym]?.length ? [strategy.benchSym] : syms;
  const tl = timelineOf(series, benchSeries).filter((t) => t > from && t <= toT).slice(0, maxBars);
  const fills = [], points = [], events = [];
  for (const t of tl) {
    const r = (strategy.stepper || stepBar)(run.state, t, feed, opts);
    r.fills.forEach((f, i) => fills.push({ ...f, seq: i }));
    points.push(r.point);
    for (const e of r.events) events.push({ ...e, strategy_id: strategy.id });
  }
  if (tl.length) run.last_t = tl[tl.length - 1];
  return { run, fills, points, events, processed: tl.length };
}

export async function paperTask(env, kv, now, { maxSteps = 2, strategies = activeStrategies(kv).filter((x) => !x.external) } = {}) {
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const changed = [];
  const cands = strategies.map((s) => ({ s, run: runs[`${s.id}:paper`], ready: kv[`ready:${s.market}:${s.timeframe}`] }))
    .filter((x) => x.ready)
    .sort((a, b) => (a.run?.last_t ?? 0) - (b.run?.last_t ?? 0));
  const newRuns = [];
  for (const { s, run, ready } of cands) {
    if (!run) {
      // forward-only: the paper ledger starts with the first bar AFTER it was created
      const st0 = (s.createState || createState)(INITIAL_CASH);
      newRuns.push(runUpsertStmt(env.DB, { id: `${s.id}:paper`, strategy_id: s.id, mode: 'paper', state: st0, start_after: ready, last_t: null }));
      newRuns.push(eventStmt(env.DB, { t: now, kind: 'start', strategy_id: s.id, message: `${s.name}: 가상 계좌 ${Number(st0.initialCash).toLocaleString('ko-KR')}원으로 모의투자 시작` }));
      continue;
    }
    if (changed.length >= maxSteps) continue;
    const from = Math.max(run.last_t ?? -Infinity, run.start_after ?? -Infinity);
    if (from >= ready) continue;
    const steps = s.timeframe === '1h' ? 6 : 3;
    let r = await advanceRun(env, kv, s, run, ready, steps);
    if (!r.processed) {
      // B18: an empty short window is NOT proof that nothing exists up to `ready` — jump to the next real bar
      const syms = [...new Set([s.benchSym, ...universeFor(s, kv)].filter(Boolean))];
      const next = await env.DB.prepare(`SELECT MIN(t) AS t FROM candles WHERE market = ? AND tf = ? AND sym IN (${syms.map(() => '?').join(',')}) AND t > ? AND t <= ?`)
        .bind(s.market, s.timeframe, ...syms, from, ready).first();
      if (next?.t != null) r = await advanceRun(env, kv, s, run, ready, steps, { windowFrom: next.t - barSec(s.timeframe) });
    }
    const stmts = [runUpsertStmt(env.DB, r.run), ...fillStmts(env.DB, run.id, r.fills), ...equityStmts(env.DB, run.id, r.points), ...r.events.map((e) => eventStmt(env.DB, e))];
    if (!r.processed) { // truly no bar up to `ready`: skip ahead
      run.last_t = ready;
      stmts[0] = runUpsertStmt(env.DB, run);
    }
    await env.DB.batch(stmts);
    changed.push(s.id);
  }
  if (newRuns.length) await env.DB.batch(newRuns);
  return changed;
}

/** Weekly re-run of each strategy over all stored history, in small chunks (default params). */
export async function workerBacktestTask(env, kv, now, { strategies = activeStrategies(kv).filter((x) => !x.external && !x.noBacktest) } = {}) {
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  for (const s of strategies) {
    const id = `${s.id}:bt`;
    const ready = kv[`ready:${s.market}:${s.timeframe}`];
    const cov = kv[`cov:${s.market}:${s.timeframe}`]?.[s.benchSym || s.universe[0]];
    if (!ready || !cov) continue;
    let run = runs[id];
    if (run && run.state.done && run.state.doneAt > now - 7 * DAY) continue;
    if (!run || run.state.done) {
      const st = (s.createState || createState)(INITIAL_CASH);
      const startAfter = cov.min + (s.lookback || 100) * barSec(s.timeframe) * (s.market === 'krx' ? 1.5 : 1);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM equity WHERE run_id = ?').bind(id),
        env.DB.prepare('DELETE FROM fills WHERE run_id = ?').bind(id),
        runUpsertStmt(env.DB, { id, strategy_id: s.id, mode: 'bt', state: st, start_after: startAfter, last_t: null }),
      ]);
      return { started: s.id };
    }
    const r = await advanceRun(env, kv, s, run, ready, s.timeframe === '1h' ? 100 : 30);
    const finished = !r.processed || (r.run.last_t >= ready);
    if (finished) { r.run.state.done = true; r.run.state.doneAt = now; }
    await env.DB.batch([runUpsertStmt(env.DB, r.run), ...fillStmts(env.DB, id, r.fills), ...equityStmts(env.DB, id, r.points)]);
    if (finished) {
      const pts = await equityPoints(env.DB, id);
      const fl = await fillsOf(env.DB, id, 0, 100000);
      const k = Math.floor(pts.length * 0.7);
      const cut = pts[k]?.t ?? Infinity;
      const opt = { market: s.market, tf: s.timeframe };
      const summary = { params: s.params, full: computeMetrics(pts, fl, opt), oos: computeMetrics(pts.slice(k), fl.filter((f) => f.t >= cut), opt), note: '워커 자체 재검증(기본 파라미터, 마지막 30% 구간을 표본 외로 사용)' };
      // risk-matched baseline for the G1 gate: benchmark price path = the stored bench curve; cash part = 단기채권(국내) or cash(코인)
      try {
        const oosPts = pts.slice(k);
        const benchPx = oosPts.map((p) => ({ t: p.t, c: p.bench }));
        const bond = s.market === 'krx' ? (await loadSeries(env.DB, 'krx', '1d', ['153130'], oosPts[0]?.t ?? 0, oosPts[oosPts.length - 1]?.t ?? 0))['153130'] : null;
        summary.oos.riskMatched = riskMatched(oosPts, benchPx, bond?.length ? bond : null, opt);
      } catch (_) {}
      await env.DB.batch([backtestStmt(env.DB, s.id, 'worker', 'worker', summary, downsample(pts.map((p) => ({ t: p.t, e: Math.round(p.equity), b: Math.round(p.bench) })), 200))]);
    }
    return { advanced: s.id, finished };
  }
  return null;
}

export { kvSetStmt };
