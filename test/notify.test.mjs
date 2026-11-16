// Owner-editable Telegram schedule: KST due-time math, once-per-slot guard, quiet hours, event routing,
// settings API (owner-only, same-origin) and the cached dashboard overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import * as N from '../src/core/notify-schedule.js';
import { notifyPending, scheduledSummary, notifyStatus, QUEUED } from '../src/jobs/notify.js';
import { kvAll, kvSetStmt, eventStmt } from '../src/db/store.js';
import { cacheFresh, overviewCached, CACHE_TTL_DIRTY, CACHE_MAX_AGE } from '../src/api.js';
import worker, { sameOrigin } from '../src/worker.js';

const kst = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+09:00`) / 1000;
const S = (o = {}) => N.parseSettings(o);
const due = (date, hhmm, s, sent = {}) => N.dueSummaries({ nowSec: kst(date, hhmm), settings: s, sent }).map((d) => `${d.slot}@${d.date}`);

test('defaults = previous behaviour (08:40 KST daily, lifecycle+coin instant, data in summary, no quiet hours)', () => {
  const s = S();
  assert.deepEqual(s.summaryTimes, ['08:40']);
  assert.equal(s.summaryDays, 'daily');
  assert.deepEqual(s.events, { lifecycle: 'instant', crypto: 'instant', data: 'summary' });
  assert.equal(s.quiet.enabled, false);
  assert.deepEqual(N.parseSettings('garbage'), s);
  assert.deepEqual(N.parseSettings({ summaryTimes: ['08:45', 'x'] }).summaryTimes, ['08:40'], 'off-step times fall back');
  assert.deepEqual(N.parseSettings({ summaryTimes: [] }).summaryTimes, [], 'explicit empty = no summary');
  // old fixed rule: first tick at/after 23:40 UTC
  assert.equal(new Date(kst('2026-11-17', '08:40') * 1000).toISOString(), '2026-11-16T23:40:00.000Z');
});

test('summary due math in KST, day boundary, catch-up window, once per slot per day', () => {
  const s = S({ summaryTimes: ['08:40', '16:00'] });
  assert.deepEqual(due('2026-11-16', '08:30', s), []);
  assert.deepEqual(due('2026-11-16', '08:40', s), ['08:40@2026-11-16']);
  assert.deepEqual(due('2026-11-16', '09:30', s), ['08:40@2026-11-16'], 'late tick within 60 min');
  assert.deepEqual(due('2026-11-16', '09:40', s), [], 'window over');
  assert.deepEqual(due('2026-11-16', '08:50', s, { '08:40': '2026-11-16' }), [], 'guard');
  assert.deepEqual(due('2026-11-16', '16:00', s, { '08:40': '2026-11-16' }), ['16:00@2026-11-16'], 'guard is per slot');
  assert.deepEqual(due('2026-11-17', '08:40', s, { '08:40': '2026-11-16' }), ['08:40@2026-11-17']);
  // 08:40 KST Monday is still Sunday 23:40 in UTC: the slot date must be the KST date
  assert.deepEqual(due('2026-11-16', '08:40', S({ summaryDays: 'weekdays' })), ['08:40@2026-11-16']);
  assert.deepEqual(due('2026-11-15', '08:40', S({ summaryDays: 'weekdays' })), [], 'Sunday');
  assert.deepEqual(due('2026-11-21', '08:40', S({ summaryDays: 'weekdays' })), [], 'Saturday');
  // a 23:50 slot keeps its window past midnight and stays keyed by its own date
  const late = S({ summaryTimes: ['23:50'] });
  assert.deepEqual(due('2026-11-17', '00:20', late), ['23:50@2026-11-16']);
  assert.deepEqual(due('2026-11-17', '00:20', late, { '23:50': '2026-11-16' }), []);
  // midnight slot: 00:00 KST = 15:00 UTC previous day
  assert.deepEqual(N.dueSummaries({ nowSec: Date.UTC(2026, 10, 15, 15, 0) / 1000, settings: S({ summaryTimes: ['00:00'] }) }).map((d) => d.date), ['2026-11-16']);
});

test('quiet hours: never send inside, defer summaries to the quiet end, queue instant events', () => {
  const q = { quiet: { enabled: true, start: '22:00', end: '07:00' } };
  const s = S({ ...q, summaryTimes: ['06:00', '22:30'] });
  assert.equal(N.inQuiet(22 * 60, s), true);
  assert.equal(N.inQuiet(7 * 60, s), false);
  assert.deepEqual(due('2026-11-16', '06:00', s), []);
  // both the 06:00 slot (same morning) and yesterday's 22:30 slot (next morning) come due at 07:00
  assert.deepEqual(due('2026-11-17', '07:00', s).sort(), ['06:00@2026-11-17', '22:30@2026-11-16']);
  const lunch = S({ quiet: { enabled: true, start: '12:00', end: '13:00' }, summaryTimes: ['12:30'] });
  assert.deepEqual(due('2026-11-16', '12:30', lunch), []);
  assert.deepEqual(due('2026-11-16', '13:00', lunch), ['12:30@2026-11-16']);
  // event routing
  const at = (h) => ({ nowSec: kst('2026-11-16', h), settings: S(q) });
  assert.equal(N.eventRoute('promote', at('12:00')), 'send');
  assert.equal(N.eventRoute('promote', at('23:00')), 'queue');
  assert.equal(N.eventRoute('market_alert', at('06:50')), 'queue');
  assert.equal(N.eventRoute('fill', at('12:00')), 'drop', 'not a notifiable kind');
  assert.equal(N.eventRoute('market_signal', at('12:00')), 'drop');
  assert.equal(N.eventRoute('data_error', at('12:00')), 'queue', 'data → summary by default');
  const off = { nowSec: kst('2026-11-16', '12:00'), settings: S({ events: { lifecycle: 'off', crypto: 'summary', data: 'instant' } }) };
  assert.equal(N.eventRoute('kill', off), 'drop');
  assert.equal(N.eventRoute('market_alert', off), 'queue');
  assert.equal(N.eventRoute('data_error', off), 'send');
  const noSummary = { nowSec: kst('2026-11-16', '23:00'), settings: S({ ...q, summaryTimes: [] }) };
  assert.equal(N.eventRoute('promote', noSummary), 'hold', 'no summary to join: wait for the quiet end');
  assert.equal(N.eventRoute('market_alert', { ...noSummary, settings: S({ summaryTimes: [], events: { crypto: 'summary' } }) }), 'drop');
});

test('validateSettings + nextSummaries + legacy guard', () => {
  const ok = { summaryTimes: ['16:00', '08:40', '08:40'], summaryDays: 'weekdays', events: { lifecycle: 'instant', crypto: 'summary', data: 'off' }, quiet: { enabled: true, start: '23:00', end: '07:00' } };
  assert.deepEqual(N.validateSettings(ok).summaryTimes, ['08:40', '16:00']);
  assert.throws(() => N.validateSettings({ ...ok, summaryTimes: ['08:45'] }), /10분 단위/);
  assert.throws(() => N.validateSettings({ ...ok, summaryTimes: ['01:00', '02:00', '03:00', '04:00', '05:00'] }), /4개/);
  assert.throws(() => N.validateSettings({ ...ok, summaryDays: 'sun' }), /요일/);
  assert.throws(() => N.validateSettings({ ...ok, events: { ...ok.events, data: 'loud' } }), /알림 방식/);
  assert.throws(() => N.validateSettings({ ...ok, quiet: { enabled: true, start: '23:00', end: '23:00' } }), /같습니다/);
  assert.equal(N.validateSettings({ ...ok, summaryTimes: [] }).summaryTimes.length, 0);
  const s = N.validateSettings(ok);
  assert.deepEqual(N.nextSummaries({ nowSec: kst('2026-11-20', '17:00'), settings: s }).map((x) => x.at), ['2026-11-23 08:40', '2026-11-23 16:00'], 'Fri evening → Mon');
  const eve = S({ summaryTimes: ['23:30'], quiet: { enabled: true, start: '23:00', end: '07:00' } });
  assert.deepEqual(N.nextSummaries({ nowSec: kst('2026-11-16', '12:00'), settings: eve })[0], { slot: '23:30', date: '2026-11-16', at: '2026-11-17 07:00', deferred: true });
  // old guard: summary:last = UTC day of the 23:40 UTC send = previous KST day
  assert.deepEqual(N.migrateLegacyGuard({}, '2026-11-15', S()), { '08:40': '2026-11-16' });
  assert.deepEqual(N.migrateLegacyGuard({ '08:40': '2026-11-10' }, '2026-11-15', S()), { '08:40': '2026-11-10' });
  assert.deepEqual(N.migrateLegacyGuard({}, null, S()), {});
});

function tgEnv() {
  const sent = [];
  const fetcher = async (url, init) => { sent.push(JSON.parse(init.body).text); return new Response('{}', { status: 200 }); };
  return { env: { DB: makeD1(), TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', OWNER_PASSWORD: 'owner-pass-1234567' }, sent, fetcher };
}
const addEvents = (env, list) => env.DB.batch(list.map(([kind, message]) => eventStmt(env.DB, { t: 1, kind, message })));
const notifiedOf = (env) => Object.fromEntries(env.DB.raw.prepare('SELECT message, notified FROM events').all().map((r) => [r.message, r.notified]));

test('notifyPending: instant / queued in quiet hours / dropped; summary sends queue once and marks it', async () => {
  const { env, sent, fetcher } = tgEnv();
  await kvSetStmt(env.DB, 'notify:settings', { summaryTimes: ['08:40'], summaryDays: 'daily', events: { lifecycle: 'instant', crypto: 'instant', data: 'summary' }, quiet: { enabled: true, start: '22:00', end: '07:00' } }).run();
  await addEvents(env, [['promote', 'P1'], ['fill', 'F1'], ['market_alert', 'M1']]);
  let kv = await kvAll(env.DB);
  assert.equal(await notifyPending(env, { fetcher, kv, now: kst('2026-11-16', '12:00') }), 2);
  assert.deepEqual(sent, ['[모의투자봇] P1', '[모의투자봇] M1']);
  assert.deepEqual(notifiedOf(env), { P1: 1, F1: 1, M1: 1 });
  // during quiet hours: queued for the next summary
  sent.length = 0;
  await addEvents(env, [['kill', 'K1'], ['market_alert', 'M2']]);
  assert.equal(await notifyPending(env, { fetcher, kv, now: kst('2026-11-16', '23:10') }), 0);
  assert.equal(sent.length, 0);
  assert.equal(notifiedOf(env).K1, QUEUED);
  assert.equal((await notifyStatus(env, kst('2026-11-16', '23:10'))).queued, 2);
  // summary at 07:00 (08:40 is outside quiet hours; due at 08:40)
  assert.equal(await scheduledSummary(env, kst('2026-11-17', '07:00'), { fetcher }), null, '08:40 not due yet');
  const p = await scheduledSummary(env, kst('2026-11-17', '08:40'), { fetcher });
  assert.ok(p);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.queued, 2);
  assert.match(sent[0], /하루 요약/);
  assert.match(sent[0], /지난 요약 뒤 알림 2건[\s\S]*K1[\s\S]*M2/);
  assert.equal(notifiedOf(env).K1, 1);
  // same slot again (repeated / overlapping tick) → nothing
  assert.equal(await scheduledSummary(env, kst('2026-11-17', '08:50'), { fetcher }), null);
  kv = await kvAll(env.DB);
  assert.deepEqual(kv['notify:sent'], { '08:40': '2026-11-17' });
});

test('scheduledSummary: CAS guard against overlapping ticks; failed send releases the slot', async () => {
  const { env, sent, fetcher } = tgEnv();
  const now = kst('2026-11-16', '08:40');
  const [a, b] = await Promise.all([scheduledSummary(env, now, { fetcher }), scheduledSummary(env, now, { fetcher })]);
  assert.equal([a, b].filter(Boolean).length, 1, 'only one tick claims the slot');
  await (a || b);
  assert.equal(sent.length, 1);
  // failure path
  const bad = tgEnv();
  const failing = async () => new Response('x', { status: 502 });
  const r = await (await scheduledSummary(bad.env, now, { fetcher: failing }));
  assert.equal(r.ok, false);
  const again = await scheduledSummary(bad.env, now + 600, { fetcher: bad.fetcher });
  assert.ok(again, 'released claim → retried on the next tick');
  assert.equal((await again).ok, true);
  // legacy guard: old worker already sent today's 08:40 summary
  const leg = tgEnv();
  await leg.env.DB.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('summary:last', '2026-11-15', 0)").run();
  assert.equal(await scheduledSummary(leg.env, now, { fetcher: leg.fetcher }), null, 'no double summary right after the upgrade');
  // no Telegram: nothing claimed
  const none = { DB: makeD1() };
  assert.equal(await scheduledSummary(none, now), null);
});

test('data errors in 즉시 mode create one event per newly failing source', async () => {
  const { env, sent, fetcher } = tgEnv();
  await kvSetStmt(env.DB, 'notify:settings', { ...N.DEFAULTS, events: { ...N.DEFAULTS.events, data: 'instant' } }).run();
  env.DB.raw.prepare("INSERT INTO data_health (source, last_ok, last_err, err, ok_count, err_count) VALUES ('upbit:1h', 10, 20, 'timeout', 1, 1), ('naver', 30, 20, 'x', 1, 1)").run();
  let kv = await kvAll(env.DB);
  await notifyPending(env, { fetcher, kv, now: kst('2026-11-16', '12:00') });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /데이터 오류: upbit:1h — timeout/);
  kv = await kvAll(env.DB);
  await notifyPending(env, { fetcher, kv, now: kst('2026-11-16', '12:10') });
  assert.equal(sent.length, 1, 'still failing → no repeat');
});

test('settings API: owner-only, same-origin, JSON only, validated', async () => {
  const { env } = tgEnv();
  const ctx = { waitUntil() {} };
  const body = JSON.stringify({ settings: { summaryTimes: ['08:40', '16:00'], summaryDays: 'weekdays', events: { lifecycle: 'instant', crypto: 'summary', data: 'off' }, quiet: { enabled: true, start: '23:00', end: '07:00' } } });
  const post = (headers, b = body) => worker.fetch(new Request('https://x/api/notify/settings', { method: 'POST', headers, body: b }), env, ctx);
  assert.equal((await post({ 'content-type': 'application/json' })).status, 401, 'login required');
  const login = await worker.fetch(new Request('https://x/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) }), env, ctx);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post({ cookie, 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ cookie, 'content-type': 'text/plain', origin: 'https://x' })).status, 400, 'simple (form-like) content type refused');
  const bad = await post({ cookie, 'content-type': 'application/json', origin: 'https://x' }, JSON.stringify({ settings: { ...JSON.parse(body).settings, summaryTimes: ['08:41'] } }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /10분 단위/);
  const ok = await post({ cookie, 'content-type': 'application/json', origin: 'https://x' });
  assert.equal(ok.status, 200);
  const st = await (await worker.fetch(new Request('https://x/api/notify/settings', { headers: { cookie } }), env, ctx)).json();
  assert.deepEqual(st.settings.summaryTimes, ['08:40', '16:00']);
  assert.equal(st.settings.events.crypto, 'summary');
  assert.equal(st.telegram, true);
  assert.equal(sameOrigin(new Request('https://x/a', { method: 'POST' })), true, 'non-browser client without Origin');
});

test('overview cache: freshness rules, served as-is on hit, rebuilt when dirty and older than the TTL', async () => {
  assert.equal(cacheFresh({ cacheAt: 1000, dirtyAt: 0, now: 1000 + 500 }), true);
  assert.equal(cacheFresh({ cacheAt: 1000, dirtyAt: 0, now: 1000 + CACHE_MAX_AGE }), false, 'hard max age');
  assert.equal(cacheFresh({ cacheAt: 1000, dirtyAt: 1100, now: 1000 + CACHE_TTL_DIRTY - 1 }), true, 'dirty but within TTL');
  assert.equal(cacheFresh({ cacheAt: 1000, dirtyAt: 1100, now: 1000 + CACHE_TTL_DIRTY + 1 }), false);
  assert.equal(cacheFresh({ cacheAt: 1200, dirtyAt: 1100, now: 1300 }), true, 'tick rebuilt after the change');
  assert.equal(cacheFresh({ cacheAt: null, now: 1 }), false);
  const env = { DB: makeD1() };
  const a = await overviewCached(env, 5000);
  assert.equal(a.hit, false);
  assert.equal(JSON.parse(a.text).cachedAt, 5000);
  const b = await overviewCached(env, 5030);
  assert.equal(b.hit, true);
  assert.equal(b.text, a.text);
  assert.ok(!('overview:cache' in (await kvAll(env.DB))), 'jobs never load the cached blob');
  await kvSetStmt(env.DB, 'overview:dirty', 5100).run();
  assert.equal((await overviewCached(env, 5100 + CACHE_TTL_DIRTY)).hit, false);
});
