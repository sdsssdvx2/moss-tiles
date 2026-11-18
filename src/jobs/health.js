// Liveness / freshness report for the public /health endpoint (no money values, no error texts, no secrets).
// Used by an external morning health check: `ok:false` + `problems[]` means the paper lab has stalled.
import { DAY, HOUR, latestFinalKrxDay, latestFinalCryptoDay, latestFinalHour, isKrxBusinessDay } from '../core/calendar.js';
import { kvSetStmt } from '../db/store.js';

export const HEALTH_KEYS = ['tick:last', 'tick:lastErr', 'ready:krx:1d', 'ready:crypto:1d', 'ready:crypto:1h', 'lc:at'];
const TICK_STALE = 30 * 60;  // cron runs every 10 min
const ERR_RECENT = 6 * HOUR; // a task error newer than this is reported

/** KRX business days strictly after `from` up to and including `to`. */
function krxLag(from, to) {
  if (!from) return null;
  let n = 0;
  for (let t = from + DAY; t <= to && n < 60; t += DAY) if (isKrxBusinessDay(t)) n++;
  return n;
}

/** Task names only (the part before ':ERR:'), never the error text. */
export const errTasks = (log = []) => [...new Set(log.filter((x) => String(x).includes(':ERR')).map((x) => String(x).split(':ERR')[0]))];

export function healthReport(kv, healthRows, now) {
  const tick = kv['tick:last'] || null;
  const lastErr = kv['tick:lastErr'] || null;
  const problems = [];
  const tickAgeMin = tick?.t ? Math.round((now - tick.t) / 60) : null;
  if (tickAgeMin == null) problems.push('tick:none');
  else if (now - tick.t > TICK_STALE) problems.push(`tick:stale:${tickAgeMin}m`);
  // KRX: the official daily file arrives next morning, so a lag of 1 business day is normal
  const krxLagDays = krxLag(kv['ready:krx:1d'], latestFinalKrxDay(now));
  if (krxLagDays == null || krxLagDays >= 2) problems.push(`krx1d:lag:${krxLagDays ?? 'none'}`);
  const c1d = kv['ready:crypto:1d'];
  const crypto1dLagDays = c1d ? Math.round((latestFinalCryptoDay(now) - c1d) / DAY) : null;
  if (crypto1dLagDays == null || crypto1dLagDays >= 2) problems.push(`crypto1d:lag:${crypto1dLagDays ?? 'none'}`);
  const c1h = kv['ready:crypto:1h'];
  const crypto1hLagHours = c1h ? Math.round((latestFinalHour(now) - c1h) / HOUR) : null;
  if (crypto1hLagHours == null || crypto1hLagHours >= 4) problems.push(`crypto1h:lag:${crypto1hLagHours ?? 'none'}`);
  const recentErr = lastErr?.t && now - lastErr.t < ERR_RECENT ? lastErr : null;
  if (recentErr) problems.push(`task:error:${recentErr.tasks.join(',')}`);
  const failingSources = (healthRows || [])
    .filter((r) => r.last_err && r.last_err > (r.last_ok || 0) && now - r.last_err < DAY)
    .map((r) => r.source);
  // a failing optional feed (news, fear&greed) is shown but is not a stall by itself
  for (const s of failingSources) if (/^(upbit:1[dh]|krx:|naver)/.test(s)) problems.push(`source:${s}`);
  return {
    ok: problems.length === 0, problems,
    checks: { tickAgeMin, krxLagDays, crypto1dLagDays, crypto1hLagHours, failingSources,
      lastErrorAt: lastErr?.t || null, lastErrorTasks: lastErr?.tasks || [], lifecycleAgeHours: kv['lc:at'] ? Math.round((now - kv['lc:at']) / HOUR) : null },
  };
}

export async function loadHealth(env, now) {
  const marks = HEALTH_KEYS.map(() => '?').join(',');
  const [{ results: kvRows }, { results: hRows }] = await Promise.all([
    env.DB.prepare(`SELECT k, v FROM kv WHERE k IN (${marks})`).bind(...HEALTH_KEYS).all(),
    env.DB.prepare('SELECT source, last_ok, last_err FROM data_health').all(),
  ]);
  const kv = {};
  for (const r of kvRows) { try { kv[r.k] = JSON.parse(r.v); } catch { kv[r.k] = r.v; } }
  return healthReport(kv, hRows, now);
}

/** Statements recording the tick heartbeat (+ last task error). One or two small kv writes per tick. */
export function heartbeatStmts(db, now, log) {
  const tasks = errTasks(log);
  const stmts = [kvSetStmt(db, 'tick:last', { t: now, log: (log || []).map((x) => String(x).split(':ERR')[0] + (String(x).includes(':ERR') ? ':ERR' : '')).slice(0, 20) })];
  // error texts stay in D1 for the owner (never returned by /health)
  if (tasks.length) stmts.push(kvSetStmt(db, 'tick:lastErr', { t: now, tasks, detail: (log || []).filter((x) => String(x).includes(':ERR')).map((x) => String(x).slice(0, 160)) }));
  return stmts;
}
