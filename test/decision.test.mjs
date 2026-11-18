// 자동 결정: 시스템이 전략·배수·쉬기를 미리 정한 기준으로 정하고, 결론을 쉬운 말 한 줄로 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, selectionChecks, autoLeverage, exclusion, weeklyText, weeklyDue, nextWeeklyCheck, paperRiskMatched, DISCLAIMER } from '../src/core/decision.js';
import { PRINCIPLES } from '../src/core/principles.js';
import { makeD1 } from './helpers.mjs';
import { weeklyDecisionTask } from '../src/jobs/tick.js';
import { eventRoute, parseSettings } from '../src/core/notify-schedule.js';

const NOW = Date.UTC(2026, 10, 18, 6, 0) / 1000; // 2026-11-18 15:00 KST (Wed)
const DAY = 86400;
const good = (over = {}) => ({
  id: 'etf_voltarget_v1', name: 'E. ETF 변동성 목표 조절 (매월)', market: 'krx', stage: 'live_candidate',
  bt: { dsrLab: 0.6, sharpe: 1.5, mdd: 0.08 },
  paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 13, ret: 0.03, rmRet: 0.02, mdd: 0.04, halted: false }, ...over,
});
const JARGON = /샤프|낙폭|DSR|백테스트|레버리지|리밸런싱|보존 구간/;

test('nothing passes -> plain "not ready" headline, no jargon, next weekly check, disclaimer, user is not asked to judge', () => {
  const facts = [
    good({ id: 'a_v1', name: 'A', stage: 'paper', paper: { startT: NOW - 3 * DAY, days: 3, rebalances: 1, ret: 0, rmRet: 0, mdd: 0, halted: false } }),
    { id: 'krx_bh_v1', name: '기준선', market: 'krx', benchmarkOnly: true, stage: 'benchmark', paper: { startT: NOW - 3 * DAY } },
  ];
  const d = decide(facts, { now: NOW });
  assert.equal(d.verdict, 'not_ready');
  assert.equal(d.headline, '지금은 실제 돈을 넣을 단계가 아니에요.');
  assert.ok(d.reasons.some((r) => r.includes('3일째')));
  assert.ok(d.reasons.some((r) => r.includes('기준을 통과한 전략: 0개')));
  assert.ok(d.reasons.some((r) => r.includes('1/12')));
  assert.equal(d.nextCheck, '2026-11-23'); // next Monday
  assert.equal(d.connect.state, 'not_yet');
  for (const line of [d.headline, ...d.reasons, d.connect.text]) assert.ok(!JARGON.test(line), line);
  assert.equal(d.disclaimer, DISCLAIMER);
  const all = JSON.stringify(d);
  assert.ok(!/판단하세요|보고 판단|직접 판단/.test(all));
  assert.match(weeklyText(d), /다음 점검: 11월 23일/);
});

test('a strategy passing every pre-registered check is selected automatically with a small amount and 1x', () => {
  const d = decide([good()], { now: NOW });
  assert.equal(d.verdict, 'ready');
  assert.match(d.headline, /^E\. ETF 변동성 목표 조절 전략이 기준을 통과했어요\. 소액\(3만 원\)으로 시작해도 되는 단계예요\.$/);
  assert.equal(d.connect.state, 'ok');
  assert.equal(d.selected[0].leverage, 1);
  assert.ok(d.selected[0].leverageCalc >= 1);
  assert.equal(d.changes[0].kind, 'add');
  for (const line of [d.headline, ...d.reasons, d.connect.text]) assert.ok(!JARGON.test(line.replace('레버리지 없이', '')), line);
});

test('each selection criterion is enforced', () => {
  const fail = (over) => decide([good(over)], { now: NOW }).verdict;
  assert.equal(fail({ paper: { ...good().paper, rebalances: 11 } }), 'not_ready');
  assert.equal(fail({ paper: { ...good().paper, ret: 0.01, rmRet: 0.02 } }), 'not_ready');
  assert.equal(fail({ bt: { ...good().bt, dsrLab: 0.3 } }), 'not_ready');
  assert.equal(fail({ paper: { ...good().paper, mdd: 0.12 } }), 'not_ready');
  assert.equal(fail({ paper: { ...good().paper, halted: true } }), 'not_ready');
  assert.equal(fail({ stage: 'paper' }), 'not_ready');
  assert.equal(selectionChecks(good()).length, 6);
});

test('principles: aggressive / simulation / research / no-backtest books are never auto-selected; leverage capped at 1x', () => {
  for (const flag of [{ sleeve: 'aggressive' }, { simulationOnly: true }, { researchOnly: true }, { noBacktest: true }, { benchmarkOnly: true }]) {
    assert.ok(exclusion(good(flag)), JSON.stringify(flag));
    assert.equal(decide([good(flag)], { now: NOW }).verdict, 'not_ready');
  }
  assert.equal(PRINCIPLES.leverage.max, 1);
  const lev = autoLeverage(good({ bt: { ...good().bt, mdd: 0.02 }, paper: { ...good().paper, mdd: 0.01 } }));
  assert.equal(lev.calc, 3); // 10% / (1.5 x 2%) = 3.3 -> 3 (reference only)
  assert.equal(lev.leverage, 1);
});

test('automatic replacement: one per market, removal is recorded with the failed criteria', () => {
  const a = good(), b = good({ id: 'etf_x_v1', name: 'X', bt: { dsrLab: 0.7, sharpe: 2.0, mdd: 0.05 } });
  const c = good({ id: 'crypto_y_v1', name: 'Y', market: 'crypto' });
  const d1 = decide([a, b, c], { now: NOW });
  assert.deepEqual(d1.selected.map((s) => s.id), ['etf_x_v1', 'crypto_y_v1']);
  const d2 = decide([a, good({ ...b, paper: { ...b.paper, mdd: 0.2 } }), c], { now: NOW + DAY, prev: d1 });
  assert.deepEqual(d2.selected.map((s) => s.id).sort(), ['crypto_y_v1', 'etf_voltarget_v1']);
  const rm = d2.changes.find((x) => x.kind === 'remove');
  assert.equal(rm.id, 'etf_x_v1');
  assert.match(rm.text, /자동으로 빠짐.*낙폭/);
  assert.ok(d2.changes.some((x) => x.kind === 'add' && x.id === 'etf_voltarget_v1'));
});

test('weekly schedule: Monday 08:40 KST once; paper risk-matched helper', () => {
  const mon0835 = Date.UTC(2026, 10, 22, 23, 35) / 1000, mon0850 = Date.UTC(2026, 10, 22, 23, 50) / 1000;
  assert.equal(weeklyDue(mon0835, null), false);
  assert.equal(weeklyDue(mon0850, null), true);
  assert.equal(weeklyDue(mon0850 + 600, mon0850), false);
  assert.equal(weeklyDue(NOW, null), false); // Wednesday
  assert.equal(nextWeeklyCheck(NOW), Date.UTC(2026, 10, 22, 23, 40) / 1000);
  assert.equal(paperRiskMatched([{ equity: 100, invested: 50, bench: 100 }, { equity: 100, invested: 50, bench: 110 }]), 0.05);
});

test('weekly task queues one plain-language Telegram event routed as a lifecycle message', async () => {
  const DB = makeD1();
  const kv = { 'decision:current': decide([], { now: NOW }) };
  const mon = Date.UTC(2026, 10, 22, 23, 50) / 1000;
  assert.equal(await weeklyDecisionTask({ DB }, kv, mon), true);
  assert.equal(await weeklyDecisionTask({ DB }, kv, mon + 600), false);
  const ev = DB.raw.prepare("SELECT kind, message FROM events").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'decision_weekly');
  assert.match(ev[0].message, /^📌 이번 주 결론: 지금은 실제 돈을 넣을 단계가 아니에요\./);
  assert.equal(eventRoute('decision_weekly', { nowSec: mon, settings: parseSettings(null) }), 'send');
});

test('full lifecycle pass stores the automatic decision (no runs yet -> not ready)', async () => {
  const { lifecycleTask } = await import('../src/jobs/lifecycle.js');
  const DB = makeD1();
  const kv = {};
  await lifecycleTask({ DB }, kv, NOW);
  const row = DB.raw.prepare("SELECT v FROM kv WHERE k = 'decision:current'").get();
  const d = JSON.parse(row.v);
  assert.equal(d.verdict, 'not_ready');
  assert.ok(d.excluded.some((x) => x.id === 'btc_perp_lev3_v1' && /시뮬레이션/.test(x.why)));
  assert.ok(d.excluded.some((x) => x.id === 'alt_mom_v1' && /고위험/.test(x.why)));
});
