// Time conventions
//  - Daily bars: t = epoch seconds of the KST calendar date written as UTC midnight
//    (e.g. 2026-11-13 -> Date.UTC(2026,10,13)/1000). Pure "date label".
//  - Hourly bars: t = real epoch seconds (UTC) of the bar start.
export const DAY = 86400;
export const HOUR = 3600;
const KST_OFFSET = 9 * HOUR;

export const dayT = (ymd) => {
  const [y, m, d] = String(ymd).replace(/-/g, '').match(/^(\d{4})(\d{2})(\d{2})$/).slice(1).map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
};
export const ymd = (t) => new Date(t * 1000).toISOString().slice(0, 10);
export const ymdCompact = (t) => ymd(t).replace(/-/g, '');
/** KST wall-clock parts of a real epoch-seconds instant. */
export function kstParts(nowSec) {
  const d = new Date((nowSec + KST_OFFSET) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
}
/** KST date label (daily t) of a real instant. */
export const kstDayT = (nowSec) => Math.floor((nowSec + KST_OFFSET) / DAY) * DAY;
/** Real epoch seconds of a KST wall-clock time on daily label t. */
export const kstAt = (labelT, hh, mm = 0) => labelT - KST_OFFSET + hh * HOUR + mm * 60;

// KRX closed days (weekends excluded separately). Sources: KRX 휴장일 공지 + 공휴일/대체공휴일.
// 2027 values are best-effort and must be re-checked against the KRX notice each December.
// The engine never trusts this list blindly: a day only counts as a trading day if bars exist.
export const KRX_HOLIDAYS = new Set([
  // 2024
  '2024-01-01', '2024-02-09', '2024-02-12', '2024-03-01', '2024-04-10', '2024-05-01', '2024-05-06', '2024-05-15',
  '2024-06-06', '2024-08-15', '2024-09-16', '2024-09-17', '2024-09-18', '2024-10-01', '2024-10-03', '2024-10-09',
  '2024-12-25', '2024-12-31',
  // 2025
  '2025-01-01', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-03', '2025-05-01', '2025-05-05',
  '2025-05-06', '2025-06-03', '2025-06-06', '2025-08-15', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  '2025-10-09', '2025-12-25', '2025-12-31',
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25',
  '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-28', '2026-10-05', '2026-10-09', '2026-12-25',
  '2026-12-31',
  // 2027 (best effort)
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13', '2027-08-16', '2027-09-14',
  '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27', '2027-12-31',
]);

export function isKrxBusinessDay(labelT) {
  const dow = new Date(labelT * 1000).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !KRX_HOLIDAYS.has(ymd(labelT));
}
export function prevKrxBusinessDay(labelT) {
  let t = labelT - DAY;
  for (let i = 0; i < 15 && !isKrxBusinessDay(t); i++) t -= DAY;
  return t;
}
export function nextKrxBusinessDay(labelT) {
  let t = labelT + DAY;
  for (let i = 0; i < 15 && !isKrxBusinessDay(t); i++) t += DAY;
  return t;
}
/** KRX regular session 09:00–15:30 KST. */
export function krxSessionOpen(nowSec) {
  const label = kstDayT(nowSec);
  if (!isKrxBusinessDay(label)) return false;
  return nowSec >= kstAt(label, 9, 0) && nowSec < kstAt(label, 15, 30);
}
/** Latest KRX daily bar that is final at instant nowSec (close + 70 min buffer). */
export function latestFinalKrxDay(nowSec) {
  const today = kstDayT(nowSec);
  if (isKrxBusinessDay(today) && nowSec >= kstAt(today, 16, 40)) return today;
  return prevKrxBusinessDay(today);
}
/** Latest completed Upbit daily candle label (Upbit daily candles roll at 09:00 KST = 00:00 UTC). */
export function latestFinalCryptoDay(nowSec) {
  // candle labelled D (KST) covers D 09:00 KST .. D+1 09:00 KST.
  const cur = Math.floor(nowSec / DAY) * DAY; // UTC midnight == KST 09:00 of label cur
  return cur - DAY;
}
export const latestFinalHour = (nowSec) => Math.floor(nowSec / HOUR) * HOUR - HOUR;
