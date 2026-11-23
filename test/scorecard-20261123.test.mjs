// 2026-11-23: 주간 성과표(계획서 2-8 끝난 기준 3). 월요일 08:40에 한 번, 12주 보관, 텔레그램 결론에 두세 줄.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { buildScorecard, appendScorecard, scorecardLines, SCORECARD_WEEKS } from '../src/core/scorecard.js';
import { weeklyScorecardTask, weeklyDecisionTask } from '../src/jobs/tick.js';
import { decide } from '../src/core/decision.js';
import { allStrategies } from '../src/strategies/index.js';

const MON = Date.UTC(2026, 10, 22, 23, 50) / 1000; // 2026-11-23 08:50 KST (Mon)
const WEEK = 7 * 86400;
const JARGON = /샤프|낙폭|DSR|백테스트|레버리지|리밸런싱|보존 구간/;
const run = (id, equity, init = 10_000_000) => ({ id: `${id}:paper`, strategy_id: id, mode: 'paper', state: { equity, initialCash: init, bench: init, halted: false } });

test('scorecard: one row per paper book, week change vs last card, family/bench books tagged', () => {
  const S = allStrategies({});
  const runs = { 'family_self_v1:paper': run('family_self_v1', 101_000, 100_000), 'krx_bh_v1:paper': run('krx_bh_v1', 9_800_000), 'etf_voltarget_v1:paper': run('etf_voltarget_v1', 10_200_000) };
  const c1 = buildScorecard(S, runs, {}, MON);
  assert.equal(c1.rows.length, 3);
  assert.equal(c1.rows[0].id, 'etf_voltarget_v1'); // sorted by return
  assert.equal(c1.rows.find((r) => r.id === 'family_self_v1').book, 'family');
  assert.equal(c1.rows.find((r) => r.id === 'krx_bh_v1').book, 'bench');
  assert.ok(c1.rows.every((r) => r.weekRet === null));
  runs['etf_voltarget_v1:paper'] = run('etf_voltarget_v1', 10_404_000);
  const c2 = buildScorecard(S, runs, {}, MON + WEEK, c1);
  assert.equal(Math.round(c2.rows.find((r) => r.id === 'etf_voltarget_v1').weekRet * 1000) / 1000, 0.02);
  let h = [];
  for (let i = 0; i < SCORECARD_WEEKS + 3; i++) h = appendScorecard(h, { ...c1, week: `w${i}` });
  assert.equal(h.length, SCORECARD_WEEKS);
  assert.equal(appendScorecard([c1], { ...c1, at: 1 }).length, 1); // same week overwrites
});

test('scorecard lines are plain (no jargon, no strategy names except family books)', () => {
  const S = allStrategies({});
  const runs = { 'btc_perp_lev3_v1:paper': run('btc_perp_lev3_v1', 10_400_000), 'family_mother_v1:paper': run('family_mother_v1', 1_000_000, 1_000_000) };
  const L = scorecardLines(buildScorecard(S, runs, {}, MON)).join('\n');
  assert.match(L, /장부 2개의 첫 기록/);
  assert.match(L, /가족 장부\(어머니\) \+0\.0%/);
  assert.doesNotMatch(L, JARGON);
});

test('weekly task: Monday snapshot once, then the weekly conclusion carries the scorecard lines', async () => {
  const DB = makeD1();
  DB.raw.prepare("INSERT INTO runs (id, strategy_id, mode, engine, state, start_after, last_t, updated_at) VALUES ('family_self_v1:paper','family_self_v1','paper','builtin',?,NULL,NULL,0)")
    .run(JSON.stringify({ equity: 100_000, initialCash: 100_000, bench: 100_000, halted: false }));
  const kv = { 'decision:current': decide([], { now: MON }) };
  assert.equal(await weeklyScorecardTask({ DB }, kv, MON), true);
  assert.equal(await weeklyScorecardTask({ DB }, kv, MON + 600), false);
  assert.equal(JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k = 'paper:weekly'").get().v).length, 1);
  assert.equal(await weeklyDecisionTask({ DB }, kv, MON), true);
  const ev = DB.raw.prepare("SELECT message FROM events WHERE kind = 'decision_weekly'").get();
  assert.match(ev.message, /^📌 이번 주 결론:/);
  assert.match(ev.message, /📊 주간 성과표\(가상\): 장부 1개/);
  assert.equal(await weeklyScorecardTask({ DB }, kv, MON + 2 * 86400), false); // Wednesday
});
