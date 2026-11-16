// Pure indicator helpers over arrays of numbers (oldest -> newest).
// All functions return the value at the LAST element unless stated, or NaN when
// there is not enough data. No lookahead: callers pass only data up to "now".

const last = (a) => a[a.length - 1];

export function sma(values, n) {
  if (n <= 0 || values.length < n) return NaN;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

/** Full EMA series (seeded with SMA of first n values). */
export function emaSeries(values, n) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < n || n <= 0) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
export const ema = (values, n) => last(emaSeries(values, n));

/** Highest value of the n bars BEFORE the last bar (classic Donchian breakout reference). */
export function highestPrior(values, n) {
  if (values.length < n + 1) return NaN;
  let m = -Infinity;
  for (let i = values.length - 1 - n; i < values.length - 1; i++) m = Math.max(m, values[i]);
  return m;
}
export function lowestPrior(values, n) {
  if (values.length < n + 1) return NaN;
  let m = Infinity;
  for (let i = values.length - 1 - n; i < values.length - 1; i++) m = Math.min(m, values[i]);
  return m;
}

/** Rate of change over n bars: v[last]/v[last-n]-1 */
export function roc(values, n) {
  if (values.length < n + 1) return NaN;
  const prev = values[values.length - 1 - n];
  return prev > 0 ? last(values) / prev - 1 : NaN;
}

export function stdev(values, n) {
  if (values.length < n || n < 2) return NaN;
  const m = sma(values, n);
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += (values[i] - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/** Wilder RSI */
export function rsi(values, n = 14) {
  if (values.length < n + 1) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

/** Wilder ATR from bar objects {h,l,c} */
export function atr(bars, n = 14) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000 || bars.length < n + 1) return NaN;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/** Did fast cross above slow on the last bar? (needs both series) */
export function crossedAbove(fast, slow) {
  const n = fast.length;
  if (n < 2) return false;
  return fast[n - 2] <= slow[n - 2] && fast[n - 1] > slow[n - 1];
}
export function crossedBelow(fast, slow) {
  const n = fast.length;
  if (n < 2) return false;
  return fast[n - 2] >= slow[n - 2] && fast[n - 1] < slow[n - 1];
}
