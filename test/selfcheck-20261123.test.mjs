// 2026-11-23 #F-002 ①: 연구실 자기 점검 — 멈춘 것을 텔레그램 한 줄로(새 크론 없이, 같은 문제는 하루 한 번).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { selfCheckProblems, selfCheckTask } from '../src/jobs/selfcheck.js';
import { eventRoute, parseSettings } from '../src/core/notify-schedule.js';

const NOW = Date.UTC(2026, 10, 23, 7, 0) / 1000;
const H = 3600, D = 86400;
const healthy = () => ({ 'decision:current': { verdict: 'not_ready' }, 'lc:at': NOW - H, 'lc:fullAt': NOW - 2 * H, 'lc:fullTry': NOW - 2 * H,
  'decision:weeklyAt': NOW - 2 * D, 'research:lastImport': { at: NOW - 2 * D }, 'ready:crypto:1d': NOW - D, 'ready:krx:1d': NOW - 3 * D });

test('healthy lab -> no problems', () => assert.deepEqual(selfCheckProblems(healthy(), NOW), []));

test('the real 11-18~11-23 state (evaluations ran, no decision ever) is caught', () => {
  // 운영 D1 11-23 16:39 백업과 같은 모양: lc:at만 있고 decision:current·lc:fullAt·lc:fullTry 없음
  const p = selfCheckProblems({ 'lc:at': 1795417823, 'research:lastImport': { at: 1795318823 }, 'ready:crypto:1d': 1795305600, 'ready:krx:1d': 1795132800 }, 1795418000);
  assert.deepEqual(p.map((x) => x.key), ['nodecision']);
});

test('stale full pass / weekly / research / prices are each named', () => {
  const kv = { ...healthy(), 'lc:fullAt': NOW - 50 * H, 'decision:weeklyAt': NOW - 9 * D, 'research:lastImport': { at: NOW - 10 * D }, 'ready:crypto:1d': NOW - 4 * D, 'ready:krx:1d': NOW - 8 * D };
  assert.deepEqual(selfCheckProblems(kv, NOW).map((x) => x.key), ['full', 'weekly', 'research', 'crypto1d', 'krx1d']);
  assert.match(selfCheckProblems(kv, NOW)[0].text, /50시간째/);
});

test('task: one Telegram-routed event, checked every 6h, same problem repeated only after a day', async () => {
  const DB = makeD1();
  const kv = { ...healthy(), 'lc:fullAt': NOW - 50 * H };
  assert.equal(await selfCheckTask({ DB }, kv, NOW), true);
  assert.equal(await selfCheckTask({ DB }, kv, NOW + H), false);          // 6시간 안: 점검 안 함
  assert.equal(await selfCheckTask({ DB }, kv, NOW + 7 * H), false);      // 같은 문제, 하루 안: 다시 안 보냄
  assert.equal(await selfCheckTask({ DB }, kv, NOW + 25 * H), true);      // 하루 지나 아직 그대로: 다시 한 줄
  const ev = DB.raw.prepare("SELECT kind, message FROM events WHERE kind = 'self_check'").all();
  assert.equal(ev.length, 2);
  assert.match(ev[0].message, /^🩺 연구실 자기 점검: 자동 결정\(전체 평가\)이 50시간째/);
  assert.equal(eventRoute('self_check', { nowSec: NOW, settings: parseSettings(null) }), 'send');
  kv['lc:fullAt'] = NOW + 30 * H; // 나아짐
  assert.equal(await selfCheckTask({ DB }, kv, NOW + 32 * H), false);
  assert.deepEqual(kv['selfcheck:sent'], {});
});
