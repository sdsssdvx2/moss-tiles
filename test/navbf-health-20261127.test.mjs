// 2026-11-27 (#F-017 점검표 5번): NAV 과거 채우기가 잘 돌아도 data_health에 성공을 안 적어 데이터 탭에 11-19 오류(✗)만 남았음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { kvAll, kvSetStmt } from '../src/db/store.js';
import { krxNavBackfillTask } from '../src/jobs/collect.js';
import { dayT, kstAt } from '../src/core/calendar.js';

test('NAV backfill records success in data_health (newer than an old error), and still records errors', async () => {
  const db = makeD1();
  const now = kstAt(dayT('2026-11-27'), 7, 30);
  await db.batch([kvSetStmt(db, 'nav:first', dayT('2026-11-16'))]);
  db.raw.prepare("INSERT INTO data_health (source, last_err, err, ok_count, err_count) VALUES ('krx:navbf', ?, 'old', 0, 1)").run(now - 8 * 86400);
  const row = (c, d) => ({ BAS_DD: d, ISU_CD: c, TDD_OPNPRC: '100', TDD_HGPRC: '101', TDD_LWPRC: '99', TDD_CLSPRC: '100', ACC_TRDVOL: '10', NAV: '100.5', ACC_TRDVAL: '1,000', INVSTASST_NETASST_TOTAMT: '5,000' });
  const ok = async (url) => { const d = new URL(url).searchParams.get('basDd'); return Response.json({ OutBlock_1: ['278530', '379800'].map((c) => row(c, d)) }); };
  const env = { DB: db, KRX_AUTH_KEY: 'k' };
  assert.equal(await krxNavBackfillTask(env, await kvAll(db), now, { fetcher: ok }), true);
  const h = db.raw.prepare("SELECT last_ok, last_err, ok_count FROM data_health WHERE source = 'krx:navbf'").get();
  assert.ok(h.last_ok >= h.last_err, 'success is newer than the old error -> dashboard shows ✓');
  assert.equal(h.ok_count, 1);
  const bad = async () => Response.json({ respCode: '401' }, { status: 401 });
  await db.batch([kvSetStmt(db, 'navbf:off', 0)]);
  assert.equal(await krxNavBackfillTask(env, await kvAll(db), now + 60, { fetcher: bad }), false);
  assert.equal(db.raw.prepare("SELECT err_count FROM data_health WHERE source = 'krx:navbf'").get().err_count, 2);
});
