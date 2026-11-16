import test from 'node:test';
import assert from 'node:assert/strict';
import { Feed, createState, stepBar } from '../src/core/engine.js';
import { buildOpts, runBacktest, walkForward, splitTest } from '../src/core/backtest.js';
import { DEFAULT_COSTS } from '../src/core/costs.js';
import { makeBars } from './helpers.mjs';

const allIn = (sym, w = 0.5) => ({ id: 'x_v1', family: 'x', version: 1, market: 'krx', timeframe: '1d', universe: [sym], benchSym: sym, params: {},
  decide: (ctx) => (ctx.barIndex === 0 ? { targets: { [sym]: w }, reasons: { [sym]: 'test buy' } } : null) });

test('ledger: decision at close, fill at NEXT bar open with slippage, fees and tick rounding', () => {
  const bars = [{ t: 1, o: 10000, h: 10100, l: 9900, c: 10000, v: 1 }, { t: 2, o: 10200, h: 10300, l: 10100, c: 10250, v: 1 }];
  const s = allIn('AAA');
  const opts = buildOpts(s, { risk: { minCash: 0, maxPositionWeight: 1 }, meta: {} });
  const feed = new Feed({ AAA: bars });
  const st = createState(1_000_000);
  const r1 = stepBar(st, 1, feed, opts);
  assert.equal(r1.fills.length, 0);
  assert.equal(st.pending.length, 1);
  assert.equal(st.pending[0].qty, 50); // 0.5 * 1,000,000 / 10,000 at decision close
  const r2 = stepBar(st, 2, feed, opts);
  const f = r2.fills[0];
  assert.equal(f.side, 'BUY');
  assert.equal(f.price, 10210); // 10200*1.0005 = 10205.1 -> tick 10 up
  assert.equal(f.fee, Math.round(50 * 10210 * 0.00015));
  assert.equal(st.cash, 1_000_000 - 50 * 10210 - f.fee);
  // accounting identity: equity = cash + qty * close
  assert.ok(Math.abs(st.equity - (st.cash + 50 * 10250)) < 1e-6);
});

test('ledger: sell realises pnl net of commission and 0.20% stock tax; ETF exempt', () => {
  for (const etf of [false, true]) {
    const bars = [1, 2, 3, 4].map((t) => ({ t, o: 10000 + t * 100, h: 20000, l: 9000, c: 10000 + t * 100, v: 1 }));
    const strat = { id: 'y_v1', family: 'y', version: 1, market: 'krx', timeframe: '1d', universe: ['S'], benchSym: 'S', params: {},
      decide: (ctx) => (ctx.barIndex === 0 ? { targets: { S: 0.5 } } : ctx.barIndex === 2 ? { targets: {}, reasons: { S: 'exit' } } : null) };
    const r = runBacktest({ strategy: strat, series: { S: bars }, meta: { S: { etf } }, risk: { minCash: 0 } });
    const sell = r.fills.find((f) => f.side === 'SELL');
    assert.equal(sell.tax, etf ? 0 : Math.floor(sell.gross * 0.002));
    assert.equal(sell.reason, 'exit');
    const buy = r.fills[0];
    assert.ok(Math.abs(sell.pnl - (sell.gross - sell.fee - sell.tax - (buy.gross + buy.fee))) < 1e-6);
  }
});

test('no lookahead: strategy only ever sees bars up to the current bar', () => {
  const bars = makeBars({ n: 50 });
  const seen = [];
  const s = { id: 'z_v1', family: 'z', version: 1, market: 'crypto', timeframe: '1d', universe: ['A'], benchSym: 'A', params: {},
    decide: (ctx) => { const h = ctx.history('A', 1000); seen.push(h[h.length - 1].t === ctx.t && h.every((b) => b.t <= ctx.t)); return null; } };
  runBacktest({ strategy: s, series: { A: bars } });
  assert.ok(seen.length === 50 && seen.every(Boolean));
});

test('pending order on a symbol without a bar is retried then cancelled', () => {
  const s = allIn('B');
  const series = { A: [1, 2, 3, 4, 5].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 })), B: [{ t: 1, o: 100, h: 100, l: 100, c: 100, v: 1 }] };
  const s2 = { ...s, benchSym: 'A' };
  const r = runBacktest({ strategy: s2, series, risk: { minCash: 0 } });
  assert.equal(r.fills.length, 0);
  assert.ok(r.events.some((e) => e.kind === 'order_cancel'));
});

test('max-drawdown halt liquidates, then resumes paper after cooldown', () => {
  const prices = [100, 100, 100, 70, 60, 60, 60, 60, 60, 60, 60, 60, 60];
  const bars = prices.map((p, i) => ({ t: (i + 1) * 86400, o: p, h: p, l: p, c: p, v: 1 }));
  const s = { id: 'h_v1', family: 'h', version: 1, market: 'crypto', timeframe: '1d', universe: ['A'], benchSym: 'A', params: {}, decide: () => ({ targets: { A: 0.9 } }) };
  const r = runBacktest({ strategy: s, series: { A: bars }, risk: { minCash: 0, maxPositionWeight: 1, maxDrawdownHalt: 0.2, haltCooldownBars: 3, dailyLossLimit: 0, weeklyLossLimit: 0 } });
  assert.ok(r.events.some((e) => e.kind === 'halt'));
  const sells = r.fills.filter((f) => f.side === 'SELL');
  assert.ok(sells.some((f) => f.reason.includes('최대 손실폭')));
  assert.ok(r.events.some((e) => e.kind === 'resume'));
  assert.equal(r.state.halts, 1);
});

test('daily loss limit blocks new buys for that bar', () => {
  const prices = [100, 100, 95, 95];
  const bars = prices.map((p, i) => ({ t: (i + 1) * 86400, o: p, h: p, l: p, c: p, v: 1 }));
  let i = 0;
  const s = { id: 'd_v1', family: 'd', version: 1, market: 'crypto', timeframe: '1d', universe: ['A', 'B'], benchSym: 'A', params: {},
    decide: (ctx) => { i++; return ctx.barIndex === 0 ? { targets: { A: 0.9 } } : ctx.barIndex === 2 ? { targets: { A: 0.9, B: 0.05 } } : null; } };
  const r = runBacktest({ strategy: s, series: { A: bars, B: bars }, risk: { minCash: 0, maxPositionWeight: 1, dailyLossLimit: 0.02, rebalanceBand: 0.001 } });
  assert.ok(r.events.some((e) => e.kind === 'daily_loss'));
  assert.ok(!r.fills.some((f) => f.sym === 'B'));
});

test('walk-forward picks params in-sample and reports chained out-of-sample metrics; split works', () => {
  const bars = makeBars({ n: 900, drift: 0.0006 });
  const s = { id: 'w_v1', family: 'w', version: 1, market: 'crypto', timeframe: '1d', universe: ['A'], benchSym: 'A', lookback: 30, params: { n: 10 }, grid: { n: [5, 20] },
    decide: (ctx) => { const c = ctx.closes('A', ctx.params.n + 1); if (c.length < ctx.params.n + 1) return null; return { targets: c[c.length - 1] > c[0] ? { A: 0.5 } : {} }; } };
  const wf = walkForward({ strategy: s, series: { A: bars }, trainBars: 300, testBars: 200 });
  assert.ok(wf.folds.length >= 2);
  assert.equal(wf.variants, 2);
  assert.ok(wf.folds.every((f) => f.testFrom > f.trainTo));
  assert.ok(wf.oos.bars > 300);
  const sp = splitTest({ strategy: s, series: { A: bars } }, 0.7);
  assert.ok(sp.outOfSample.bars > 200 && sp.inSample.bars > 500);
});
