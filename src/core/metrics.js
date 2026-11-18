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
  // B08: futures fills carry phase (a short is closed by a BUY); spot exits are SELLs
  const sells = fills.filter((f) => (f.phase ? f.phase === 'exit' : f.side === 'SELL'));
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

/**
 * 위험 맞춤 기준선(고정 비율): 지수 `a`를 비중 w만큼, 나머지는 `b`(단기채권 ETF; 없으면 현금 0%)로 들고
 * 매월 첫 봉 종가에 비중을 다시 맞춘다. 전략의 평균 투자 비율과 같은 위험만 진 "아무 판단 없는" 비교 대상.
 * 비용은 빼지 않음(기준선에 유리 = 전략에 보수적). 반환: [{t, equity, bench, invested}]
 */
export function fixedMixCurve(ts, a, b, w, start = 1) {
  const pa = new Map((a || []).map((x) => [x.t, x.c])), pb = new Map((b || []).map((x) => [x.t, x.c]));
  const out = [];
  let ua = 0, ub = 0, cash = start, lastA = null, lastB = null, mon = null;
  for (const t of ts) {
    if (pa.has(t)) lastA = pa.get(t);
    if (pb.has(t)) lastB = pb.get(t);
    if (lastA == null) continue;
    const eq = cash + ua * lastA + (lastB != null ? ub * lastB : 0);
    const d = new Date(t * 1000), m = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (m !== mon) {
      mon = m;
      ua = (eq * w) / lastA;
      if (lastB != null && b) { ub = (eq * (1 - w)) / lastB; cash = 0; } else { ub = 0; cash = eq * (1 - w); }
    }
    const e2 = cash + ua * lastA + (lastB != null ? ub * lastB : 0);
    out.push({ t, equity: e2, bench: e2, invested: ua * lastA });
  }
  return out;
}

/** Same as fixedMixCurve but from already-computed equity points of a strategy: matches its average exposure. */
export function riskMatched(points, a, b, { market = 'krx', tf = '1d' } = {}) {
  if (!points?.length) return null;
  const exp = points.reduce((s, p) => s + (p.equity > 0 ? (p.invested || 0) / p.equity : 0), 0) / points.length;
  const curve = fixedMixCurve(points.map((p) => p.t), a, b, Math.max(0, Math.min(1, exp)), points[0].equity);
  if (curve.length < 2) return null;
  const m = computeMetrics(curve, [], { market, tf });
  return { weight: r4(exp), totalReturn: m.totalReturn, cagr: m.cagr, mdd: m.mdd, sharpe: m.sharpe, cash: b ? 'bond' : 'cash' };
}
