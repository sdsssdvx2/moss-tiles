// 2026-11-25 #F-014: 화면 캐시의 평가액 곡선 — 같은 출력을 덜 읽고(기본 키 범위). 예전 쿼리와 곡선 사전이 완전히 같아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { paperCurves } from '../src/api.js';

const DAY = 86400, T0 = 1_794_000_000 - (1_794_000_000 % DAY);
const oldCurves = (DB) => {
  const out = {};
  for (const p of DB.raw.prepare("SELECT run_id, t, equity, bench, invested FROM equity WHERE run_id LIKE '%:paper' AND (t % 86400) = 0 ORDER BY run_id, t").all()) (out[p.run_id] ||= []).push(p);
  return out;
};

test('paperCurves gives exactly the old LIKE query result (daily + hourly paper books, backtest books ignored, >90 books)', async () => {
  const DB = makeD1();
  const ins = DB.raw.prepare('INSERT INTO equity (run_id, t, equity, cash, invested, bench) VALUES (?,?,?,?,?,?)');
  const ids = [];
  for (let r = 0; r < 120; r++) {
    const id = `s${String(r).padStart(3, '0')}_v1:paper`; ids.push(id);
    const hourly = r % 3 === 0;
    for (let k = 0; k < (hourly ? 24 * 5 : 6); k++) ins.run(id, T0 + k * (hourly ? 3600 : DAY), 1e7 + r * 10 + k, 5e6, 5e6, 1e7 - k);
    ins.run(`s${String(r).padStart(3, '0')}_v1:bt`, T0 + r * DAY, 1, 1, 0, 1); // 재검증 장부 — 화면에 안 씀
  }
  const want = oldCurves(DB);
  const got = await paperCurves(DB, [...ids].reverse());
  assert.deepEqual(got, want);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
  for (const id of ids) assert.deepEqual(got[id].map((p) => p.t), [...got[id].map((p) => p.t)].sort((a, b) => a - b)); // 장부마다 시각 순
  const plan = DB.raw.prepare("EXPLAIN QUERY PLAN SELECT run_id, t FROM equity WHERE run_id IN (?, ?) AND (t % 86400) = 0 ORDER BY run_id, t").all().map((r) => r.detail).join(' | ');
  assert.match(plan, /USING (PRIMARY KEY|INDEX)/, plan); // 표 전체가 아니라 기본 키로
  assert.deepEqual(await paperCurves(DB, []), {});
});
