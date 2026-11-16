import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStage, applySupersession, GATE_DEFAULTS, mergeGates } from '../src/core/lifecycle.js';
import { liveKillSwitch, nextLiveBudget, initialLiveBudget, accountGuard } from '../src/core/live-policy.js';
import { allocate } from '../src/core/allocator.js';
import { deflatedSharpe, psr, normInv, normCdf } from '../src/core/stats.js';
import { trialsFor, STRATEGIES, byId } from '../src/strategies/index.js';
import { rng } from './helpers.mjs';

const goodBt = { holdout: { totalReturn: 0.2, mdd: 0.1, sharpe: 1.1, trades: 40, bench: { totalReturn: 0.25, mdd: 0.3, sharpe: 0.8 } }, holdout2x: { totalReturn: 0.15 }, years: 12, totalTrades: 140, dsr: 0.95, trials: 3 };
const goodPaper = { days: 30, bars: 25, trades: 25, decisions: 25, mdd: 0.03, totalReturn: 0.01, halted: false, agreement: { matched: 5, total: 5 } };
const fast = { id: 'f_v1', market: 'crypto', cadence: 'fast' };
const slowKrx = { id: 's_v1', market: 'krx', cadence: 'slow' };

test('stages: benchmark / backtest / bt_failed / paper / live_candidate', () => {
  assert.equal(evaluateStage({ strategy: { ...fast, benchmarkOnly: true } }).stage, 'benchmark');
  assert.equal(evaluateStage({ strategy: fast, bt: null, paper: goodPaper }).stage, 'backtest');
  assert.equal(evaluateStage({ strategy: fast, bt: { ...goodBt, holdout2x: { totalReturn: -0.01 } }, paper: goodPaper }).stage, 'bt_failed');
  assert.equal(evaluateStage({ strategy: fast, bt: goodBt, paper: { ...goodPaper, days: 5 } }).stage, 'paper');
  assert.equal(evaluateStage({ strategy: fast, bt: goodBt, paper: { ...goodPaper, trades: 19 } }).stage, 'paper');
  const ok = evaluateStage({ strategy: fast, bt: goodBt, paper: goodPaper });
  assert.equal(ok.stage, 'live_candidate');
  assert.equal(ok.label, '실거래 가능(소액)');
  assert.ok(ok.checks.every((c) => c.ok));
});

test('beating benchmark is risk-adjusted by default; total-return beat is configurable', () => {
  // goodBt holdout return 20% < benchmark 25%, but lower MDD & higher Sharpe -> passes by default
  assert.equal(evaluateStage({ strategy: fast, bt: goodBt, paper: goodPaper }).stage, 'live_candidate');
  const strict = mergeGates({ backtest: { mustBeatBenchmarkReturn: true } });
  assert.equal(evaluateStage({ strategy: fast, bt: goodBt, paper: goodPaper, gates: strict }).stage, 'bt_failed');
  // MDD must be <= 70% of benchmark MDD
  assert.equal(evaluateStage({ strategy: fast, bt: { ...goodBt, holdout: { ...goodBt.holdout, mdd: 0.25 } }, paper: goodPaper }).stage, 'bt_failed');
});

test('slow strategies: 30 trades + 10 years, paper needs decisions + 100% signal agreement', () => {
  const bt = { ...goodBt, totalTrades: 35 };
  const p = { ...goodPaper, trades: 0 };
  assert.equal(evaluateStage({ strategy: slowKrx, bt, paper: p }).stage, 'live_candidate');
  assert.equal(evaluateStage({ strategy: slowKrx, bt: { ...bt, years: 6 }, paper: p }).stage, 'bt_failed');
  assert.equal(evaluateStage({ strategy: slowKrx, bt, paper: { ...p, agreement: { matched: 4, total: 5 } } }).stage, 'paper');
  assert.equal(evaluateStage({ strategy: slowKrx, bt, paper: { ...p, bars: 19, decisions: 19 } }).stage, 'paper');
});

test('research-only and halted/killed strategies never become live candidates', () => {
  assert.equal(evaluateStage({ strategy: { ...fast, researchOnly: true }, bt: goodBt, paper: goodPaper }).stage, 'paper');
  assert.equal(evaluateStage({ strategy: fast, bt: goodBt, paper: { ...goodPaper, halted: true } }).stage, 'halted');
  const k = evaluateStage({ strategy: fast, bt: goodBt, paper: goodPaper, kill: { kill: true, reason: 'x' } });
  assert.equal(k.stage, 'halted');
  assert.ok(k.summary.includes('모의로 복귀'));
});

test('supersession: newer version at same stage with >= Sharpe retires the older one', () => {
  const rows = applySupersession([
    { id: 'a_v1', family: 'a', version: 1, stage: 'paper', btSharpe: 0.8 },
    { id: 'a_v2', family: 'a', version: 2, stage: 'paper', btSharpe: 0.9 },
    { id: 'b_v1', family: 'b', version: 1, stage: 'live_candidate', btSharpe: 1 },
    { id: 'b_v2', family: 'b', version: 2, stage: 'paper', btSharpe: 2 },
  ]);
  assert.equal(rows[0].stage, 'retired');
  assert.equal(rows[2].stage, 'live_candidate');
});

test('multiple-testing penalty: deflated Sharpe falls as trials grow; trial counter per family', () => {
  const r = rng(5);
  const ret = Array.from({ length: 750 }, () => 0.0006 + (r() - 0.5) * 0.02);
  const d1 = deflatedSharpe(ret, 1), d10 = deflatedSharpe(ret, 10), d100 = deflatedSharpe(ret, 100);
  assert.ok(d1 > d10 && d10 > d100, `${d1} ${d10} ${d100}`);
  assert.ok(Math.abs(normCdf(normInv(0.975)) - 0.975) < 1e-4);
  assert.ok(psr(ret, 0) > 0.5);
  assert.equal(trialsFor(byId.crypto_trend_v1), 20 + 1); // 20 rejected earlier attempts + this pre-registered v1
  assert.equal(trialsFor(byId.krx_trend_v1), 24); // grid 3x2x2x2x1
});

test('kill switch: drawdown limit, consecutive losses, drift; budget step-up; account guard', () => {
  const pts = [100, 95, 92, 89].map((e, i) => ({ t: i * 86400, equity: e }));
  assert.equal(liveKillSwitch(pts, [], { market: 'krx' }).kill, true); // -11% > 10%
  assert.equal(liveKillSwitch(pts, [], { market: 'crypto' }).kill, false); // < 15%
  assert.equal(liveKillSwitch(pts.slice(0, 2), [], { market: 'crypto', backtestMdd: 0.03 }).kill, true); // 1.5x of 3% = 4.5%
  const losses = Array.from({ length: 8 }, () => ({ side: 'SELL', pnl: -1 }));
  assert.equal(liveKillSwitch([], losses, { market: 'crypto' }).kill, true);
  assert.equal(liveKillSwitch([], [], { market: 'crypto', driftPct: 0.03 }).kill, true);
  assert.deepEqual(initialLiveBudget('crypto', 40000), { krw: 10000, step: 0, status: 'eligible' });
  assert.equal(nextLiveBudget({ market: 'crypto', krw: 20000, step: 0, liveWeeks: 4, driftPerMonth: 0.005, atNewHigh: true }).krw, 40000);
  assert.equal(nextLiveBudget({ market: 'crypto', krw: 20000, step: 0, liveWeeks: 4, atNewHigh: false }).krw, 20000);
  assert.equal(nextLiveBudget({ market: 'krx', krw: 30000, step: 0, killed: true }).krw, 0);
  const day = (d, e) => ({ t: d * 86400, equity: e });
  assert.equal(accountGuard([day(10, 100), day(11, 97.9)]).blockBuys, true);
  assert.equal(accountGuard([day(10, 100), day(11, 91)]).stopAll, true);
});

test('meta-allocator: only eligible strategies, caps, baseline floor, hysteresis', () => {
  const r = rng(2);
  const mk = (mu) => Array.from({ length: 90 }, () => mu + (r() - 0.5) * 0.01);
  const cands = [
    { id: 'a', stage: 'live_candidate', dailyReturns: mk(0.002) },
    { id: 'b', stage: 'live_candidate', dailyReturns: mk(0.001) },
    { id: 'c', stage: 'paper', dailyReturns: mk(0.01) },
    { id: 'd', stage: 'live_candidate', dailyReturns: mk(0.002).slice(0, 30) },
    { id: 'base', benchmarkOnly: true },
  ];
  const a1 = allocate(cands, null, 1_000_000);
  assert.ok(!a1.weights.c && !a1.weights.d);
  assert.ok(a1.weights.a <= 0.10 + 1e-9 && a1.weights.b <= 0.10 + 1e-9); // max step from 0
  assert.ok(Math.abs(Object.values(a1.weights).reduce((x, y) => x + y, 0) - 1) < 1e-3);
  const same = allocate(cands, a1, 1_000_000 + 86400);
  assert.equal(same.changed, false);
  let a = a1;
  for (let i = 1; i < 10; i++) a = allocate(cands, a, 1_000_000 + i * 8 * 86400);
  assert.ok(a.weights.a <= 0.40 + 1e-9);
  assert.ok(a.weights.base >= 0.20 - 1e-9);
});
