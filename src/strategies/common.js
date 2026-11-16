// Shared helpers for strategy plugins (pure).
import { stdev } from '../core/indicators.js';
import { isKrxBusinessDay, nextKrxBusinessDay, DAY } from '../core/calendar.js';

/** Annualised realised volatility from closes (log returns over n bars). */
export function realizedVol(closes, n, periodsPerYear) {
  if (closes.length < n + 1) return NaN;
  const r = [];
  for (let i = closes.length - n; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return stdev(r, r.length) * Math.sqrt(periodsPerYear);
}
/** S3 volatility target sizing: weight = min(cap, target / vol). */
export function volTargetWeight(closes, { target, n = 20, ppy, cap = 1 }) {
  const v = realizedVol(closes, n, ppy);
  if (!Number.isFinite(v) || v <= 0) return cap;
  return Math.min(cap, target / v);
}
export const weekday = (t) => new Date(t * 1000).getUTCDay(); // 0=Sun .. 6=Sat (daily label t)
export const weekOf = (t) => Math.floor((t / DAY + 3) / 7);
/** Last KRX business day of its week (decided from the published calendar, not prices). */
export function isLastKrxDayOfWeek(t) {
  return isKrxBusinessDay(t) && weekOf(nextKrxBusinessDay(t)) !== weekOf(t);
}
export const monthOf = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
export const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 1000) / 10}%`;
