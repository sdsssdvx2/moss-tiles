import test from 'node:test';
import assert from 'node:assert/strict';
import { SMA, EMA, RSI, ATR } from 'trading-signals';
import { sma, ema, rsi, atr, highestPrior, lowestPrior, roc, crossedAbove } from '../src/core/indicators.js';
import { krxTick, upbitTick, fillPrice, feesFor, affordableQty, DEFAULT_COSTS, roundQty, stressCosts } from '../src/core/costs.js';
import { applyRisk, mergeRisk } from '../src/core/risk.js';
import { computeMetrics, maxDrawdown, cagr } from '../src/core/metrics.js';
import { isKrxBusinessDay, dayT, latestFinalKrxDay, latestFinalCryptoDay, kstAt } from '../src/core/calendar.js';
import { makeBars } from './helpers.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('indicators match trading-signals (MIT) as an independent oracle', () => {
  const bars = makeBars({ n: 300, seed: 3 });
  const c = bars.map((b) => b.c);
  const S = new SMA(20), E = new EMA(12), R = new RSI(14), A = new ATR(14);
  for (const b of bars) { S.add(b.c); E.add(b.c); R.add(b.c); A.add({ high: b.h, low: b.l, close: b.c }); }
  close(sma(c, 20), Number(S.getResult()));
  close(ema(c, 12), Number(E.getResult()), 1e-6);
  close(rsi(c, 14), Number(R.getResult()), 1e-6);
  close(atr(bars, 14), Number(A.getResult()), 1e-6);
});

test('donchian/roc/cross helpers exclude the current bar where documented', () => {
  const v = [1, 5, 3, 2, 9];
  assert.equal(highestPrior(v, 3), 5);
  assert.equal(lowestPrior(v, 3), 2);
  assert.equal(roc(v, 4), 8);
  assert.ok(crossedAbove([1, 3], [2, 2]));
  assert.ok(Number.isNaN(sma([1, 2], 3)));
});

test('KRX tick sizes and fill rounding go against the trader', () => {
  assert.equal(krxTick(1999, false), 1);
  assert.equal(krxTick(49999, false), 50);
  assert.equal(krxTick(250000, false), 500);
  assert.equal(krxTick(84540, true), 5);
  const c = DEFAULT_COSTS.krx;
  const buy = fillPrice('BUY', 84540, c, { etf: true });
  const sell = fillPrice('SELL', 84540, c, { etf: true });
  assert.ok(buy >= 84540 * 1.0005 && buy % 5 === 0);
  assert.ok(sell <= 84540 * 0.9995 && sell % 5 === 0);
  assert.equal(fillPrice('BUY', 219000, c, {}) % 500, 0);
});

test('Upbit tick table and decimals', () => {
  assert.equal(upbitTick(89_000_000), 1000);
  assert.equal(upbitTick(3200), 1);
  assert.equal(upbitTick(0.5), 0.001);
  const p = fillPrice('BUY', 89_000_000, DEFAULT_COSTS.crypto);
  assert.equal(p % 1000, 0);
  assert.equal(roundQty(0.123456789, DEFAULT_COSTS.crypto), 0.12345678);
});

test('fees: KRX commission both ways, stock sell tax 0.20%, ETF configurable (default exempt), Upbit 0.05%', () => {
  const k = DEFAULT_COSTS.krx;
  assert.deepEqual(feesFor('BUY', 1_000_000, k, {}), { fee: 150, tax: 0 });
  assert.deepEqual(feesFor('SELL', 1_000_000, k, {}), { fee: 150, tax: 2000 });
  assert.deepEqual(feesFor('SELL', 1_000_000, k, { etf: true }), { fee: 150, tax: 0 });
  assert.deepEqual(feesFor('SELL', 1_000_000, { ...k, sellTaxEtf: 0.002 }, { etf: true }), { fee: 150, tax: 2000 });
  assert.deepEqual(feesFor('BUY', 1_000_000, DEFAULT_COSTS.crypto, {}), { fee: 500, tax: 0 });
  assert.equal(affordableQty(1_000_000, 84545, k), 11);
  const s2 = stressCosts(k);
  assert.equal(s2.commission, k.commission * 2);
  assert.equal(s2.sellTaxStock, k.sellTaxStock);
});

test('risk layer: per-position cap, min cash, buy block', () => {
  const risk = mergeRisk({ maxPositionWeight: 0.3, minCash: 0.4 });
  const r = applyRisk({ A: 0.5, B: 0.3, C: -1 }, { weights: { B: 0.1 }, blockBuys: false }, risk);
  assert.equal(r.targets.C, 0);
  close(r.targets.A + r.targets.B, 0.6);
  assert.ok(r.notes.A.includes('최대'));
  const b = applyRisk({ A: 0.3, B: 0.3 }, { weights: { B: 0.1 }, blockBuys: true, dailyRet: -0.03 }, risk);
  assert.equal(b.targets.A, 0);
  assert.equal(b.targets.B, 0.1);
  assert.ok(b.notes.A.includes('하루 손실'));
});

test('metrics: MDD, CAGR, win rate, benchmark', () => {
  assert.equal(maxDrawdown([100, 120, 90, 130]), 0.25);
  close(cagr(100, 121, 365.25 * 2), 0.1);
  const pts = [100, 110, 99, 120].map((e, i) => ({ t: i * 86400, equity: e, bench: 100 + i, invested: e / 2 }));
  const m = computeMetrics(pts, [{ side: 'BUY', pnl: 0 }, { side: 'SELL', pnl: 5 }, { side: 'SELL', pnl: -2 }], { market: 'crypto' });
  assert.equal(m.totalReturn, 0.2);
  assert.equal(m.mdd, 0.1);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.trades, 3);
  assert.equal(m.bench.totalReturn, 0.03);
  close(m.exposure, 0.5);
});

test('calendar: KRX holidays, final-bar rules', () => {
  assert.equal(isKrxBusinessDay(dayT('2026-02-17')), false); // 설날
  assert.equal(isKrxBusinessDay(dayT('2026-11-13')), true);
  assert.equal(isKrxBusinessDay(dayT('2026-11-14')), false); // Saturday
  const fri = dayT('2026-11-13');
  assert.equal(latestFinalKrxDay(kstAt(fri, 15, 0)), dayT('2026-11-12')); // not final during session
  assert.equal(latestFinalKrxDay(kstAt(fri, 17, 0)), fri);
  assert.equal(latestFinalCryptoDay(kstAt(dayT('2026-11-15'), 10, 0)), dayT('2026-11-14'));
});
