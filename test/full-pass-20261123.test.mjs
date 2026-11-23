// 2026-11-23: 1시간봉 장부가 매시간 바뀌면 부분 평가가 lc:at을 계속 새로 써서, 전체 평가(자동 결정·주간 결론을 만드는 유일한 곳)가
// 한 번도 돌지 않았다(운영 D1에 decision:current 없음, 11-23 월 08:40 주간 결론 0건). 전체 평가 시각을 따로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { lifecycleTask } from '../src/jobs/lifecycle.js';
import { lifecyclePlan } from '../src/jobs/tick.js';
import { healthReport } from '../src/jobs/health.js';

const NOW = Date.UTC(2026, 10, 23, 0, 0) / 1000; // 2026-11-23 09:00 KST (Mon)
const HOUR = 3600;

test('hourly partial passes must not starve the full pass: full pass runs within 6h', async () => {
  const DB = makeD1();
  const kv = {};
  await lifecycleTask({ DB }, kv, NOW); // first full pass
  assert.equal(kv['lc:fullAt'], NOW);
  let full = 0;
  for (let h = 1; h <= 14; h++) {
    const now = NOW + h * HOUR;
    const plan = lifecyclePlan(kv, now, ['crypto_trend1h_v1']); // a 1h book changed every hour
    if (plan === 'full') { full++; kv['lc:fullTry'] = now; await lifecycleTask({ DB }, kv, now); }
    else if (plan === 'partial') await lifecycleTask({ DB }, kv, now, { only: ['crypto_trend1h_v1'] });
  }
  assert.ok(full >= 2, `full passes in 14h with hourly changes: ${full}`);
  assert.ok(DB.raw.prepare("SELECT v FROM kv WHERE k = 'decision:current'").get());
  const fullAt = Number(DB.raw.prepare("SELECT v FROM kv WHERE k = 'lc:fullAt'").get().v);
  assert.ok(fullAt > NOW + 6 * HOUR);
});

test('partial pass updates lc:at but not lc:fullAt', async () => {
  const DB = makeD1();
  const kv = {};
  await lifecycleTask({ DB }, kv, NOW);
  await lifecycleTask({ DB }, kv, NOW + HOUR, { only: ['crypto_trend1h_v1'] });
  assert.equal(kv['lc:at'], NOW + HOUR);
  assert.equal(kv['lc:fullAt'], NOW);
});

test('plan: missing full-pass time -> full; a failed attempt is not retried for 1h (CPU guard)', () => {
  assert.equal(lifecyclePlan({ 'lc:at': NOW }, NOW + 600, ['x']), 'full'); // old deploys: lc:at only
  assert.equal(lifecyclePlan({ 'lc:fullAt': NOW, 'lc:at': NOW }, NOW + 600, ['x']), 'partial');
  assert.equal(lifecyclePlan({ 'lc:fullAt': NOW, 'lc:at': NOW }, NOW + 600, []), 'allocate');
  assert.equal(lifecyclePlan({ 'lc:fullAt': NOW - 7 * HOUR, 'lc:fullTry': NOW - 600 }, NOW, ['x']), 'partial');
  assert.equal(lifecyclePlan({ 'lc:fullAt': NOW - 7 * HOUR, 'lc:fullTry': NOW - 2 * HOUR }, NOW, []), 'full');
});

test('health: a full pass that keeps failing is reported', () => {
  const base = { 'tick:last': { t: NOW, log: [] }, 'lc:at': NOW };
  const ok = healthReport({ ...base, 'lc:fullAt': NOW - HOUR, 'lc:fullTry': NOW - HOUR }, [], NOW);
  assert.equal(ok.checks.fullPassAgeHours, 1);
  assert.ok(!ok.problems.some((p) => p.startsWith('lifecycle:full')));
  const bad = healthReport({ ...base, 'lc:fullAt': NOW - 20 * HOUR, 'lc:fullTry': NOW - HOUR }, [], NOW);
  assert.ok(bad.problems.includes('lifecycle:full:stale:20h'));
  const never = healthReport({ ...base, 'lc:fullTry': NOW - 2 * HOUR }, [], NOW);
  assert.ok(never.problems.includes('lifecycle:full:none'));
});
