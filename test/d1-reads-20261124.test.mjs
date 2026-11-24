// 2026-11-24 #F-010: D1 읽기 계량·문턱. 계정 무료 한도(하루 500만 행)를 이 DB가 혼자 거의 다 쓰던 것(11-24 D 보고 294만).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { meteredDB, mergeReads, readsToday, utcDay, D1_READ_SOFT, D1_READ_HARD } from '../src/db/meter.js';
import { tick, D1_SKIP_SOFT, D1_SKIP_HARD } from '../src/jobs/tick.js';
import { kvSetStmt } from '../src/db/store.js';

const NOW = Date.UTC(2026, 10, 24, 8, 0) / 1000;

function fakeDB() {
  const seen = [];
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: [{ a: 1, b: 2 }, { a: 3 }], meta: { rows_read: 100 } }),
    run: async () => ({ meta: { rows_read: 7, changes: 1 } }),
    raw: async () => [[1]],
  });
  return { seen, prepare: (sql) => stmt(sql), batch: async (stmts) => { for (const s of stmts) seen.push(s); return stmts.map(() => ({ results: [], meta: { rows_read: 5 } })); }, dump: () => 'x' };
}

test('meter: counts meta.rows_read per task for all/run/first/batch; batch gets the original statements', async () => {
  const raw = fakeDB(), c = { total: 0, byTask: {}, cur: 'a' };
  const db = meteredDB(raw, c);
  await db.prepare('SELECT 1').bind(1).all();
  assert.deepEqual(await db.prepare('SELECT 2').first(), { a: 1, b: 2 });
  assert.equal(await db.prepare('SELECT 3').first('a'), 1);
  assert.equal(await db.prepare('SELECT 4').first('zz'), null);
  c.cur = 'b';
  await db.prepare('UPDATE x').run();
  const s1 = db.prepare('INSERT 1').bind(1), s2 = db.prepare('INSERT 2');
  await db.batch([s1, s2]);
  assert.ok(raw.seen.every((s) => typeof s.all === 'function' && !('__proxy' in s)));
  assert.equal(raw.seen[0].sql, 'INSERT 1');
  assert.deepEqual(raw.seen[0].args, [1]);
  assert.deepEqual(c.byTask, { a: 400, b: 17 });
  assert.equal(c.total, 417);
  assert.equal(db.dump(), 'x'); // 나머지는 그대로
  assert.deepEqual(await db.prepare('S').raw(), [[1]]);
});

test('meter: daily total resets at UTC midnight and the previous day goes to history (14 days)', () => {
  const c = { total: 300, byTask: { paper: 200, kvAll: 100 } };
  const a = mergeReads(null, null, c, NOW);
  assert.deepEqual(a.reads, { day: '2026-11-24', total: 300, ticks: 1, byTask: { paper: 200, kvAll: 100 }, at: NOW, warned: null });
  assert.equal(a.hist, null);
  const b = mergeReads(a.reads, null, { total: 50, byTask: { paper: 50 } }, NOW + 600);
  assert.equal(b.reads.total, 350); assert.equal(b.reads.byTask.paper, 250); assert.equal(b.reads.ticks, 2);
  const nextDay = Date.UTC(2026, 10, 25, 0, 5) / 1000;
  const d = mergeReads(b.reads, [], { total: 10, byTask: { kvAll: 10 } }, nextDay);
  assert.equal(d.reads.day, '2026-11-25'); assert.equal(d.reads.total, 10);
  assert.deepEqual(d.hist, [{ day: '2026-11-24', total: 350, ticks: 2, top: { paper: 250, kvAll: 100 } }]);
  assert.equal(readsToday({ 'd1:reads': b.reads }, NOW), 350);
  assert.equal(readsToday({ 'd1:reads': b.reads }, nextDay), 0);
  assert.equal(utcDay(Date.UTC(2026, 10, 24, 23, 59) / 1000), '2026-11-24'); // KST 11-25 08:59도 UTC 날짜로
});

async function tickWith(reads) {
  const DB = makeD1();
  const env = { DB, COLLECT_ENABLED: 'false', FEEDS_ENABLED: 'false' };
  if (reads != null) await DB.batch([kvSetStmt(DB, 'd1:reads', { day: utcDay(NOW), total: reads, ticks: 10, byTask: { paper: reads - 1000, kvAll: 1000 } })]);
  const log = await tick(env, NOW, { fetcher: async () => { throw new Error('no network in test'); } });
  const kv = Object.fromEntries(DB.raw.prepare('SELECT k, v FROM kv').all().map((r) => [r.k, JSON.parse(r.v)]));
  const ev = DB.raw.prepare("SELECT kind, message FROM events WHERE kind = 'self_check'").all();
  return { log, kv, ev, DB, env };
}

test('tick: under the threshold nothing is skipped and the tick records its own reads (d1:reads)', async () => {
  const { kv, ev } = await tickWith(null);
  assert.equal(kv['d1:reads'].day, utcDay(NOW));
  assert.equal(kv['d1:reads'].ticks, 1);
  assert.ok(typeof kv['d1:reads'].total === 'number');
  assert.equal(ev.length, 0);
});

test('tick: over the soft threshold → less urgent work skipped, one Telegram line (instant category), not repeated', async () => {
  assert.deepEqual([...D1_SKIP_SOFT].sort(), ['aidisc', 'cryptoBackfill1d', 'cryptoBackfill1h', 'krxBackfill', 'krxNavBackfill', 'research', 'workerBacktest'].sort());
  assert.ok(D1_SKIP_HARD.includes('lifecycle') && D1_SKIP_HARD.includes('allocate') && !D1_SKIP_HARD.includes('paper') && !D1_SKIP_HARD.includes('notify'));
  const t = await tickWith(D1_READ_SOFT + 10);
  assert.ok(!t.log.some((x) => D1_SKIP_SOFT.some((k) => x.startsWith(k))), JSON.stringify(t.log));
  assert.equal(t.ev.length, 1);
  assert.match(t.ev[0].message, /D1 읽기 오늘\(UTC\) \d+만 행.*덜 급한 일/);
  assert.ok(t.kv['d1:reads'].warned);
  assert.ok(t.kv['d1:reads'].total >= D1_READ_SOFT + 10);
  // 같은 날 다음 틱: 경고 다시 안 함
  await tick(t.env, NOW + 600, { fetcher: async () => { throw new Error('x'); } });
  assert.equal(t.DB.raw.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'self_check'").get().n, 1);
});

test('tick: over the hard threshold the lifecycle pass is skipped too', async () => {
  const t = await tickWith(D1_READ_HARD + 10);
  assert.ok(!t.log.some((x) => x.startsWith('lifecycle') || x.startsWith('allocate')), JSON.stringify(t.log));
  const d1 = t.ev.filter((e) => e.message.includes('D1 읽기'));
  assert.equal(d1.length, 1);
  assert.match(d1[0].message, /평가·배분까지/); // (평가를 쉬면 자기 점검 알림도 따로 날 수 있음 — 정상)
});

test('signals has a (kind, t) index so kind/time lookups do not scan the whole table', () => {
  const DB = makeD1();
  const plan = (sql) => DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  const a = plan("SELECT sym, t, kind, value, note FROM signals WHERE t >= 1 AND t <= 2 AND kind IN ('news_veto', 'ai_score', 'ai_score_disc') ORDER BY t");
  const b = plan("SELECT sym, t, kind, value, note FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp') AND t >= 1 AND t <= 2 ORDER BY t");
  const c = plan("SELECT MAX(t) AS m FROM signals WHERE kind = 'risk_snap' AND t <= 5");
  for (const p of [a, b, c]) { assert.match(p, /signals_kind_t/, p); assert.doesNotMatch(p, /^SCAN signals$|SCAN signals(?! USING)/, p); }
});
