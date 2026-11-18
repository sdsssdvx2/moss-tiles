// Owner-editable Telegram schedule (pure functions; unit-tested in test/notify-schedule.test.mjs).
// The single */10 cron tick asks dueSummaries() whether a daily-summary slot is due, and
// eventRoute() what to do with each new event (send now / queue for the next summary / drop).
// Times are KST "HH:MM" on 10-minute steps. Stored in D1 kv 'notify:settings'.

export const KST_MIN = 9 * 60;
export const CATCH_UP_MIN = 60; // a slot may still go out this long after its start (late/missed ticks)
export const MAX_SUMMARY_TIMES = 4;
export const MODES = ['instant', 'summary', 'off'];
export const CATEGORIES = ['lifecycle', 'crypto', 'data'];

// Defaults = previous behaviour: summary 08:40 KST every day; lifecycle + coin alerts sent immediately;
// data problems only as a line in the daily summary; no quiet hours.
export const DEFAULTS = Object.freeze({
  summaryTimes: ['08:40'],
  summaryDays: 'daily', // 'daily' | 'weekdays'
  events: Object.freeze({ lifecycle: 'instant', crypto: 'instant', data: 'summary' }),
  quiet: Object.freeze({ enabled: false, start: '23:00', end: '07:00' }),
});

// Event kinds → category. Kinds not listed are never sent (fills, daily_loss, market_signal, ...).
export const KIND_CATEGORY = { promote: 'lifecycle', kill: 'lifecycle', halt: 'lifecycle', resume: 'lifecycle', stage: 'lifecycle', market_alert: 'crypto', data_error: 'data', data_warn: 'data' };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]0)$/;
export const toMin = (hhmm) => { const m = TIME_RE.exec(String(hhmm ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMin = (x) => { const m = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** KST calendar position of an epoch-seconds instant. */
export function kstNow(nowSec) {
  const d = new Date((nowSec + KST_MIN * 60) * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const dayAllowed = (iso, s) => s.summaryDays !== 'weekdays' || (dowOf(iso) >= 1 && dowOf(iso) <= 5);

const sortTimes = (list) => [...new Set(list)].sort((a, b) => toMin(a) - toMin(b));

/** Lenient read of stored settings (bad/missing fields → defaults). */
export function parseSettings(raw) {
  let o = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  if (!o || typeof o !== 'object') o = {};
  const times = Array.isArray(o.summaryTimes) ? sortTimes(o.summaryTimes.filter((t) => toMin(t) !== null)).slice(0, MAX_SUMMARY_TIMES) : null;
  const ev = o.events && typeof o.events === 'object' ? o.events : {};
  const q = o.quiet && typeof o.quiet === 'object' ? o.quiet : {};
  const s = {
    summaryTimes: times && times.length ? times : (Array.isArray(o.summaryTimes) && o.summaryTimes.length === 0 ? [] : [...DEFAULTS.summaryTimes]),
    summaryDays: ['daily', 'weekdays'].includes(o.summaryDays) ? o.summaryDays : DEFAULTS.summaryDays,
    events: Object.fromEntries(CATEGORIES.map((c) => [c, MODES.includes(ev[c]) ? ev[c] : DEFAULTS.events[c]])),
    quiet: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : DEFAULTS.quiet.enabled,
      start: toMin(q.start) !== null ? q.start : DEFAULTS.quiet.start,
      end: toMin(q.end) !== null ? q.end : DEFAULTS.quiet.end,
    },
  };
  if (s.quiet.start === s.quiet.end) s.quiet.enabled = false;
  return s;
}

export class SettingsError extends Error {}
/** Strict validation of the owner's form. Empty summaryTimes = no daily summary. */
export function validateSettings(o) {
  const fail = (m) => { throw new SettingsError(m); };
  if (!o || typeof o !== 'object') fail('알림 설정 형식이 올바르지 않습니다');
  if (!Array.isArray(o.summaryTimes)) fail('요약 시각 목록이 필요합니다');
  for (const t of o.summaryTimes) if (toMin(t) === null) fail(`요약 시각은 10분 단위(예: 08:40)로 정하세요: ${String(t).slice(0, 8)}`);
  const times = sortTimes(o.summaryTimes);
  if (times.length > MAX_SUMMARY_TIMES) fail(`요약 시각은 ${MAX_SUMMARY_TIMES}개까지 정할 수 있습니다`);
  if (!['daily', 'weekdays'].includes(o.summaryDays)) fail('요약 요일(평일만/매일)을 고르세요');
  const ev = o.events || {};
  for (const c of CATEGORIES) if (!MODES.includes(ev[c])) fail('알림 방식(즉시/하루 요약에 포함/끄기)을 고르세요');
  const q = o.quiet || {};
  if (typeof q.enabled !== 'boolean') fail('방해 금지 켜기/끄기 값이 올바르지 않습니다');
  if (toMin(q.start) === null || toMin(q.end) === null) fail('방해 금지 시각은 10분 단위로 정하세요');
  if (q.enabled && q.start === q.end) fail('방해 금지 시작과 끝이 같습니다');
  return { summaryTimes: times, summaryDays: o.summaryDays, events: Object.fromEntries(CATEGORIES.map((c) => [c, ev[c]])), quiet: { enabled: q.enabled, start: q.start, end: q.end } };
}

/** Minute-of-day inside the quiet window [start, end)? Windows may wrap midnight. */
export function inQuiet(min, s) {
  const q = s.quiet;
  if (!q || !q.enabled) return false;
  const a = toMin(q.start), b = toMin(q.end);
  if (a === null || b === null || a === b) return false;
  const x = ((min % 1440) + 1440) % 1440;
  return a < b ? x >= a && x < b : x >= a || x < b;
}
/** Slot start after quiet hours, in minutes from the slot date's KST midnight (may be ≥ 1440 = next day). */
export function effectiveStart(slotMin, s) {
  if (!inQuiet(slotMin, s)) return slotMin;
  const a = toMin(s.quiet.start), b = toMin(s.quiet.end);
  if (a < b) return b;
  return slotMin >= a ? b + 1440 : b;
}

/**
 * Summary slots due at nowSec. sent = { 'HH:MM': 'YYYY-MM-DD' } (KST slot date last claimed) — the
 * once-per-slot-per-day guard. Several slots deferred to the same quiet end collapse into one send.
 */
export function dueSummaries({ nowSec, settings: s, sent = {} }) {
  const now = kstNow(nowSec);
  if (inQuiet(now.min, s)) return [];
  const due = [];
  for (const slot of s.summaryTimes) {
    const base = toMin(slot);
    for (const back of [0, 1]) {
      const date = addDays(now.date, -back);
      if (!dayAllowed(date, s)) continue;
      const start = effectiveStart(base, s);
      const rel = now.min + back * 1440;
      if (rel >= start && rel < start + CATCH_UP_MIN && sent[slot] !== date) { due.push({ slot, date }); break; }
    }
  }
  return due;
}

/** Next send time per slot (for the settings card). */
export function nextSummaries({ nowSec, settings: s, sent = {} }) {
  const now = kstNow(nowSec);
  const out = [];
  for (const slot of s.summaryTimes) {
    const base = toMin(slot);
    for (let off = -1; off <= 8; off++) {
      const date = addDays(now.date, off);
      if (!dayAllowed(date, s) || sent[slot] === date) continue;
      const start = effectiveStart(base, s);
      if (start - (now.min - off * 1440) + CATCH_UP_MIN <= 0) continue;
      out.push({ slot, date, at: `${addDays(date, Math.floor(start / 1440))} ${fromMin(start)}`, deferred: start !== base });
      break;
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** What to do with one new event now: 'send' | 'queue' (next summary) | 'drop'. */
export function eventRoute(kind, { nowSec, settings: s }) {
  const cat = KIND_CATEGORY[kind];
  if (!cat) return 'drop';
  const mode = s.events[cat];
  if (mode === 'off') return 'drop';
  if (mode === 'summary') return s.summaryTimes.length ? 'queue' : 'drop';
  if (inQuiet(kstNow(nowSec).min, s)) return s.summaryTimes.length ? 'queue' : 'hold';
  return 'send';
}

/** Old guard (kv 'summary:last' = UTC date of the 23:40 UTC send) → new guard for the default 08:40 slot. */
export function migrateLegacyGuard(sent, legacyUtcDay, settings) {
  if (sent && Object.keys(sent).length) return sent;
  if (!legacyUtcDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(legacyUtcDay)) || !settings.summaryTimes.includes('08:40')) return sent || {};
  return { '08:40': addDays(String(legacyUtcDay), 1) };
}
