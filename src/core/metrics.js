// Performance metrics shared by backtests and live paper runs.
import { DAY } from './calendar.js';

export function periodsPerYear(market, tf) {
  if (tf === '1h') return 24 * 365;
  return market === 'crypto' ? 365 : 252;
}

export function maxDrawdown(values) {
  let peak = -Infinity, mdd = 0;
  for (const v of values) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.max(mdd, 1 - v / peak); }
  return mdd;
}

function returns(values) {
  const r = [];
  for (let i = 1; i < values.length; i++) if (values[i - 1] > 0) r.push(values[i] / values[i - 1] - 1);
  return r;
}

export function sharpe(values, ppy) {
  const r = returns(values);
  if (r.length < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(ppy) : 0;
}

export function cagr(first, last, days) {
  if (first <= 0 || days <= 0) return 0;
  const yrs = days / 365.25;
  if (yrs < 1 / 365) return 0;
  return (last / first) ** (1 / yrs) - 1;
}

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0);

/**
 * @param {Array<{t,equity,bench,invested}>} points
 * @param {Array<{side,pnl}>} fills
 */
export function computeMetrics(points, fills, { market = 'krx', tf = '1d' } = {}) {
  if (!points.length) return { bars: 0, days: 0, totalReturn: 0, cagr: 0, mdd: 0, sharpe: 0, winRate: 0, trades: 0, sells: 0, bench: { totalReturn: 0, cagr: 0, mdd: 0, sharpe: 0 }, excess: 0, exposure: 0 };
  const ppy = periodsPerYear(market, tf);
  const eq = points.map((p) => p.equity);
  const bx = points.map((p) => p.bench);
  const first = points[0], last = points[points.length - 1];
  const days = Math.max(0, (last.t - first.t) / DAY) + (tf === '1h' ? 0 : 1);
  const sells = fills.filter((f) => f.side === 'SELL');
  const wins = sells.filter((f) => f.pnl > 0).length;
  const tr = eq[eq.length - 1] / eq[0] - 1;
  const btr = bx[0] > 0 ? bx[bx.length - 1] / bx[0] - 1 : 0;
  const exposure = points.reduce((a, p) => a + (p.equity > 0 ? (p.invested || 0) / p.equity : 0), 0) / points.length;
  return {
    bars: points.length, days: Math.round(days), from: first.t, to: last.t,
    totalReturn: r4(tr), cagr: r4(cagr(eq[0], eq[eq.length - 1], days)), mdd: r4(maxDrawdown(eq)), sharpe: r4(sharpe(eq, ppy)),
    winRate: r4(sells.length ? wins / sells.length : 0), trades: fills.length, sells: sells.length,
    fees: Math.round(fills.reduce((a, f) => a + (f.fee || 0) + (f.tax || 0), 0)),
    bench: { totalReturn: r4(btr), cagr: r4(cagr(bx[0], bx[bx.length - 1], days)), mdd: r4(maxDrawdown(bx)), sharpe: r4(sharpe(bx, ppy)) },
    excess: r4(tr - btr), exposure: r4(exposure),
  };
}

/** Chain segment equity curves (each starting fresh) into one normalised curve. */
export function chainSegments(segments, start = 1) {
  const out = [];
  let eqBase = start, bBase = start;
  for (const seg of segments) {
    if (!seg.length) continue;
    const e0 = seg[0].equity, b0 = seg[0].bench;
    for (const p of seg) out.push({ t: p.t, equity: eqBase * (p.equity / e0), bench: bBase * (b0 > 0 ? p.bench / b0 : 1), invested: p.equity > 0 ? (p.invested / p.equity) * eqBase * (p.equity / e0) : 0 });
    eqBase = out[out.length - 1].equity; bBase = out[out.length - 1].bench;
  }
  return out;
}
