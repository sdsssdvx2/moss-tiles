// 2026-11-18 밤: 가족 구성원·금액 편집, 기준 페이지·변경 이력, 안전/공격 장부, 읽기 전용 질문, AI 성적표·교차 판단, 세계 지표.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeD1, makeBars } from './helpers.mjs';
import { applyMemberOp, defaultMembers, membersView, memberBookIndex, MemberError } from '../src/core/members.js';
import { allStrategies, activeStrategies, strategyById, validateStrategy, STRATEGIES } from '../src/strategies/index.js';
import { familyMotherV1 } from '../src/strategies/family.js';
import { paperTask } from '../src/jobs/paper.js';
import { lifecycleTask, annualVol } from '../src/jobs/lifecycle.js';
import { candleStmts, kvSetStmt, kvAll, getRuns } from '../src/db/store.js';
import { criteriaView, criteriaChange, criteriaValues, hashOf, diffCriteria } from '../src/core/criteria.js';
import { mergeGates } from '../src/core/lifecycle.js';
import { decide, decideAll, chooseBook, exclusion, autoLeverage, weeklyText } from '../src/core/decision.js';
import { PRINCIPLES, GROWTH_PRINCIPLES, CRITERIA_VERSION, CRITERIA_HISTORY } from '../src/core/principles.js';
import { ask, ruleAnswer, askContext, cleanQuestion, askPrompt } from '../src/jobs/ask.js';
import { scoreJudgments, calibrationLines, scorecardTask } from '../src/jobs/ai-scorecard.js';
import { crossShrink, buildPrompt, aiTask } from '../src/jobs/ai.js';
import { parseYahooChart, macroItem, MACRO_SERIES, FEEDS } from '../src/data/feeds.js';
import { volTargetLeverage, drawdownGovernor, btcPerpVolTargetV1, cryptoTrendGrowthV1 } from '../src/strategies/growth-20261118.js';
import { createFutState, stepFutures, FUT_HARD_MAX_LEVERAGE } from '../src/core/futures-sim.js';
import { Feed } from '../src/core/engine.js';
import { overview, exportSignals } from '../src/api.js';
import { dashboardHtml } from '../src/ui/dashboard.js';
import worker from '../src/worker.js';
import { createSession, sessionCookie } from '../src/auth.js';
import { dayT, DAY } from '../src/core/calendar.js';

const NOW = Date.UTC(2026, 10, 18, 6, 0) / 1000;

// ---------------- 가족 구성원 ----------------
test('members: default = the two books moved from the PC bot; add / rename / change amount / remove keep old books as records', () => {
  let st = defaultMembers();
  assert.deepEqual(membersView(st).members.map((m) => [m.label, m.budgetKrw, m.bookId]), [['본인', 100_000, 'family_self_v1'], ['어머니', 1_000_000, 'family_mother_v1']]);
  // 이름만 바꾸면 장부는 그대로
  let r = applyMemberOp(st, { type: 'update', key: 'mother', label: '엄마' }, NOW); st = r.state;
  assert.equal(membersView(st).members[1].bookId, 'family_mother_v1');
  assert.match(r.entry.text, /이름 어머니 → 엄마/);
  // 금액을 바꾸면 새 장부(v2)가 생기고 이전 장부는 종료(기록 유지)
  r = applyMemberOp(st, { type: 'update', key: 'mother', budgetKrw: 3_000_000 }, NOW + 10); st = r.state;
  const v = membersView(st);
  assert.equal(v.members[1].bookId, 'family_mother_v2'); assert.equal(v.members[1].budgetKrw, 3_000_000);
  assert.deepEqual(v.past.map((b) => [b.bookId, b.budgetKrw, b.to]), [['family_mother_v1', 1_000_000, NOW + 10]]);
  assert.match(r.entry.text, /100만 원 → 300만 원/);
  // 추가: 성향을 고르지 않으면 '조심'
  r = applyMemberOp(st, { type: 'add', label: '아버지', budgetKrw: 500_000 }, NOW + 20); st = r.state;
  const dad = membersView(st).members[2];
  assert.equal(dad.profile, 'careful'); assert.match(dad.bookId, /^family_m\d+_v1$/);
  // 빼기: 장부 종료, 기록은 남음. 다시 같은 이름으로 넣으면 새 장부
  r = applyMemberOp(st, { type: 'remove', key: dad.key }, NOW + 30); st = r.state;
  assert.equal(membersView(st).members.length, 2);
  assert.ok(memberBookIndex(st)[dad.bookId].closed);
  r = applyMemberOp(st, { type: 'add', label: '아버지', budgetKrw: 500_000 }, NOW + 40); st = r.state;
  assert.notEqual(membersView(st).members[2].bookId, dad.bookId);
  assert.equal(st.log.length, 5);
});

test('members: bad input is refused with a plain message (no partial change)', () => {
  const st = defaultMembers();
  const bad = (op, re) => assert.throws(() => applyMemberOp(st, op, NOW), (e) => e instanceof MemberError && re.test(e.message));
  bad({ type: 'add', label: '', budgetKrw: 100_000 }, /이름/);
  bad({ type: 'add', label: '본인', budgetKrw: 100_000 }, /같은 이름/);
  bad({ type: 'add', label: '동생', budgetKrw: 5_000 }, /1만 원부터/);
  bad({ type: 'add', label: '동생', budgetKrw: 123_456 }, /만 원 단위/);
  bad({ type: 'add', label: '동생', budgetKrw: 'abc' }, /숫자/);
  bad({ type: 'update', key: 'nobody', budgetKrw: 100_000 }, /찾지 못/);
  bad({ type: 'update', key: 'self', budgetKrw: 100_000 }, /바뀐 내용이 없/);
  bad({ type: 'hack' }, /알 수 없는/);
  let s2 = applyMemberOp(st, { type: 'remove', key: 'mother' }, NOW).state;
  assert.throws(() => applyMemberOp(s2, { type: 'remove', key: 'self' }, NOW), /마지막 한 명/);
  // 이름에 섞인 태그·제어 문자는 지운다(화면에 그대로 찍혀도 안전)
  const r = applyMemberOp(st, { type: 'add', label: '<b>동생</b>', budgetKrw: 100_000 }, NOW);
  assert.equal(membersView(r.state).members[2].label, 'b동생/b');
  assert.equal(JSON.stringify(st), JSON.stringify(defaultMembers())); // 입력 상태는 건드리지 않음
});

test('member books: untouched defaults are the very same strategy objects; changes add new valid strategies and close old ones', () => {
  const base = allStrategies({});
  assert.equal(base.length, STRATEGIES.length);
  const m0 = base.find((s) => s.id === 'family_mother_v1');
  assert.equal(m0.decide, familyMotherV1.decide); assert.equal(m0.createState().initialCash, 1_000_000); assert.ok(!m0.closed);
  assert.deepEqual(m0.risk, familyMotherV1.risk);
  let st = applyMemberOp(defaultMembers(), { type: 'update', key: 'mother', budgetKrw: 3_000_000, label: '엄마' }, NOW).state;
  st = applyMemberOp(st, { type: 'add', label: '아버지', budgetKrw: 500_000, profile: 'active' }, NOW).state;
  const kv = { 'family:members': st };
  const all = allStrategies(kv);
  const old = all.find((s) => s.id === 'family_mother_v1'), neu = all.find((s) => s.id === 'family_mother_v2'), dad = all.find((s) => s.memberKey === 'm3');
  assert.ok(old.closed); assert.match(old.name, /엄마.*종료/);
  assert.equal(old.createState().initialCash, 1_000_000); // 지난 장부의 금액·규칙은 그대로(재생 일치)
  assert.equal(neu.createState().initialCash, 3_000_000); assert.equal(neu.risk.minCash, 0.75); assert.equal(neu.risk.maxDrawdownHalt, 0.04);
  assert.equal(dad.createState().initialCash, 500_000); assert.equal(dad.risk.minCash, 0.65); assert.equal(dad.risk.maxDrawdownHalt, 0.06);
  for (const s of [neu, dad]) { assert.deepEqual(validateStrategy(s), []); assert.ok(s.researchOnly && s.memberBook); }
  assert.ok(!activeStrategies(kv).some((s) => s.id === 'family_mother_v1'));
  assert.equal(strategyById(kv, 'family_mother_v2').id, 'family_mother_v2');
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
});

async function seededEnv() {
  const DB = makeD1();
  const env = { DB };
  const stmts = [];
  ['379800', '278530', '153130', '069500', '102110'].forEach((s, i) => stmts.push(...candleStmts(DB, 'krx', '1d', s, makeBars({ start: '2025-01-02', n: 460, seed: 100 + i, skipNonKrx: true, drift: 0.0006, p0: 20000 + i * 1000 }), 'test')));
  for (let i = 0; i < stmts.length; i += 400) await DB.batch(stmts.slice(i, i + 400));
  const { results } = await DB.prepare("SELECT DISTINCT t FROM candles WHERE market = 'krx' ORDER BY t").all();
  return { env, days: results.map((r) => r.t) };
}

test('paper ledger: a changed amount starts a NEW book from the next bar; the closed book stops advancing and keeps its records', async () => {
  const { env, days } = await seededEnv();
  const fam = (kv) => activeStrategies(kv).filter((s) => s.memberBook);
  const n = days.length;
  await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', days[n - 30])]);
  let kv = await kvAll(env.DB);
  await paperTask(env, kv, NOW, { maxSteps: 50, strategies: fam(kv) }); // creates the two default books
  await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', days[n - 20])]);
  kv = await kvAll(env.DB);
  for (let k = 0; k < 6; k++) await paperTask(env, kv, NOW, { maxSteps: 50, strategies: fam(kv) });
  let runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const oldLast = runs['family_mother_v1:paper'].last_t;
  assert.equal(oldLast, days[n - 20]);
  const oldPts = (await env.DB.prepare("SELECT COUNT(*) AS n FROM equity WHERE run_id = 'family_mother_v1:paper'").first()).n;
  assert.ok(oldPts >= 10);
  // 어머니 금액 100만 → 300만
  const { state } = applyMemberOp(kv['family:members'], { type: 'update', key: 'mother', budgetKrw: 3_000_000 }, NOW);
  await env.DB.batch([kvSetStmt(env.DB, 'family:members', state), kvSetStmt(env.DB, 'ready:krx:1d', days[n - 10])]);
  kv = await kvAll(env.DB);
  for (let k = 0; k < 8; k++) await paperTask(env, kv, NOW, { maxSteps: 50, strategies: fam(kv) });
  runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  assert.equal(runs['family_mother_v1:paper'].last_t, oldLast); // 종료된 장부는 더 진행하지 않음
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM equity WHERE run_id = 'family_mother_v1:paper'").first()).n, oldPts); // 기록 그대로
  const neu = runs['family_mother_v2:paper'];
  assert.equal(neu.state.initialCash, 3_000_000);
  assert.equal(neu.start_after, days[n - 10]); // 바꾼 시점 이후 봉부터만(과거 소급 없음)
  assert.equal(runs['family_self_v1:paper'].last_t, days[n - 10]); // 다른 구성원 장부는 영향 없음
  const ev = await env.DB.prepare("SELECT message FROM events WHERE strategy_id = 'family_mother_v2' AND kind = 'start'").first();
  assert.match(ev.message, /3,000,000원/);
  // 평가: 종료 장부는 '종료(구성원 변경)', 결정 후보에서 제외, 신호 내보내기 대상 아님
  const rows = await lifecycleTask(env, kv, NOW);
  const closed = rows.find((r) => r.id === 'family_mother_v1');
  assert.equal(closed.stage, 'retired'); assert.equal(closed.label, '종료(구성원 변경)');
  const kv2 = await kvAll(env.DB);
  assert.ok(!kv2['decision:current'].candidates.some((c) => c.id === 'family_mother_v1'));
  const o = await overview(env, NOW);
  assert.deepEqual(o.members.members.map((m) => m.budgetKrw), [100_000, 3_000_000]);
  assert.ok(o.strategies.find((s) => s.id === 'family_mother_v1').closed);
  assert.ok((await exportSignals(env)).strategies.every((s) => !s.eligibleForLive));
});

// ---------------- 기준 페이지·변경 이력 ----------------
test('criteria: plain-language page has no jargon-only lines, a version, and a stable fingerprint', () => {
  const c = criteriaView();
  assert.equal(c.version, CRITERIA_VERSION);
  assert.equal(CRITERIA_HISTORY[CRITERIA_HISTORY.length - 1].version, CRITERIA_VERSION);
  assert.equal(c.hash, criteriaView().hash);
  assert.match(c.hash, /^[0-9a-f]{8}$/);
  const text = c.plain.flatMap((s) => s.lines).join('\n');
  assert.ok(!/샤프|DSR|리밸런싱|보존 구간|백테스트/.test(text), 'plain page must avoid jargon');
  assert.match(text, /12번 이상/); assert.match(text, /최대 3배/); assert.match(text, /가상 돈/);
  assert.ok(c.plain.some((s) => s.title === '기준이 바뀌면'));
  assert.ok(!/판단하세요|직접 판단|골라 주세요/.test(text));
});

test('criteria change: first record, no entry when unchanged, a before→after entry when a value changes (version stamped on decisions)', () => {
  const g = mergeGates({});
  const a = criteriaChange(null, g, NOW);
  assert.match(a.entry.text, /기록 시작/); assert.equal(a.entry.from, null);
  const b = criteriaChange(a.current, g, NOW + 100);
  assert.equal(b.entry, null); assert.equal(b.current.at, NOW);
  const g2 = mergeGates({ paper: { maxMdd: { krx: 0.12 } } });
  const c = criteriaChange(a.current, g2, NOW + 200);
  assert.ok(c.entry); assert.notEqual(c.current.hash, a.current.hash);
  assert.match(c.entry.text, /paper\.maxMdd\.krx: 0\.1 → 0\.12/);
  assert.deepEqual(diffCriteria({ x: 1, y: 2 }, { x: 1, y: 3, z: 4 }), ['y: 2 → 3', 'z: 새로 생김 → 4']);
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.equal(Object.keys(criteriaValues()).length, Object.keys(criteriaValues(g2)).length);
});

test('lifecycle: criteria fingerprint is logged once, re-logged with the diff when GATES_JSON changes, and announced', async () => {
  const { env, days } = await seededEnv();
  await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', days[days.length - 5])]);
  let kv = await kvAll(env.DB);
  await lifecycleTask(env, kv, NOW);
  kv = await kvAll(env.DB);
  assert.equal(kv['criteria:log'].length, 1);
  assert.equal(kv['decision:current'].criteriaVersion, CRITERIA_VERSION);
  assert.equal(kv['decision:current'].criteriaHash, kv['criteria:current'].hash);
  await lifecycleTask(env, kv, NOW + 6 * 3600);
  assert.equal((await kvAll(env.DB))['criteria:log'].length, 1);
  env.GATES_JSON = JSON.stringify({ backtest: { minSharpe: 0.7 } });
  kv = await kvAll(env.DB);
  await lifecycleTask(env, kv, NOW + 12 * 3600);
  kv = await kvAll(env.DB);
  assert.equal(kv['criteria:log'].length, 2);
  assert.match(kv['criteria:log'][1].text, /bt\.minSharpe: 0\.5 → 0\.7/);
  const ev = await env.DB.prepare("SELECT message FROM events WHERE message LIKE '%판단 기준이 바뀌었어요%'").all();
  assert.equal(ev.results.length, 1);
  const o = await overview(env, NOW + 12 * 3600);
  assert.equal(o.criteria.log.length, 2); assert.ok(o.criteria.plain.length >= 5);
});

// ---------------- 안전 장부 / 공격 장부 ----------------
const good = (over = {}) => ({
  id: 'etf_voltarget_v1', name: 'E. ETF 변동성 목표 조절 (매월)', market: 'krx', stage: 'live_candidate',
  bt: { dsrLab: 0.6, sharpe: 1.5, mdd: 0.08 },
  paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 13, ret: 0.03, rmRet: 0.02, mdd: 0.04, halted: false, vol: 0.08 }, ...over,
});
const growthSpot = (over = {}) => good({ id: 'crypto_trend_growth_v1', name: '공격 장부: 비트·이더 추세 크게(현물, 최대 90%)', market: 'crypto', growthCandidate: true,
  bt: { dsrLab: 0.7, sharpe: 1.2, mdd: 0.2 }, paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 14, ret: 0.18, rmRet: 0.05, mdd: 0.22, halted: false, vol: 0.45 }, ...over });
const sim = (over = {}) => good({ id: 'btc_perp_voltarget_v1', name: '공격 장부: BTC 선물 추세 · 배수 자동 조절 1~3배 (모의 전용·선물 시뮬레이션)', market: 'crypto', stage: 'paper', researchOnly: true, simulationOnly: true, dynamicLeverage: true,
  bt: { dsrLab: 0.8, sharpe: 1.3, mdd: 0.2 }, paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 15, ret: 0.3, rmRet: 0.1, mdd: 0.2, halted: false, vol: 0.5 }, ...over });

test('two books: the safe book never takes growth-only or simulation books and stays at 1x; the growth book may', () => {
  assert.match(exclusion(growthSpot(), PRINCIPLES), /공격 장부 전용/);
  assert.match(exclusion(sim(), PRINCIPLES), /시뮬레이션 전용/);
  assert.equal(exclusion(growthSpot(), GROWTH_PRINCIPLES), null);
  assert.equal(exclusion(sim(), GROWTH_PRINCIPLES), null);
  assert.match(exclusion({ ...good(), closed: true }, GROWTH_PRINCIPLES), /종료/);
  assert.match(exclusion({ ...good(), researchOnly: true }, GROWTH_PRINCIPLES), /연구·비교용/); // AI·가족 장부 등은 어느 쪽에서도 후보 아님
  const d = decide([good(), growthSpot(), sim()], { now: NOW });
  assert.deepEqual(d.selected.map((s) => [s.id, s.leverage]), [['etf_voltarget_v1', 1]]);
});

test('growth leverage: largest multiple inside BOTH the drawdown limit and the volatility target, 0.5 steps, capped at 3x, never below 1x', () => {
  // ETF: 낙폭 4% → 0.20/(1.5×0.04)=3.33, 변동성 8% → 0.15/0.08=1.875 → 1.5배
  assert.deepEqual(autoLeverage(good(), GROWTH_PRINCIPLES).leverage, 1.5);
  // 아주 조용한 장부도 3배를 넘지 못함
  assert.equal(autoLeverage(good({ bt: { mdd: 0.01 }, paper: { mdd: 0.01, vol: 0.02 } }), GROWTH_PRINCIPLES).leverage, 3);
  // 많이 흔들리면 1배
  assert.equal(autoLeverage(growthSpot(), GROWTH_PRINCIPLES).leverage, 1);
  // 숫자가 없으면 1배
  assert.equal(autoLeverage({ market: 'krx', bt: null, paper: null }, GROWTH_PRINCIPLES).leverage, 1);
  // 스스로 배수를 조절하는 장부에는 덧씌우지 않음
  const a = autoLeverage(sim({ paper: { mdd: 0.05, vol: 0.1 }, bt: { mdd: 0.05 } }), GROWTH_PRINCIPLES);
  assert.equal(a.leverage, 1); assert.ok(a.own); assert.ok(a.calc > 1);
  // 안전 장부는 언제나 1배
  assert.equal(autoLeverage(good({ bt: { mdd: 0.01 }, paper: { mdd: 0.01 } }), PRINCIPLES).leverage, 1);
});

test('decideAll: nothing passes → one plain line about both books, verdict unchanged, version stamped', () => {
  const young = { startT: NOW - 3 * DAY, days: 3, rebalances: 1, ret: 0, rmRet: 0, mdd: 0, halted: false };
  const d = decideAll([good({ stage: 'paper', paper: young }), growthSpot({ stage: 'paper', paper: young })], { now: NOW });
  assert.equal(d.verdict, 'not_ready'); assert.equal(d.recommend.book, 'none');
  assert.ok(d.reasons.some((r) => /안전 장부·공격 장부 모두 아직/.test(r)));
  assert.equal(d.books.safe.passedCount, 0); assert.equal(d.books.growth.passedCount, 0);
  assert.equal(d.books.growth.nearest.id.length > 0, true);
  assert.equal(d.criteriaVersion, CRITERIA_VERSION);
  assert.match(weeklyText(d), /안전 장부·공격 장부/);
  assert.ok(!/판단하세요|직접 판단|골라/.test(JSON.stringify(d)));
});

test('decideAll: the recommendation is chosen by numbers, not by the user', () => {
  // (1) 안전만 통과 → 안전
  let d = decideAll([good(), growthSpot({ paper: { ...growthSpot().paper, rebalances: 2 } })], { now: NOW });
  assert.equal(d.recommend.book, 'safe'); assert.equal(d.verdict, 'ready');
  // (2) 둘 다 통과, 공격이 수익도 높고 잃은 폭 대비 수익도 같거나 나음 → 공격 몫을 함께
  d = decideAll([good({ paper: { ...good().paper, ret: 0.03, mdd: 0.04 } }), growthSpot({ paper: { ...growthSpot().paper, ret: 0.25, mdd: 0.2 } })], { now: NOW });
  assert.equal(d.recommend.book, 'growth');
  assert.equal(d.books.growth.selected.find((s) => s.id === 'crypto_trend_growth_v1').leverage, 1);
  // (3) 둘 다 통과지만 공격이 잃은 폭에 비해 못함 → 안전
  d = decideAll([good({ paper: { ...good().paper, ret: 0.05, mdd: 0.02 } }), growthSpot({ paper: { ...growthSpot().paper, ret: 0.06, mdd: 0.25 } })], { now: NOW });
  assert.equal(d.recommend.book, 'safe'); assert.match(d.recommend.text, /낫지 않아요/);
  // (4) 선물 시뮬레이션만 통과 → 실제 돈 연결은 '아직'
  d = decideAll([sim()], { now: NOW });
  assert.equal(d.books.growth.selected[0].simOnly, true);
  assert.equal(d.recommend.book, 'none'); assert.equal(d.verdict, 'not_ready'); assert.equal(d.connect.state, 'not_yet');
  // (5) 공격(현물)만 통과하고 숫자도 좋음 → '공격 장부'임을 밝히고 소액 시작 가능
  d = decideAll([growthSpot()], { now: NOW });
  assert.equal(d.verdict, 'ready'); assert.match(d.headline, /공격 장부/); assert.match(d.connect.text, /빌린 돈 없이/);
  // 공격 장부의 넣고 빼기도 기록에 남는다
  const d2 = decideAll([growthSpot({ paper: { ...growthSpot().paper, mdd: 0.4 } })], { now: NOW + DAY, prev: d });
  assert.ok(d2.changes.some((c) => c.book === 'growth' && c.kind === 'remove' && /\[공격 장부\]/.test(c.text)));
  assert.equal(chooseBook(d2, d2.books.growth ? { ...d2, selected: [], passedCount: 0 } : d2).book, 'none');
});

test('growth strategies: registered, valid, flagged; helper math; dynamic leverage order is honoured and hard-capped at 3x', () => {
  for (const s of [btcPerpVolTargetV1, cryptoTrendGrowthV1]) { assert.deepEqual(validateStrategy(s), []); assert.equal(s.book, 'growth'); assert.ok(STRATEGIES.includes(s)); }
  assert.ok(btcPerpVolTargetV1.simulationOnly && btcPerpVolTargetV1.researchOnly);
  assert.ok(cryptoTrendGrowthV1.growthCandidate && !cryptoTrendGrowthV1.researchOnly);
  assert.equal(cryptoTrendGrowthV1.params.cap, 0.9);
  assert.equal(volTargetLeverage(0.25, { target: 0.4 }), 1.5);
  assert.equal(volTargetLeverage(0.05, { target: 0.4 }), 3);
  assert.equal(volTargetLeverage(0.9, { target: 0.4 }), 1);
  assert.equal(volTargetLeverage(NaN, { target: 0.4 }), 1);
  assert.equal(drawdownGovernor(3, 0.1, { soft: 0.15, hard: 0.25 }), 3);
  assert.equal(drawdownGovernor(3, 0.2, { soft: 0.15, hard: 0.25 }), 1.5);
  assert.equal(drawdownGovernor(1.5, 0.2, { soft: 0.15, hard: 0.25 }), 1);
  assert.equal(drawdownGovernor(3, 0.3, { soft: 0.15, hard: 0.25 }), 0);
  // 주문에 실린 배수(lev)가 포지션에 반영되고, 5배를 요청해도 3배로 잘림
  const bars = makeBars({ start: '2026-01-01', n: 5, p0: 100_000_000, vol: 0.001, drift: 0 });
  const run = (lev) => {
    const st = createFutState(10_000_000);
    st.pending = { action: 'open', side: 1, size: 0.5, lev, reason: 't' };
    const feed = new Feed({ 'KRW-BTC': bars });
    stepFutures(st, bars[0].t, feed, { universe: ['KRW-BTC'], params: { leverage: 3 }, strategy: { timeframe: '1d', decideFutures: () => null } });
    return st.pos;
  };
  assert.equal(run(1.5).lev, 1.5);
  assert.equal(run(5).lev, FUT_HARD_MAX_LEVERAGE);
  assert.ok(Math.abs(run(1.5).qty * run(1.5).entry - 5_000_000 * 1.5) < 5);
  assert.equal(run(undefined).lev, 3); // 배수가 없으면 장부의 고정 배수(예전과 같음)
});

test('growth futures book decides its own multiple from recent volatility and rests after a deep drawdown', () => {
  const p = btcPerpVolTargetV1.params;
  const mk = (vol) => makeBars({ start: '2025-01-01', n: 140, p0: 50_000_000, vol, drift: 0.004, seed: 5 });
  const ctxOf = (bars, over = {}) => ({ params: p, history: (s, n) => bars.slice(-n), position: null, mem: {}, barIndex: 139, equity: 10_000_000, peak: 10_000_000, ...over });
  const up = (bars) => { const b = bars.map((x) => ({ ...x })); const last = b[b.length - 1]; last.c = Math.max(...b.map((x) => x.h)) * 1.05; last.h = last.c; return b; };
  const calm = btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.004))));
  const wild = btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.05))));
  assert.equal(calm.order.action, 'open'); assert.equal(wild.order.action, 'open');
  assert.ok(calm.order.lev > wild.order.lev, `${calm.order.lev} > ${wild.order.lev}`);
  assert.ok(calm.order.lev <= 3 && wild.order.lev >= 1);
  assert.match(calm.order.reason, /배수 [\d.]+배/);
  const half = btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.004)), { equity: 8_000_000, mem: { peak: 10_000_000 } }));
  assert.equal(half.order.lev, Math.max(1, calm.order.lev / 2));
  const rest = btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.004)), { equity: 7_000_000, mem: { peak: 10_000_000 } }));
  assert.equal(rest.order, undefined); assert.equal(rest.mem.restUntil, 139 + p.restBars);
  assert.equal(rest.mem.peak, 7_000_000); // 쉬고 돌아오면 그때 금액이 새 기준(영영 멈추지 않음)
  assert.equal(btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.004)), { equity: 7_000_000, mem: rest.mem, barIndex: 145 })), null);
  const back = btcPerpVolTargetV1.decideFutures(ctxOf(up(mk(0.004)), { equity: 7_000_000, mem: rest.mem, barIndex: 139 + p.restBars }));
  assert.equal(back.order.lev, calm.order.lev);
});

// ---------------- 읽기 전용 질문 ----------------
async function askEnv(extra = {}) {
  const DB = makeD1();
  const env = { DB, ...extra };
  const young = { startT: NOW - 3 * DAY, days: 3, rebalances: 1, ret: 0.01, rmRet: 0, mdd: 0, halted: false };
  const d = decideAll([good({ stage: 'paper', paper: young })], { now: NOW });
  await DB.batch([kvSetStmt(DB, 'decision:current', d),
    DB.prepare('INSERT INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)').bind('KRW-BTC', NOW - 3600, 'ai_score', -0.4, '[추세] 하락 추세')]);
  return env;
}

test('ask: without AI it still answers from stored facts (why not buying / criteria / leverage / members), with the disclaimer', async () => {
  const env = await askEnv();
  const kv = await kvAll(env.DB);
  const a = await ask(env, kv, '왜 지금 안 사?', NOW);
  assert.equal(a.source, 'rule');
  assert.match(a.answer, /지금은 실제 돈을 넣을 단계가 아니에요/); assert.match(a.answer, /1\/12번/); assert.match(a.answer, /투자 조언이 아니며/);
  const ctx = await askContext(env, kv, NOW);
  assert.match(ruleAnswer('기준이 뭐야?', ctx), /12번 이상/);
  const lev = ruleAnswer('레버리지 왜 1배야?', ctx);
  assert.match(lev, /안전 장부: 빌린 돈 없이 1배만/); assert.match(lev, /최대 3배/); assert.match(lev, /실력은 늘지 않아서/);
  assert.match(ruleAnswer('엄마 금액 바꾸고 싶어', ctx), /어머니 100만 원/);
  assert.match(ruleAnswer('AI는 뭘 보고 판단해?', ctx), /비트코인 -0\.40/);
  assert.match(ruleAnswer('기준이 바뀌면 어떻게 돼?', ctx), /다음 평가부터/);
  assert.match(ruleAnswer('ㅁㄴㅇㄹ', ctx), /지금은 실제 돈을 넣을 단계가 아니에요/); // 모르는 질문에도 결론부터
  assert.equal((await ask(env, kv, ' ', NOW)).error, '질문을 적어 주세요.');
  assert.equal(cleanQuestion('a'.repeat(999)).length, 300);
});

test('ask: with AI the model only sees stored facts + rules; answers are audited, rate-limited per day, and read-only', async () => {
  const seen = [];
  const AI = { run: async (model, body) => { seen.push({ model, body }); return { response: '아직 기준을 넘은 전략이 없어서 기다리는 중이에요.' }; } };
  const env = await askEnv({ AI, AI_MODEL: 'm1', ASK_DAILY_MAX: '2' });
  const before = (await env.DB.prepare("SELECT k, v FROM kv WHERE k NOT IN ('ask:quota')").all()).results;
  const kv = await kvAll(env.DB);
  const a = await ask(env, kv, '왜 지금 안 사?\u0000<script>', NOW);
  assert.equal(a.source, 'ai'); assert.equal(a.model, 'm1'); assert.equal(a.left, 1);
  assert.match(a.answer, /기다리는 중이에요/); assert.match(a.answer, /투자 조언이 아니며/);
  const prompt = seen[0].body.messages[1].content;
  assert.match(prompt, /사실:/); assert.match(prompt, /무엇을 사라\/팔라고 권하지 않는다/); assert.match(prompt, /아무것도 바꿀 수 없다/);
  assert.match(prompt, /질문: 왜 지금 안 사\? <script>/);
  assert.equal(prompt, askPrompt(cleanQuestion('왜 지금 안 사?\u0000<script>'), await askContext(env, kv, NOW)));
  const kv2 = await kvAll(env.DB);
  await ask(env, kv2, '기준이 뭐야?', NOW + 60);
  const third = await ask(env, await kvAll(env.DB), '레버리지 왜 1배야?', NOW + 120);
  assert.equal(third.source, 'rule'); assert.equal(seen.length, 2); // 하루 한도 뒤에는 AI를 부르지 않고 기록으로 답함
  assert.equal(third.left, 0);
  const next = await ask(env, await kvAll(env.DB), '기준이 뭐야?', NOW + DAY);
  assert.equal(next.source, 'ai'); // 날이 바뀌면 다시
  const audit = await env.DB.prepare("SELECT prompt, ok, note FROM ai_audit ORDER BY id").all();
  assert.equal(audit.results.length, 4); assert.ok(audit.results.every((r) => r.note.startsWith('qa;') && r.prompt.startsWith('[질문]')));
  // 읽기 전용: 사용량 카운터와 감사 기록 말고는 아무것도 바뀌지 않음
  const after = (await env.DB.prepare("SELECT k, v FROM kv WHERE k NOT IN ('ask:quota')").all()).results;
  assert.deepEqual(after.map((r) => [r.k, r.v]), before.map((r) => [r.k, r.v]));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM signals').first()).n, 1);
  // 대시보드의 AI 판단 기록에는 질문 기록이 섞이지 않음
  const o = await overview(env, NOW);
  assert.equal(o.data.aiAudit.length, 0);
});

test('ask: a failing or empty model falls back to the rule answer (never an error to the user)', async () => {
  const env = await askEnv({ AI: { run: async () => { throw new Error('3040 capacity'); } }, AI_MODEL: 'm1' });
  const a = await ask(env, await kvAll(env.DB), '왜 지금 안 사?', NOW);
  assert.equal(a.source, 'rule'); assert.match(a.answer, /지금은 실제 돈을 넣을 단계가 아니에요/);
});

// ---------------- AI 성적표·교차 판단 ----------------
test('scorecard: judgments are graded against the real price 7 days later; one per symbol per day; unfinished ones are skipped', () => {
  const t0 = dayT('2026-10-01');
  const closes = { 'KRW-BTC': Array.from({ length: 40 }, (_, i) => ({ t: t0 + i * DAY, c: 100 * (1 + 0.01 * i) })) }; // 꾸준히 오름
  const sig = [];
  for (let d = 2; d < 20; d++) for (const h of [3, 9, 15, 21]) sig.push({ sym: 'KRW-BTC', t: t0 + d * DAY + h * 3600, value: -0.8, note: 'x' });
  sig.push({ sym: 'KRW-BTC', t: t0 + 38 * DAY, value: 0.5, note: 'x' }); // 아직 결과 없음
  sig.push({ sym: 'KRW-BTC', t: t0 + 5 * DAY, value: -1, note: 'AI 결과 없음: 신규 매수 0.5배' }); // 실패 기록은 채점 대상 아님
  const sc = scoreJudgments(sig, closes, { now: t0 + 40 * DAY });
  assert.ok(sc.n >= 17 && sc.n <= 19, String(sc.n)); // 72개가 아니라 하루 하나씩
  assert.equal(sc.hit, 0); assert.equal(sc.bias, 'too_pessimistic'); assert.equal(sc.trust, null);
  assert.ok(sc.meanRet > 0.05 && sc.meanScore === -0.8);
  const lines = calibrationLines(sc).join('\n');
  assert.match(lines, /TOO PESSIMISTIC/); assert.match(lines, /Direction hit rate: 0%/); assert.match(lines, /Do not simply flip/);
  assert.deepEqual(calibrationLines({ n: 3 }), []);
  assert.deepEqual(calibrationLines(null), []);
  // 맞힌 경우
  const ok = scoreJudgments(sig.filter((s) => s.note === 'x').map((s) => ({ ...s, value: 0.6 })), closes, { now: t0 + 40 * DAY });
  assert.equal(ok.hit, 1); assert.equal(ok.bias, 'none');
});

test('scorecard feeds back into the next AI prompt; cross-model disagreement halves the score; world context lines are included', async () => {
  const DB = makeD1();
  const t0 = dayT('2026-10-01');
  const now = t0 + 40 * DAY + 3600;
  const stmts = candleStmts(DB, 'crypto', '1d', 'KRW-BTC', Array.from({ length: 41 }, (_, i) => ({ t: t0 + i * DAY, o: 100, h: 200, l: 50, c: 100 * (1 + 0.01 * i), v: 1 })), 'test');
  const st = DB.prepare('INSERT INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  for (let d = 2; d < 20; d++) stmts.push(st.bind('KRW-BTC', t0 + d * DAY + 3600, 'ai_score', -0.9, '[뉴스] 나쁨'));
  stmts.push(DB.prepare('INSERT INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)').bind('macro', now - 3600, '*world', 'macro', JSON.stringify({ id: 'vix', title: '미국 변동성 지수(VIX) 18.20 (한 달 -2.10)', en: 'VIX 18.20 (1-month change -2.10)' }), now));
  stmts.push(DB.prepare('INSERT INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)').bind('news_kr', now - 3600, '*krx', 'headline', JSON.stringify({ title: '코스피 상승 마감' }), now));
  await DB.batch(stmts);
  const kv = {};
  const sc = await scorecardTask({ DB }, kv, now, ['KRW-BTC', '278530']);
  assert.equal(sc.bias, 'too_pessimistic'); assert.equal(kv['ai:scorecard'].at, now);
  assert.equal(await scorecardTask({ DB }, kv, now + 3600, ['KRW-BTC']), sc); // 하루 한 번만 다시 계산
  const prompts = [];
  const reply = (btc) => JSON.stringify({ scores: [{ sym: 'KRW-BTC', score: btc, basis: ['trend'], reason: 'r' }, { sym: 'KRW-ETH', score: 0.4, basis: ['trend'], reason: 'r' }], veto: { krx: 'NO_VETO', crypto: 'NO_VETO' } });
  const AI = { run: async (model, body) => { prompts.push(body.messages[1].content); return { response: model === 'm2' ? reply(-0.6) : reply(0.6) }; } };
  const env = { DB, AI, AI_MODEL: 'm1', AI_FALLBACK_MODELS: 'm2' };
  assert.equal(await aiTask(env, { 'ai:scorecard': sc }, now), true);
  assert.equal(prompts.length, 3); // 같은 모델 2회 + 다른 모델 1회
  assert.match(prompts[0], /Your own track record/); assert.match(prompts[0], /TOO PESSIMISTIC/);
  assert.match(prompts[0], /World macro \/ on-chain context/); assert.match(prompts[0], /VIX 18\.20/);
  assert.match(prompts[0], /코스피 상승 마감/);
  assert.ok(!/\[\*world\] macro/.test(prompts[0])); // 세계 지표는 뉴스 줄에 섞이지 않음
  const rows = Object.fromEntries((await DB.prepare("SELECT sym, value, note FROM signals WHERE kind = 'ai_score' AND t = ?").bind(now).all()).results.map((r) => [r.sym, r]));
  assert.equal(rows['KRW-BTC'].value, 0.3); assert.match(rows['KRW-BTC'].note, /엇갈려 절반/); // 모델끼리 방향이 다름 → 절반
  assert.equal(rows['KRW-ETH'].value, 0.4); // 같으면 그대로
  const kv2 = await kvAll(DB);
  assert.equal(kv2['ai:cross'].n, 1); assert.equal(kv2['ai:cross'].signAgree, 0.5); assert.equal(kv2['ai:cross'].model, 'm2');
  // AI_CROSS_MODEL=off 이면 교차 호출 없음
  prompts.length = 0;
  await aiTask({ ...env, AI_CROSS_MODEL: 'off' }, {}, now + 7 * 3600);
  assert.equal(prompts.length, 2);
  // 순수 함수
  const m = crossShrink({ scores: { A: { score: 0.8, reason: 'x' }, B: { score: -0.2, reason: 'y' } }, veto: { krx: 0 } }, { scores: { A: { score: -0.1 }, B: { score: -0.9 } }, veto: { krx: 1 } });
  assert.equal(m.scores.A.score, 0.4); assert.equal(m.scores.B.score, -0.2); assert.equal(m.veto.krx, 1);
  assert.match(buildPrompt([], ['KRW-BTC'], { calibration: ['CAL-LINE'], world: ['- W'] }), /CAL-LINE/);
});

// ---------------- 세계 지표 피드 ----------------
test('macro feed: Yahoo chart parsing, one failing source does not fail the feed, FX fallback, all-fail is an error', async () => {
  const chart = (closes) => ({ chart: { result: [{ timestamp: closes.map((_, i) => 1_794_000_000 + i * DAY), indicators: { quote: [{ close: closes }] } }] } });
  assert.deepEqual(parseYahooChart({}), []);
  assert.equal(parseYahooChart(chart([1, null, 3])).length, 2);
  const tnx = macroItem(MACRO_SERIES.find((m) => m.id === 'us10y'), parseYahooChart(chart(Array.from({ length: 30 }, (_, i) => 4 + i * 0.01))));
  assert.match(tnx.payload.title, /미국 10년 국채 금리 4\.29% \(한 달 \+0\.20%p\)/); assert.equal(tnx.type, 'macro'); assert.equal(tnx.sym, '*world');
  const spx = macroItem(MACRO_SERIES.find((m) => m.id === 'spx'), parseYahooChart(chart(Array.from({ length: 30 }, (_, i) => 6000 + i * 10))));
  assert.match(spx.payload.en, /S&P 500 6,290 \(1-month change \+3\.3%\)/);
  assert.equal(macroItem(MACRO_SERIES[0], []), null);
  const feed = FEEDS.find((f) => f.id === 'macro');
  const fetcher = async (url) => {
    if (url.includes('KRW%3DX')) return new Response('x', { status: 429 });
    if (url.includes('frankfurter')) return Response.json({ date: '2026-11-17', rates: { KRW: 1336.21 } });
    if (url.includes('%5EVIX')) return Response.json(chart([20, 19, 18]));
    return new Response('blocked', { status: 403 });
  };
  const items = await feed.fetch(fetcher, {}, NOW);
  assert.deepEqual(items.map((i) => i.payload.id).sort(), ['usdkrw', 'vix']);
  assert.match(items.find((i) => i.payload.id === 'usdkrw').payload.title, /1,336원/);
  await assert.rejects(() => feed.fetch(async () => new Response('', { status: 503 }), {}, NOW), /MACRO_ALL_FAILED/);
  const cg = FEEDS.find((f) => f.id === 'crypto_global');
  const it2 = await cg.fetch(async (url) => (url.includes('coingecko') ? Response.json({ data: { total_market_cap: { usd: 3.2e12 }, market_cap_percentage: { btc: 58.3 }, market_cap_change_percentage_24h_usd: -1.2 } }) : Response.json({ values: Array.from({ length: 40 }, (_, i) => ({ x: i, y: 500_000 + i * 1000 })) })), {}, NOW);
  assert.equal(it2.length, 2); assert.match(it2[0].payload.title, /3\.20조 달러.*58\.3%/); assert.match(it2[1].payload.en, /active addresses/);
  for (const f of FEEDS) assert.ok(f.id && f.name && typeof f.fetch === 'function' && f.every > 0);
});

// ---------------- 화면·API ----------------
test('worker API: members + ask need the owner session, refuse cross-origin POSTs, and change only the paper settings', async () => {
  const DB = makeD1();
  const env = { DB, OWNER_PASSWORD: 'pw-for-test' };
  const call = (path, init = {}) => worker.fetch(new Request(`https://lab.example${path}`, init), env, { waitUntil() {} });
  assert.equal((await call('/api/members')).status, 401);
  assert.equal((await call('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"기준이 뭐야?"}' })).status, 401);
  const cookie = sessionCookie(await createSession(new Request('https://lab.example/'), env)).split(';')[0];
  const post = (path, body, extra = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/members', { op: { type: 'add', label: '동생', budgetKrw: 200_000 } }, { origin: 'https://evil.example' })).status, 403);
  let r = await post('/api/members', { op: { type: 'add', label: '동생', budgetKrw: 200_000 } });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.view.members.length, 3); assert.match(j.entry.text, /동생 추가: 가상 20만 원/);
  r = await post('/api/members', { op: { type: 'update', key: 'self', budgetKrw: 5_000 } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /1만 원부터/);
  assert.equal((await post('/api/members', {})).status, 400);
  j = await (await call('/api/members', { headers: { cookie } })).json();
  assert.deepEqual(j.members.map((m) => m.label), ['본인', '어머니', '동생']);
  const ev = await DB.prepare("SELECT message FROM events").all();
  assert.equal(ev.results.length, 1); assert.match(ev.results[0].message, /가족 설정 변경/);
  r = await post('/api/ask', { q: '기준이 뭐야?' });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.source, 'rule'); assert.match(j.answer, /12번 이상/);
  assert.equal((await post('/api/ask', { q: 5 })).status, 400);
});

test('dashboard: new tabs render from real overview data without throwing (smoke test in a stub DOM)', async () => {
  const { env, days } = await seededEnv();
  await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', days[days.length - 5])]);
  let kv = await kvAll(env.DB);
  const st = applyMemberOp(applyMemberOp(kv['family:members'], { type: 'update', key: 'mother', budgetKrw: 2_000_000 }, NOW).state, { type: 'add', label: '<i>동생', budgetKrw: 100_000 }, NOW).state;
  await env.DB.batch([kvSetStmt(env.DB, 'family:members', st)]);
  kv = await kvAll(env.DB);
  await lifecycleTask(env, kv, NOW);
  const data = await overview(env, NOW);
  const html = dashboardHtml();
  for (const tab of ['rules', 'family']) assert.match(html, new RegExp(`data-tab="${tab}"`));
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === 'dataset' || k === 'style' ? {} : k === 'querySelectorAll' ? () => [] : k === 'querySelector' ? () => null : k === Symbol.toPrimitive ? () => '' : el()), set: () => true, apply: () => el() });
  const store = { getItem: () => null, setItem() {} };
  const ctx = { document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, visibilityState: 'hidden', activeElement: null }, window: { addEventListener() {}, scrollTo() {}, scrollY: 0 }, localStorage: store, sessionStorage: store,
    fetch: async () => { throw new Error('offline'); }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, AbortController, location: { reload() {} }, CSS: { escape: (x) => x }, console, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(`${js};globalThis.__views=(d)=>{DATA=d;return {rank:viewRank(),rules:viewRules(),family:viewFamily(),life:viewLife(),data:viewData(),log:viewLog()}}`, ctx);
  const v = ctx.__views(JSON.parse(JSON.stringify(data)));
  assert.match(v.rank, /안전 장부 · 1배만/); assert.match(v.rank, /공격 장부 · 배수 자동 조절/); assert.match(v.rank, /data-ask="top"/);
  assert.match(v.rank, /본인 10만·어머니 200만·&lt;i&gt;동생|본인 10만·어머니 200만·i동생/);
  assert.match(v.rules, /지금 적용 중인 기준 · v2/); assert.match(v.rules, /기준 변경 이력/); assert.match(v.rules, /연구실에게 물어보기/);
  assert.match(v.family, /data-mkey="mother"/); assert.match(v.family, /value="200"/); assert.match(v.family, /지난 장부/); assert.match(v.family, /구성원 추가/);
  assert.ok(!/<i>동생/.test(v.family + v.rank), 'member names are escaped');
  assert.equal(annualVol([{ equity: 1 }], 'krx', '1d'), null);
  assert.ok(annualVol(Array.from({ length: 30 }, (_, i) => ({ equity: 100 + (i % 2) })), 'krx', '1d') > 0);
});
