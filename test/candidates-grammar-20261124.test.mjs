// 2026-11-24 #F-009 ③: 규칙 부품 조합 순서표(3차 사전 등록 15개 — 16시 레드팀 반영) — 12-15 뒤 새 후보를 전략 코드를 새로 쓰지 않고 공급.
// 합성 자료·스텁만 쓴다(사전 등록 후보를 실제 시세로 돌리지 않음, P6).
process.env.MOSS_SYNTHETIC = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeD1 } from './helpers.mjs';
import { kvAll } from '../src/db/store.js';
import { importResearch } from '../src/jobs/research-import.js';
import { STRATEGIES, validateStrategy, activeStrategies } from '../src/strategies/index.js';
import { CANDIDATES, GRAMMAR_CANDIDATES, ALL_CANDIDATES, GRAMMAR_ORDER, GRAMMAR_SETS, GRAMMAR_PARTS_SOURCE, candidateById, candidateStrategies, releaseAt } from '../src/strategies/candidates.js';
import { CANDIDATE_ETFS } from '../src/config.js';
import { dueCandidates, labTrialsCount, triedCandidates } from '../backtest/run.mjs';
import { dayT } from '../src/core/calendar.js';
import { monthOf } from '../src/strategies/common.js';

const T0 = dayT('2027-03-22');
const HOLDOUT = new URL('../backtest/holdout.json', import.meta.url), HOLDOUT_BEFORE = readFileSync(HOLDOUT, 'utf8');
const ctxOf = (series, extra = {}) => ({ t: T0, params: extra.params, mem: {}, barIndex: 0, closes: (sym, n) => (series[sym] || []).slice(-n), ...extra });
const ramp = (n, p0, step) => Array.from({ length: n }, (_, i) => p0 + i * step);
const wiggle = (n, p0, amp, step = 0) => Array.from({ length: n }, (_, i) => p0 + i * step + (i % 2 ? amp : -amp));
const withNow = (sec, fn) => { const real = Date.now; Date.now = () => sec * 1000; return Promise.resolve().then(fn).finally(() => { Date.now = real; }); };

test('grammar queue: exactly the registered 15 (order, ids, dates every 2 weeks from 2027-03-20), valid, outside STRATEGIES', () => {
  assert.equal(GRAMMAR_CANDIDATES.length, 15);
  assert.deepEqual(GRAMMAR_CANDIDATES.map((s) => [s.id, s.releaseDate]), [
    ['gen_trend_stockgold_v1', '2027-03-20'], ['gen_mom_lowvoldiv_v1', '2027-04-03'], ['gen_ivol_kdevgold_v1', '2027-04-17'], ['gen_mom_stockbond_v1', '2027-05-01'],
    ['gen_ivol_stockgold_v1', '2027-05-15'], ['gen_trend_lowvoldiv_v1', '2027-05-29'], ['gen_mom_kdevbg4_v1', '2027-06-12'], ['gen_trend_sbg3_v1', '2027-06-26'],
    ['gen_ivol_stockbond_v1', '2027-07-10'], ['gen_ivol_lowvoldiv_v1', '2027-07-24'], ['gen_trend_kdevgold_v1', '2027-08-07'], ['gen_ivol_kdevbg4_v1', '2027-08-21'],
    ['gen_mom_stockgold_v1', '2027-09-04'], ['gen_mom_kdevgold_v1', '2027-09-18'], ['gen_trend_kdevbg4_v1', '2027-10-02']]);
  assert.ok(releaseAt(GRAMMAR_CANDIDATES[0]) > Math.max(...CANDIDATES.map(releaseAt))); // 앞 대기열 다음부터
  assert.equal(new Set(ALL_CANDIDATES.map((s) => s.id)).size, 23);
  assert.equal(new Set(ALL_CANDIDATES.map((s) => s.family)).size, 23);
  for (const s of GRAMMAR_CANDIDATES) {
    assert.deepEqual(validateStrategy(s), [], s.id);
    assert.ok(!STRATEGIES.some((x) => x.id === s.id || x.family === s.family), s.id);
    assert.equal(candidateById[s.id], s);
    assert.equal(s.cadence, 'slow');
    assert.ok(s.candidate && !s.researchOnly);
    assert.deepEqual(s.params, { sma: 200, momN: 126, volN: 60, total: 0.6, cap: 0.3 });
    assert.deepEqual(s.universe, [...GRAMMAR_SETS[s.grammar.set], '153130']);
    assert.ok(!s.universe.includes('279530') && !s.universe.includes('379800'), s.id); // 10년 안 되는 종목은 안 씀
    // 기준 종목 = 묶음에서 자료가 가장 짧은 종목(10년 관문이 그 종목으로 재짐): 251350이 있으면 251350
    assert.equal(s.benchSym, s.universe.includes('251350') ? '251350' : s.universe[0], s.id);
  }
  const keys = new Set(GRAMMAR_ORDER.map(([m, s]) => `${m}:${s}`));
  assert.equal(keys.size, 15);
  for (const out of ['trend:stockbond', 'ivol:sbg3', 'mom:sbg3']) assert.ok(!keys.has(out), out); // 앞 후보와 같은 자산·비슷한 생각이라 뺀 조합
  assert.ok(![...keys].some((k) => k.startsWith('fixq:'))); // 고정 비율 부품은 뺐음(거래 수 관문을 구조적으로 못 채움)
  assert.throws(() => { GRAMMAR_SETS.stockgold.push('x'); }); // 안쪽 배열까지 얼림
  assert.throws(() => { GRAMMAR_ORDER[0][1] = 'x'; });
});

test('grammar queue fingerprint: the order, symbol sets, numbers and the building-block code are frozen (change = new v2)', () => {
  // 이 값이 바뀌면 사전 등록이 바뀐 것: 공개 전이어도 고치지 말고 새 이름(v2)·새 시도로 등록한다(PREREG '3차').
  assert.equal(createHash('sha256').update(GRAMMAR_PARTS_SOURCE.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16), 'edefe6e33f98988a');
});

test('grammar rules on synthetic data: only own symbols, each ≤ 30%, invested ≤ 60% + bonds ≤ 30%', () => {
  const up = (n) => ramp(n, 100, 1), down = (n) => ramp(n, 400, -1);
  const shapes = [up, down, (n) => wiggle(n, 100, 3, 0.2), (n) => wiggle(n, 300, 1, -0.3)];
  for (const s of GRAMMAR_CANDIDATES) {
    for (let k = 0; k < 6; k++) {
      const series = { '153130': ramp(300, 100, 0.01) };
      for (const [j, sym] of GRAMMAR_SETS[s.grammar.set].entries()) series[sym] = shapes[(j + k) % shapes.length](300);
      const d = s.decide(ctxOf(series, { params: s.params }));
      assert.ok(d, s.id);
      const t = d.targets;
      for (const [sym, w] of Object.entries(t)) { assert.ok(s.universe.includes(sym), `${s.id} ${sym}`); assert.ok(w > 0 && w <= 0.30 + 1e-9, `${s.id} ${sym} ${w}`); }
      const inv = Object.entries(t).filter(([x]) => x !== '153130').reduce((a, [, w]) => a + w, 0);
      assert.ok(inv <= 0.60 + 1e-9, `${s.id} ${inv}`);
    }
  }
});

test('grammar rules: monthly rebalancing; missing data never borrows from other symbols', () => {
  const tr = candidateById.gen_trend_stockgold_v1;
  const full = { '069500': ramp(300, 100, 1), '132030': ramp(300, 100, 1), '153130': ramp(300, 100, 0.01) };
  const mo = monthOf(T0);
  assert.equal(tr.decide(ctxOf(full, { params: tr.params, mem: { month: mo }, barIndex: 5 })), null); // 같은 달 → 안 함
  assert.ok(tr.decide(ctxOf(full, { params: tr.params, mem: { month: mo - 1 }, barIndex: 5 })));
  assert.deepEqual(tr.decide(ctxOf(full, { params: tr.params })).targets, { '069500': 0.30, '132030': 0.30 }); // 둘 다 위 → 채권 안 듦
  const { '132030': _, ...noGold } = full;
  assert.deepEqual(tr.decide(ctxOf(noGold, { params: tr.params })).targets, { '069500': 0.30, '153130': 0.30 }); // 자료 없는 몫만 채권
  const t4 = candidateById.gen_trend_kdevbg4_v1;
  const s4 = Object.fromEntries([...t4.universe].map((x) => [x, ramp(300, 100, x === '153130' ? 0.01 : 1)]));
  assert.deepEqual(t4.decide(ctxOf(s4, { params: t4.params })).targets, { '069500': 0.15, '251350': 0.15, '148070': 0.15, '132030': 0.15 });
});

test('grammar rules: momentum picks the top performers that beat bonds; inverse-vol keeps only symbols above the 200-day average', () => {
  const m = candidateById.gen_mom_lowvoldiv_v1; // 3종목 → 상위 2개, 각 30%
  const bond = ramp(300, 100, 0.01);
  const t1 = m.decide(ctxOf({ '174350': ramp(300, 100, 1), '161510': ramp(300, 100, 0.5), '148070': ramp(300, 100, 0.001), '153130': bond }, { params: m.params })).targets;
  assert.deepEqual(t1, { '174350': 0.30, '161510': 0.30 });
  const t2 = m.decide(ctxOf({ '174350': ramp(300, 100, 1), '161510': ramp(300, 400, -1), '148070': ramp(300, 300, -0.5), '153130': bond }, { params: m.params })).targets;
  assert.deepEqual(t2, { '174350': 0.30, '153130': 0.30 }); // 2위가 단기채권보다 못함 → 그 몫 채권
  const m2 = candidateById.gen_mom_stockbond_v1; // 2종목 → 1개, 쉬는 몫은 다른 부품처럼 단기채권(합계 60%까지)
  assert.deepEqual(m2.decide(ctxOf({ '069500': ramp(300, 100, 1), '148070': ramp(300, 100, 0.5), '153130': bond }, { params: m2.params })).targets, { '069500': 0.30, '153130': 0.30 });
  assert.deepEqual(m2.decide(ctxOf({ '069500': ramp(300, 400, -1), '148070': ramp(300, 300, -0.5), '153130': bond }, { params: m2.params })).targets, { '153130': 0.30 });
  const v = candidateById.gen_ivol_stockgold_v1;
  const tv = v.decide(ctxOf({ '069500': wiggle(300, 100, 2, 0.5), '132030': ramp(300, 400, -1), '153130': bond }, { params: v.params })).targets;
  assert.ok(!('132030' in tv)); // 200일 평균 아래 → 안 삼
  assert.ok(tv['069500'] <= 0.30 + 1e-9 && tv['153130'] >= 0.29, JSON.stringify(tv));
});

test('worker import: with more than 10 released candidates over time, every one gets registered (cumulative list)', async () => {
  const env = { DB: makeD1() };
  const all = ALL_CANDIDATES.slice(0, 14);
  for (let i = 1; i <= all.length; i++) {
    const body = { candidates: all.slice(0, i).map((s) => ({ id: s.id, releasedAt: releaseAt(s) })) }; // 실행기는 누적으로 보냄
    await withNow(releaseAt(all[i - 1]) + 86400, () => importResearch(env, body));
  }
  const kv = await kvAll(env.DB);
  assert.deepEqual(kv['candidates:released'].map((c) => c.id).sort(), all.map((s) => s.id).sort());
  // 한 번에 새로 받는 것은 10개까지(나머지는 다음 가져오기에서)
  const env2 = { DB: makeD1() };
  const r = await withNow(releaseAt(all.at(-1)) + 86400, () => importResearch(env2, { candidates: all.map((s) => ({ id: s.id })) }));
  assert.equal(r.candidates, 10);
  const r2 = await withNow(releaseAt(all.at(-1)) + 86400 + 600, () => importResearch(env2, { candidates: all.map((s) => ({ id: s.id })) }));
  assert.equal(r2.candidates, 4);
});

test('grammar queue in the runner: nothing due before 2027-03-20; first one due after; lab trials unchanged until judged', () => {
  const yrs = () => 12, complete = () => true;
  const before = Date.parse('2027-03-14T05:17:00+09:00') / 1000, after = Date.parse('2027-03-21T05:17:00+09:00') / 1000;
  const doneFirst8 = Object.fromEntries(CANDIDATES.map((s) => [s.id, { status: 'rejected', at: 1 }]));
  const d0 = dueCandidates(before, doneFirst8, yrs, 10, complete);
  assert.deepEqual(d0.due, []);
  assert.equal(d0.status.gen_trend_stockgold_v1.status, 'waiting');
  const d1 = dueCandidates(after, doneFirst8, yrs, 10, complete);
  assert.deepEqual(d1.due.map((s) => s.id), ['gen_trend_stockgold_v1']);
  assert.equal(labTrialsCount([...STRATEGIES, ...triedCandidates(doneFirst8)]), labTrialsCount() + 8); // 대기 중인 15개는 시도 수에 없음
  assert.equal(labTrialsCount([...STRATEGIES, ...triedCandidates(doneFirst8), ...d1.due]), labTrialsCount() + 9);
});

test('worker: a released grammar candidate is accepted only after its date and starts like the others; symbols are collected', async () => {
  for (const s of GRAMMAR_CANDIDATES) for (const x of s.universe) assert.ok(['069500', '148070', '132030', '153130'].includes(x) || x in CANDIDATE_ETFS, `${s.id} ${x} 수집 안 됨`);
  const env = { DB: makeD1() };
  const body = { candidates: [{ id: 'gen_trend_stockgold_v1', releasedAt: 1 }], candidateStatus: { gen_trend_stockgold_v1: { status: 'released', at: 1 } } };
  const r0 = await withNow(Date.parse('2027-03-14T05:17:00+09:00') / 1000, () => importResearch(env, body));
  assert.equal(r0.candidates, 0);
  const r1 = await withNow(Date.parse('2027-03-21T05:17:00+09:00') / 1000, () => importResearch(env, body));
  assert.equal(r1.candidates, 1);
  const kv = await kvAll(env.DB);
  assert.deepEqual(candidateStrategies(kv['candidates:released']).map((s) => s.id), ['gen_trend_stockgold_v1']);
  assert.ok(activeStrategies(kv).some((s) => s.id === 'gen_trend_stockgold_v1'));
});

test('these tests leave the frozen holdout file alone (the weekly job commits it)', () => {
  assert.equal(readFileSync(HOLDOUT, 'utf8'), HOLDOUT_BEFORE);
});
