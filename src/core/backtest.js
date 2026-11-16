// Backtest runner over in-memory series. Uses the exact same stepBar() as live paper.
import { Feed, createState, stepBar, timelineOf } from './engine.js';
import { computeMetrics, chainSegments } from './metrics.js';
import { mergeCosts } from './costs.js';
import { mergeRisk } from './risk.js';

export function strategySyms(strategy, universe) {
  const u = universe || strategy.universe;
  return [...new Set([...u, strategy.benchSym].filter(Boolean))];
}

export function buildOpts(strategy, { params, universe, costs, risk, meta, signals, guard } = {}) {
  return {
    strategy,
    params: { ...strategy.params, ...(params || {}) },
    universe: universe || strategy.universe,
    benchSym: strategy.benchSym,
    costs: costs || mergeCosts(strategy.market),
    risk: mergeRisk(strategy.risk, risk),
    meta: meta || {},
    signals,
    guard, // paper ledgers only (jobs/market-signals.js guardFor); backtests leave it undefined
  };
}

/**
 * @param {object} a {strategy, series:{sym:bars[]}, params, fromT, toT, initialCash, universe, costs, risk, meta}
 */
export function runBacktest(a) {
  const { strategy, series } = a;
  const opts = buildOpts(strategy, a);
  const syms = strategySyms(strategy, opts.universe).filter((s) => series[s]);
  const sub = Object.fromEntries(syms.map((s) => [s, series[s]]));
  const feed = new Feed(sub);
  const tl = (a.timeline || timelineOf(sub, opts.benchSym && sub[opts.benchSym] ? [opts.benchSym] : syms))
    .filter((t) => (a.fromT == null || t >= a.fromT) && (a.toT == null || t <= a.toT));
  const state = (strategy.createState || createState)(a.initialCash || 10_000_000);
  const step = strategy.stepper || stepBar;
  const points = [], fills = [], events = [];
  for (const t of tl) {
    const r = step(state, t, feed, opts);
    points.push(r.point);
    for (const f of r.fills) fills.push(f);
    for (const e of r.events) events.push(e);
  }
  const metrics = computeMetrics(points, fills, { market: strategy.market, tf: strategy.timeframe });
  return { points, fills, events, state, metrics, params: opts.params };
}

export function gridVariants(grid) {
  if (!grid) return [{}];
  let out = [{}];
  for (const [k, vals] of Object.entries(grid)) {
    const next = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next;
  }
  return out;
}

const score = (m) => m.sharpe;

/**
 * Anchored walk-forward: for each fold, pick the best params on [start, trainEnd] (in-sample),
 * then trade them on the next `testBars` bars starting from fresh capital (out-of-sample).
 * Warm-up data before each window is always available to indicators (no lookahead: only past bars).
 */
export function walkForward(a) {
  const { strategy, series } = a;
  const syms = strategySyms(strategy, a.universe).filter((s) => series[s]);
  const sub = Object.fromEntries(syms.map((s) => [s, series[s]]));
  const bench = strategy.benchSym && sub[strategy.benchSym] ? [strategy.benchSym] : syms;
  const tl = timelineOf(sub, bench).filter((t) => a.fromT == null || t >= a.fromT);
  const warm = strategy.lookback || 100;
  const trainBars = a.trainBars, testBars = a.testBars;
  const variants = gridVariants(a.grid === undefined ? strategy.grid : a.grid);
  const folds = [];
  for (let start = warm + trainBars; start < tl.length; start += testBars) {
    const trainFrom = tl[a.anchored === false ? start - trainBars : warm];
    const trainTo = tl[start - 1];
    const testFrom = tl[start];
    const testTo = tl[Math.min(tl.length - 1, start + testBars - 1)];
    let best = null;
    for (const v of variants) {
      const r = runBacktest({ ...a, params: v, fromT: trainFrom, toT: trainTo, timeline: tl });
      if (!best || score(r.metrics) > score(best.metrics)) best = { params: v, metrics: r.metrics };
    }
    const test = runBacktest({ ...a, params: best.params, fromT: testFrom, toT: testTo, timeline: tl });
    folds.push({ trainFrom, trainTo, testFrom, testTo, params: best.params, train: best.metrics, test: test.metrics, points: test.points, fills: test.fills });
  }
  const oosPoints = chainSegments(folds.map((f) => f.points), a.initialCash || 10_000_000);
  const oosFills = folds.flatMap((f) => f.fills);
  const oos = computeMetrics(oosPoints, oosFills, { market: strategy.market, tf: strategy.timeframe });
  return { folds: folds.map(({ points, fills, ...f }) => f), oos, oosPoints, variants: variants.length };
}

/** Simple chronological split: first `frac` in-sample, rest out-of-sample (same params). */
export function splitTest(a, frac = 0.7) {
  const full = runBacktest(a);
  const k = Math.floor(full.points.length * frac);
  const isPts = full.points.slice(0, k), oosPts = full.points.slice(k);
  const cut = oosPts[0]?.t ?? Infinity;
  return {
    full: full.metrics,
    inSample: computeMetrics(isPts, full.fills.filter((f) => f.t < cut), { market: a.strategy.market, tf: a.strategy.timeframe }),
    outOfSample: computeMetrics(oosPts, full.fills.filter((f) => f.t >= cut), { market: a.strategy.market, tf: a.strategy.timeframe }),
  };
}
