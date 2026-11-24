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

test('tick: over the threshold NOTHING that feeds results is skipped (#F-011) — same log as under it; one Telegram line, not repeated', async () => {
  assert.deepEqual([...D1_SKIP_SOFT], []); // 수집·평가·기록·모의 장부·연구는 어떤 문턱에서도 건너뛰지 않음
  assert.deepEqual([...D1_SKIP_HARD], []);
  const under = await tickWith(null), over = await tickWith(D1_READ_SOFT + 10), hard = await tickWith(D1_READ_HARD + 10);
  assert.deepEqual(over.log, under.log);
  assert.deepEqual(hard.log, under.log);
  const d1 = (t) => t.ev.filter((e) => e.message.includes('D1 읽기'));
  assert.equal(d1(over).length, 1);
  assert.match(d1(over)[0].message, /D1 읽기 오늘\(UTC\) \d+만 행.*화면용 캐시.*수집·평가·모의 장부는 그대로/);
  assert.ok(over.kv['d1:reads'].warned);
  assert.ok(over.kv['d1:reads'].total >= D1_READ_SOFT + 10);
  await tick(over.env, NOW + 600, { fetcher: async () => { throw new Error('x'); } }); // 같은 날 다음 틱: 경고 다시 안 함
  assert.equal(over.DB.raw.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'self_check' AND message LIKE '%D1 읽기%'").get().n, 1);
});

test('scheduled: over the threshold only the dashboard cache rebuild is skipped (marked dirty instead); reads are saved incl. the cache build', async () => {
  const { default: worker } = await import('../src/worker.js');
  const run = async (reads) => {
    const DB = makeD1();
    if (reads != null) await DB.batch([kvSetStmt(DB, 'd1:reads', { day: utcDay(NOW), total: reads, ticks: 10, byTask: {} })]);
    const env = { DB, COLLECT_ENABLED: 'false', FEEDS_ENABLED: 'false' };
    await worker.scheduled({ scheduledTime: NOW * 1000 }, env, { waitUntil: () => {} }); // 첫 틱은 전체 평가(무거움) → 원래도 캐시 안 만듦
    DB.raw.prepare("DELETE FROM kv WHERE k IN ('overview:cache', 'overview:dirty')").run();
    await worker.scheduled({ scheduledTime: (NOW + 600) * 1000 }, env, { waitUntil: () => {} }); // 가벼운 틱
    const kv = Object.fromEntries(DB.raw.prepare('SELECT k, v FROM kv').all().map((r) => [r.k, r.v]));
    return kv;
  };
  const under = await run(null), over = await run(D1_READ_SOFT + 10);
  assert.ok(under['overview:cache'] && !under['overview:dirty'], Object.keys(under).join(','));
  assert.ok(!over['overview:cache'] && over['overview:dirty'], Object.keys(over).join(','));
  assert.equal(JSON.parse(under['d1:reads']).ticks, 2);
  assert.equal(JSON.parse(over['d1:reads']).ticks, 12);
});

test('signals has a (kind, t) index so kind/time lookups do not scan the whole table', () => {
  const DB = makeD1();
  const plan = (sql) => DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  const a = plan("SELECT sym, t, kind, value, note FROM signals WHERE t >= 1 AND t <= 2 AND kind IN ('news_veto', 'ai_score', 'ai_score_disc') ORDER BY t");
  const b = plan("SELECT sym, t, kind, value, note FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp') AND t >= 1 AND t <= 2 ORDER BY t");
  const c = plan("SELECT MAX(t) AS m FROM signals WHERE kind = 'risk_snap' AND t <= 5");
  for (const p of [a, b, c]) { assert.match(p, /signals_kind_t/, p); assert.doesNotMatch(p, /^SCAN signals$|SCAN signals(?! USING)/, p); }
});
