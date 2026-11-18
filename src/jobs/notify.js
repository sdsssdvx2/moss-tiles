// Telegram notifications to the OWNER chat only (optional). Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Schedule & routing are owner-editable (kv 'notify:settings', see src/core/notify-schedule.js):
//   - daily summary at one or more KST times (평일만/매일), once per slot per day (kv 'notify:sent', compare-and-set)
//   - event alerts per category: 즉시 / 하루 요약에 포함 / 끄기
//   - quiet hours: instant alerts are queued (events.notified = 2) and go out with the next summary
import { lifecycleAll, getRuns, kvAll, kvSetStmt } from '../db/store.js';
import { allStrategies } from '../strategies/index.js';
import { ymd } from '../core/calendar.js';
import { parseSettings, dueSummaries, eventRoute, migrateLegacyGuard, nextSummaries, DEFAULTS, validateSettings } from '../core/notify-schedule.js';

export const QUEUED = 2; // events.notified: 0 = new, 1 = done, 2 = waiting for the next summary

export const telegramReady = (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

export async function sendTelegram(env, text, fetcher = fetch) {
  if (!telegramReady(env)) return false;
  const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3900), disable_web_page_preview: true }),
  });
  return res.ok;
}

const ids = (list) => list.map(() => '?').join(',');
async function markEvents(env, list, value) {
  // B17: D1 allows at most 100 bound parameters per statement
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    await env.DB.prepare(`UPDATE events SET notified = ${value} WHERE id IN (${ids(chunk)})`).bind(...chunk).run();
  }
}

/**
 * Data-error alerts (category 'data' in 즉시 mode): one 'data_error' event when a source turns bad
 * (last error newer than last success). State: kv 'notify:data:bad' = [sources already alerted].
 */
async function dataErrorEvents(env, kv, now) {
  const { results } = await env.DB.prepare('SELECT source, last_ok, last_err, err FROM data_health').all();
  const bad = results.filter((h) => (h.last_err || 0) > (h.last_ok || 0));
  const prev = new Set(Array.isArray(kv['notify:data:bad']) ? kv['notify:data:bad'] : []);
  const cur = bad.map((h) => h.source).sort();
  const fresh = bad.filter((h) => !prev.has(h.source));
  const stmts = [];
  for (const h of fresh) stmts.push(env.DB.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)').bind(now, 'data_error', null, `⚠️ 데이터 오류: ${h.source} — ${String(h.err || '원인 미상').slice(0, 120)}`));
  if (cur.join() !== [...prev].sort().join()) { stmts.push(kvSetStmt(env.DB, 'notify:data:bad', cur)); kv['notify:data:bad'] = cur; }
  if (stmts.length) await env.DB.batch(stmts);
  return fresh.length;
}

/** Route new events: send now (max per tick), queue for the next summary, or drop. */
export async function notifyPending(env, { fetcher = fetch, max = 5, kv = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const settings = parseSettings(kv?.['notify:settings']);
  if (telegramReady(env) && settings.events.data === 'instant') await dataErrorEvents(env, kv || {}, now);
  const { results } = await env.DB.prepare('SELECT id, kind, message FROM events WHERE notified = 0 ORDER BY id LIMIT 30').all();
  if (!results.length) return 0;
  const done = []; const queue = [];
  let sent = 0;
  for (const e of results) {
    if (!telegramReady(env)) { done.push(e.id); continue; }
    const route = eventRoute(e.kind, { nowSec: now, settings });
    if (route === 'drop') { done.push(e.id); continue; }
    if (route === 'hold') continue; // quiet hours and no summary: stays new, goes out after quiet hours
    if (route === 'queue' || sent >= max) { (settings.summaryTimes.length ? queue : done).push(e.id); continue; }
    let ok = false;
    try { ok = await sendTelegram(env, `[모의투자봇] ${e.message}`, fetcher); } catch { ok = false; }
    if (!ok) break; // Telegram down: leave this and later events for the next tick
    sent++; done.push(e.id);
  }
  await markEvents(env, done, 1);
  await markEvents(env, queue, QUEUED);
  return sent;
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`;

export async function dailySummaryText(env, now, { settings = parseSettings(null), queued = [] } = {}) {
  const lc = await lifecycleAll(env.DB);
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.strategy_id + ':' + r.mode, r]));
  const kv = await kvAll(env.DB);
  const d = kv['decision:current'];
  const lines = [`📊 모의투자 하루 요약 (${ymd(now + 9 * 3600)})`, '※ 가상 돈입니다. 실제 주문은 하지 않습니다.', ''];
  if (d?.headline) lines.push(`📌 결론: ${d.headline}`, d.connect?.text || '', `(${d.disclaimer})`, '', '자세히(장부별 숫자, 읽지 않아도 됨):');
  for (const s of allStrategies(kv)) {
    const r = runs[`${s.id}:paper`];
    const l = lc[s.id];
    if (!r || s.closed) continue;
    const ret = r.state.equity / r.state.initialCash - 1;
    const b = r.state.bench / r.state.initialCash - 1;
    lines.push(`• ${s.name}: ${pct(ret)} (기준 ${pct(b)}) — ${l?.label || '평가 대기'}${r.state.halted ? ' ⛔' : ''}`);
  }
  let dataLine = false;
  if (settings.events.data !== 'off') {
    const { results } = await env.DB.prepare('SELECT source, last_ok, last_err FROM data_health').all();
    const bad = results.filter((h) => (h.last_err || 0) > (h.last_ok || 0));
    if (bad.length) { lines.push('', `⚠️ 데이터 문제: ${bad.map((b) => b.source).join(', ')}`); dataLine = true; }
  }
  const ev = queued.filter((e) => !(dataLine && e.kind === 'data_error'));
  if (ev.length) {
    lines.push('', `🔔 지난 요약 뒤 알림 ${ev.length}건`);
    for (const e of ev.slice(0, 15)) lines.push(`· ${e.message}`);
    if (ev.length > 15) lines.push(`· 외 ${ev.length - 15}건 (대시보드 '기록' 탭)`);
  }
  return lines.join('\n');
}

// ---------- scheduled summary (called first thing in every cron tick: one small kv read) ----------
const NOTIFY_KEYS = ['notify:settings', 'notify:sent', 'summary:last'];
async function readNotifyKv(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM kv WHERE k IN (${ids(NOTIFY_KEYS)})`).bind(...NOTIFY_KEYS).all();
  const m = Object.fromEntries(results.map((r) => [r.k, r.v]));
  const settings = parseSettings(m['notify:settings']);
  let sentRaw = m['notify:sent'] ?? null;
  let sent = {};
  try { sent = sentRaw ? JSON.parse(sentRaw) : {}; } catch { sent = {}; }
  let legacy = m['summary:last'] ?? null;
  try { legacy = legacy ? JSON.parse(legacy) : null; } catch { /* stored raw */ }
  return { settings, sent: migrateLegacyGuard(sent, legacy, settings), sentRaw };
}

/** Compare-and-set kv 'notify:sent' so overlapping ticks cannot both claim a slot. */
async function casSent(env, fromRaw, to, now) {
  const toRaw = JSON.stringify(to);
  const r = fromRaw === null
    ? await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v, updated_at) VALUES ('notify:sent', ?1, ?2)").bind(toRaw, now).run()
    : await env.DB.prepare("UPDATE kv SET v = ?1, updated_at = ?3 WHERE k = 'notify:sent' AND v = ?2").bind(toRaw, fromRaw, now).run();
  return (r.meta?.changes ?? 0) === 1 ? toRaw : null;
}

/**
 * Claims due summary slots (cheap) and returns a promise that sends them (for ctx.waitUntil).
 * On a failed send the claim is released so the next tick retries inside the catch-up window.
 */
export async function scheduledSummary(env, now, { fetcher = fetch } = {}) {
  if (!telegramReady(env)) return null;
  const { settings, sent, sentRaw } = await readNotifyKv(env);
  const due = dueSummaries({ nowSec: now, settings, sent });
  if (!due.length) return null;
  const next = { ...Object.fromEntries(Object.entries(sent).filter(([k]) => settings.summaryTimes.includes(k))) };
  for (const d of due) next[d.slot] = d.date;
  const claimed = await casSent(env, sentRaw, next, now);
  if (claimed === null) return null;
  return (async () => {
    const { results: queued } = await env.DB.prepare(`SELECT id, kind, message FROM events WHERE notified = ${QUEUED} ORDER BY id LIMIT 200`).all();
    const text = await dailySummaryText(env, now, { settings, queued });
    let ok = false;
    try { ok = await sendTelegram(env, text, fetcher); } catch { ok = false; }
    if (ok) await markEvents(env, queued.map((e) => e.id), 1);
    else await casSent(env, claimed, sent, now);
    return { slots: due.map((d) => d.slot), ok, queued: queued.length };
  })();
}

// ---------- settings API ----------
export async function notifyStatus(env, now = Math.floor(Date.now() / 1000)) {
  const { settings, sent } = await readNotifyKv(env);
  const q = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE notified = ${QUEUED}`).first();
  return { settings, defaults: DEFAULTS, sent, next: nextSummaries({ nowSec: now, settings, sent }), queued: q?.n || 0, telegram: telegramReady(env) };
}
export async function saveNotifySettings(env, input) {
  const s = validateSettings(input);
  const stmts = [kvSetStmt(env.DB, 'notify:settings', s)];
  // No summary any more: nothing would ever deliver queued events, so close them.
  if (!s.summaryTimes.length) stmts.push(env.DB.prepare(`UPDATE events SET notified = 1 WHERE notified = ${QUEUED}`));
  await env.DB.batch(stmts);
  return s;
}
/** Manual sends from the settings card. 'summary' previews the summary incl. queued events without consuming them. */
export async function notifyTest(env, mode, now = Math.floor(Date.now() / 1000), fetcher = fetch) {
  if (!telegramReady(env)) return { sent: false, error: '텔레그램이 아직 연결되지 않았습니다 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)' };
  if (mode === 'summary') {
    const { settings } = await readNotifyKv(env);
    const { results: queued } = await env.DB.prepare(`SELECT id, kind, message FROM events WHERE notified = ${QUEUED} ORDER BY id LIMIT 200`).all();
    return { sent: await sendTelegram(env, '[미리보기] ' + await dailySummaryText(env, now, { settings, queued }), fetcher) };
  }
  return { sent: await sendTelegram(env, '[모의투자봇] 알림 테스트입니다. (가상 투자 알림 전용 · 실제 주문 없음)', fetcher) };
}
