// #F-007 ② (2026-11-24): 공개(판정 통과) 후보는 변형 전례대로 자동 선발 대상.
// (a) 선발 관문이 변형과 똑같은 기준으로 적용됨 (b) 처음 선발되면 '새 후보 <id> 선발' 한 줄(자동 결정 알림·주간 결론).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { STRATEGIES, variantStrategies, trialsFor } from '../src/strategies/index.js';
import { CANDIDATES, candidateById } from '../src/strategies/candidates.js';
import { evaluateStage, GATE_DEFAULTS } from '../src/core/lifecycle.js';
import { decide, decideAll, exclusion, selectionChecks, markFirstCandidateSelections, newCandidateLines, weeklyText } from '../src/core/decision.js';
import { PRINCIPLES, BOOKS } from '../src/core/principles.js';
import { kvSetStmt } from '../src/db/store.js';
import { weeklyDecisionTask } from '../src/jobs/tick.js';
import { evaluateStrategy, judgeCandidates } from '../backtest/run.mjs';
import { makeBars } from './helpers.mjs';

const DAY = 86400;
const NOW = Date.UTC(2026, 11, 20, 3) / 1000;
const passBt = () => ({ holdout: { totalReturn: 0.2, mdd: 0.05, sharpe: 1.2, trades: 40, bench: { totalReturn: 0.1, mdd: 0.3, sharpe: 0.5 }, riskMatched: { sharpe: 0.6, totalReturn: 0.08, mdd: 0.1, weight: 0.5, n: 2, cash: 'bond' } }, holdout2x: { totalReturn: 0.15 }, wf: null, years: 11.5, totalTrades: 60, dsr: 0.97, trials: 1 });
const paper = (o = {}) => ({ startT: NOW - 90 * DAY, days: 90, rebalances: 13, ret: 0.04, rmRet: 0.02, mdd: 0.03, halted: false, vol: 0.08, ...o });

/** lifecycle.js 와 같은 모양의 사실(facts) 한 줄. */
const factOf = (s, stage, p = paper(), bt = { dsrLab: 0.97, sharpe: 1.2, mdd: 0.05 }) => ({
  id: s.id, name: s.name, market: s.market, cadence: s.cadence, benchmarkOnly: !!s.benchmarkOnly, researchOnly: !!s.researchOnly, simulationOnly: !!s.simulationOnly,
  sleeve: s.sleeve || null, noBacktest: !!s.noBacktest, candidate: !!s.candidate, stage, growthCandidate: !!s.growthCandidate, dynamicLeverage: !!s.dynamicLeverage, bt, paper: p,
});

/** 후보와 같은 시장·주기의 실제 변형(자동 연구가 만드는 것과 같은 경로). */
function variantLike(c) {
  const base = STRATEGIES.find((b) => b.market === c.market && b.cadence === c.cadence && !b.benchmarkOnly && !b.researchOnly && !b.simulationOnly && !b.sleeve && !b.noBacktest && !b.growthCandidate && !b.profile);
  assert.ok(base, `같은 시장·주기의 기준 전략이 있어야 함: ${c.id}`);
  const [v] = variantStrategies([{ id: `${base.family}_v9`, base: base.id, version: 9, params: {}, trials: 3 }]);
  assert.ok(v?.generated, base.id);
  return v;
}

test('F-007 (a): released candidates face exactly the same gates as auto-research variants (G1 stage + selection)', () => {
  for (const c of CANDIDATES) {
    const v = variantLike(c);
    // 선발에서 빼는 표시(연구·비교용 등)가 후보에도 변형에도 없음
    for (const k of ['benchmarkOnly', 'researchOnly', 'simulationOnly', 'noBacktest', 'growthCandidate', 'sleeve', 'noRiskMatched']) assert.equal(!!c[k], !!v[k], `${c.id}.${k}`);
    // G1(과거 검증·모의·운영 점검 단계): 같은 증거 → 같은 단계·같은 검사 줄
    for (const [bt, p] of [[passBt(), null], [passBt(), { days: 90, rebalances: 13, totalReturn: 0.04, mdd: 0.03, agreement: { matched: 20, total: 20 } }], [{ ...passBt(), years: 9 }, null], [{ ...passBt(), dsr: 0.5 }, null]]) {
      const a = evaluateStage({ strategy: c, bt, paper: p, gates: GATE_DEFAULTS });
      const b = evaluateStage({ strategy: v, bt, paper: p, gates: GATE_DEFAULTS });
      assert.equal(a.stage, b.stage, `${c.id} stage`);
      assert.deepEqual(a.checks.map((x) => [x.ok, x.text]), b.checks.map((x) => [x.ok, x.text]), `${c.id} checks`);
    }
    // 자동 선발(안전·공격 장부 모두): 같은 사실 → 같은 제외 여부·같은 검사
    for (const P of [PRINCIPLES, BOOKS.safe.P, BOOKS.growth.P]) {
      for (const stage of ['live_candidate', 'paper', 'backtest']) {
        const fc = factOf(c, stage), fv = factOf(v, stage);
        assert.equal(exclusion(fc, P), exclusion(fv, P), `${c.id} exclusion ${stage}`);
        assert.deepEqual(selectionChecks(fc, P), selectionChecks(fv, P), `${c.id} checks ${stage}`);
      }
    }
    assert.equal(exclusion(factOf(c, 'live_candidate')), null, `${c.id}: 연구·비교용으로 빠지지 않음`);
  }
});

test('F-007 (a): with identical numbers a candidate is selected exactly when the variant would be', () => {
  const c = candidateById.etf_gold_trend_v1, v = variantLike(c);
  const pick = (s, p) => decide([factOf(s, 'live_candidate', p)], { now: NOW }).selected.map((x) => x.id);
  for (const p of [paper(), paper({ rebalances: 3 }), paper({ mdd: 0.5 }), paper({ ret: -0.01 })]) {
    assert.deepEqual(pick(c, p).length, pick(v, p).length, JSON.stringify(p));
  }
  assert.deepEqual(pick(c, paper()), [c.id]);
});

test('F-007 (b): first selection of a candidate gets one "새 후보 <id> 선발" line; never again, variants untouched', () => {
  const isC = (id) => !!candidateById[id];
  const changes = [
    { t: NOW, kind: 'add', id: 'etf_gold_trend_v1', text: 'ETF 금: 기준을 모두 통과해 자동으로 선발됨' },
    { t: NOW, kind: 'add', id: 'etf_gold_trend_v1', book: 'growth', text: '[공격 장부] ETF 금: 기준을 모두 통과해 자동으로 선발됨' },
    { t: NOW, kind: 'add', id: 'krx_momo_v3', text: '변형: 기준을 모두 통과해 자동으로 선발됨' },
    { t: NOW, kind: 'remove', id: 'etf_quality_lowvol_v1', text: '저변동: 빠짐' },
  ];
  const r = markFirstCandidateSelections(changes, {}, isC, NOW);
  assert.deepEqual(r.fresh, ['etf_gold_trend_v1']);
  assert.deepEqual(r.firstSelected, { etf_gold_trend_v1: NOW });
  assert.match(r.changes[0].text, /^🧪 새 후보 etf_gold_trend_v1 선발 — /);
  assert.match(r.changes[1].text, /^🧪 새 후보 etf_gold_trend_v1 선발 — \[공격 장부\]/);
  assert.equal(r.changes[2].text, changes[2].text); // 변형은 그대로
  assert.equal(r.changes[3].text, changes[3].text); // 빠짐은 그대로
  assert.equal(changes[0].text, 'ETF 금: 기준을 모두 통과해 자동으로 선발됨'); // 입력은 안 바뀜
  // 빠졌다 다시 들어와도 '새 후보'는 다시 안 붙음
  const again = markFirstCandidateSelections([changes[0]], r.firstSelected, isC, NOW + 7 * DAY);
  assert.deepEqual(again.fresh, []);
  assert.equal(again.changes[0].text, changes[0].text);
  assert.deepEqual(again.firstSelected, { etf_gold_trend_v1: NOW });
  // 주간 결론 줄: 지난 주간 결론 뒤에 처음 선발된 것만
  assert.equal(newCandidateLines(r.firstSelected, NOW - DAY, (id) => candidateById[id].name).length, 1);
  assert.match(newCandidateLines(r.firstSelected, NOW - DAY)[0], /^🧪 새 후보 etf_gold_trend_v1 선발/);
  assert.deepEqual(newCandidateLines(r.firstSelected, NOW), []);
  assert.deepEqual(newCandidateLines(undefined, 0), []);
});

test('F-007 (b): Monday weekly conclusion carries the "새 후보 <id> 선발" line once (not the week after)', async () => {
  const env = { DB: makeD1() };
  const d = decideAll([], { now: NOW });
  const mon = Date.UTC(2026, 11, 21, 0, 0) / 1000; // 12-21(월) 09:00 KST
  const kv = { 'decision:current': d, 'decision:weeklyAt': mon - 7 * DAY, 'candidates:firstSelected': { etf_gold_trend_v1: mon - 2 * DAY } };
  await env.DB.batch([kvSetStmt(env.DB, 'decision:current', d)]);
  assert.equal(await weeklyDecisionTask(env, kv, mon), true);
  const ev = await env.DB.prepare("SELECT message FROM events WHERE kind = 'decision_weekly' ORDER BY id").all();
  const msg = ev.results.at(-1).message;
  assert.ok(msg.startsWith(weeklyText(d)), msg);
  assert.match(msg, /🧪 새 후보 etf_gold_trend_v1 선발 \(/);
  assert.equal((msg.match(/새 후보/g) || []).length, 1);
  assert.equal(await weeklyDecisionTask(env, kv, mon + 7 * DAY), true);
  const ev2 = await env.DB.prepare("SELECT message FROM events WHERE kind = 'decision_weekly' ORDER BY id").all();
  assert.ok(!ev2.results.at(-1).message.includes('새 후보'), ev2.results.at(-1).message);
});

test('F-007 (b): the weekly message never repeats the line when the latest pass already printed it (safe + growth)', async () => {
  const env = { DB: makeD1() };
  const mon = Date.UTC(2026, 11, 21, 0, 0) / 1000;
  const base = decideAll([], { now: mon - 3600 });
  const fc = markFirstCandidateSelections([
    { t: mon - 3600, kind: 'add', id: 'etf_gold_trend_v1', text: 'ETF 금: 기준을 모두 통과해 자동으로 선발됨' },
    { t: mon - 3600, kind: 'add', id: 'etf_gold_trend_v1', book: 'growth', text: '[공격 장부] ETF 금: 기준을 모두 통과해 자동으로 선발됨' },
  ], {}, (id) => !!candidateById[id], mon - 3600);
  const d = { ...base, changes: fc.changes };
  const kv = { 'decision:current': d, 'decision:weeklyAt': mon - 7 * DAY, 'candidates:firstSelected': fc.firstSelected };
  assert.equal(await weeklyDecisionTask(env, kv, mon), true);
  const msg = (await env.DB.prepare("SELECT message FROM events WHERE kind = 'decision_weekly' ORDER BY id").all()).results.at(-1).message;
  assert.equal((msg.match(/새 후보 etf_gold_trend_v1 선발/g) || []).length, 2, msg); // 본문의 안전·공격 장부 두 줄뿐, 덧붙인 줄 없음
  assert.ok(!msg.includes('사전 등록 후보가 처음으로'), msg);
});

test('F-007 (a): the research runner computes the lab-wide trial correction (dsrLab) for a candidate exactly as for a variant', () => {
  const c = candidateById.etf_gold_trend_v1;
  const krx = Object.fromEntries(c.universe.map((x, i) => [x, makeBars({ start: '2014-08-29', n: 3000, seed: 80 + i, skipNonKrx: true, drift: 0.0003, vol: 0.01, p0: 10000 + i * 500 })]));
  const data = { krx, krxRaw: krx, crypto1d: {}, crypto1h: {}, source: 'test' };
  // 실제 파이프라인 값: 후보는 판정 때 자기 자신 1회(trialsFor(s,[s])), 새 가족의 첫 변형은 기록된 가족 합계 1회 → 둘 다 가족 시도 1
  const asVariant = { ...c, id: 'etf_gold_trend_v9', candidate: false, releaseDate: undefined, generated: true, variantOf: c.id, version: 9, priorTrials: 1 };
  const a = evaluateStrategy(c, data, { extraTrials: trialsFor(c, [c]) }), b = evaluateStrategy(asVariant, data, { extraTrials: 0 });
  assert.equal(a.trials, 1); assert.equal(b.trials, 1);
  assert.ok(a && b);
  assert.ok(Number.isFinite(a.dsrLab) && a.labTrials >= 1, JSON.stringify({ dsrLab: a.dsrLab, labTrials: a.labTrials }));
  for (const k of ['dsr', 'dsrLab', 'labTrials', 'trials', 'luckSharpe']) assert.deepEqual(a[k], b[k], k);
  // 판정이 통과면 Worker로 가는 근거에 dsrLab이 그대로 실림(자동 선발 관문 6번이 읽는 값)
  const far = Date.parse('2026-12-06T05:17:00+09:00') / 1000;
  const j = judgeCandidates([c], {}, far, () => ({ ...a }));
  if (j.ledger[c.id].status === 'released') assert.equal(j.results[c.id].dsrLab, a.dsrLab);
});
