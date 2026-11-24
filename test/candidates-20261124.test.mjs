// 2026-11-24 사전 등록 후보 대기열(PR B). 실제 시세로 후보를 돌리지 않는다(공개 날짜 전 결과 보기 금지) — 합성 자료·가짜 평가 함수만.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { kvAll, kvSetStmt, getRuns } from '../src/db/store.js';
import { importResearch } from '../src/jobs/research-import.js';
import { paperTask } from '../src/jobs/paper.js';
import { STRATEGIES, allStrategies, activeStrategies, validateStrategy, trialsFor } from '../src/strategies/index.js';
import { CANDIDATES, candidateById, candidateStrategies, releaseAt } from '../src/strategies/candidates.js';
import { dueCandidates, judgeCandidates, triedCandidates, labTrialsCount, importBody } from '../backtest/run.mjs';
import { dayT } from '../src/core/calendar.js';

const DEC13 = Date.parse('2026-12-13T05:17:00+09:00') / 1000; // 공개 뒤 첫 주간 연구(일 05:17 KST)
const NOV24 = Date.parse('2026-11-24T12:00:00+09:00') / 1000;
const passBt = () => ({ holdout: { totalReturn: 0.2, mdd: 0.05, sharpe: 1.2, trades: 40, bench: { totalReturn: 0.1, mdd: 0.3, sharpe: 0.5 }, riskMatched: { sharpe: 0.6, totalReturn: 0.08, mdd: 0.1, weight: 0.5, n: 2, cash: 'bond' } }, holdout2x: { totalReturn: 0.15 }, wf: null, years: 11.5, totalTrades: 60, dsr: 0.97, trials: 1 });
const failBt = () => ({ ...passBt(), holdout: { ...passBt().holdout, totalReturn: -0.05, sharpe: -0.2 } });
function withNow(sec, fn) { const real = Date.now; Date.now = () => sec * 1000; return Promise.resolve().then(fn).finally(() => { Date.now = real; }); }

test('candidates: valid strategies, outside STRATEGIES, absent from allStrategies until released', () => {
  for (const s of CANDIDATES) {
    assert.deepEqual(validateStrategy(s), [], s.id);
    assert.ok(!STRATEGIES.some((x) => x.id === s.id || x.family === s.family), s.id);
    assert.match(s.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.deepEqual(CANDIDATES.map((s) => [s.id, s.releaseDate]), [['etf_quality_lowvol_v1', '2026-12-12'], ['etf_allweather_v1', '2026-12-26'], ['etf_dev_trend_v1', '2027-01-09']]); // 사전 등록 그대로
  assert.ok(!allStrategies({}).some((s) => s.candidate));
  const ids = allStrategies({ 'candidates:released': [{ id: 'etf_allweather_v1', releasedAt: 1 }, { id: 'nope_v1' }, { id: 'etf_allweather_v1' }] }).filter((s) => s.candidate).map((s) => s.id);
  assert.deepEqual(ids, ['etf_allweather_v1']);
  assert.equal(releaseAt(candidateById.etf_quality_lowvol_v1), Date.parse('2026-12-12T00:00:00+09:00') / 1000);
});

test('runner: before the release date nothing is due and lab trials do not move', () => {
  const d = dueCandidates(NOV24, {}, () => 12);
  assert.deepEqual(d.due, []);
  for (const s of CANDIDATES) assert.equal(d.status[s.id].status, 'waiting');
  assert.equal(labTrialsCount([...STRATEGIES, ...triedCandidates({}), ...d.due]), labTrialsCount());
});

test('runner: after the date — due if data years >= 10, else no_data (not recorded, retried next week)', () => {
  const years = { etf_quality_lowvol_v1: 11.2, etf_allweather_v1: 12, etf_dev_trend_v1: 9.4 };
  const after = Date.parse('2027-01-10T05:17:00+09:00') / 1000;
  const d = dueCandidates(after, {}, (s) => years[s.id]);
  assert.deepEqual(d.due.map((s) => s.id), ['etf_quality_lowvol_v1', 'etf_allweather_v1']);
  assert.equal(d.status.etf_dev_trend_v1.status, 'no_data');
  const d2 = dueCandidates(DEC13, {}, (s) => years[s.id]);
  assert.deepEqual(d2.due.map((s) => s.id), ['etf_quality_lowvol_v1']); // 12-12 공개분만
  // 이번 주 판정할 후보는 시도 수에 미리 +1(가족 1개씩)
  assert.equal(labTrialsCount([...STRATEGIES, ...d2.due]), labTrialsCount() + 1);
});

test('runner: judged once — pass → released, fail → rejected (both count as trials), null → no_data; trials >= 1', () => {
  const seen = [];
  const evalStub = (s, o) => { seen.push([s.id, o.extraTrials]); return s.id === 'etf_quality_lowvol_v1' ? passBt() : s.id === 'etf_allweather_v1' ? failBt() : null; };
  const j = judgeCandidates(CANDIDATES, {}, DEC13, evalStub);
  assert.ok(seen.every(([, n]) => n >= 1), JSON.stringify(seen)); // 후보 가족은 STRATEGIES 밖 → trialsFor 기본값 0 이면 보정 없는 DSR
  assert.equal(trialsFor(CANDIDATES[0]), 0); // 그래서 판정에서 자기 자신 1회를 따로 더함
  assert.equal(j.ledger.etf_quality_lowvol_v1.status, 'released');
  assert.equal(j.ledger.etf_allweather_v1.status, 'rejected');
  assert.ok(!('etf_dev_trend_v1' in j.ledger));
  assert.equal(j.status.etf_dev_trend_v1.status, 'no_data');
  assert.deepEqual(Object.keys(j.results), ['etf_quality_lowvol_v1']);
  // 다음 주: 판정한 것은 다시 판정하지 않음, 시도 수에는 계속 남음
  const d = dueCandidates(DEC13 + 7 * 86400 * 4, j.ledger, () => 12);
  assert.deepEqual(d.due.map((s) => s.id), ['etf_dev_trend_v1']);
  assert.equal(triedCandidates(j.ledger).length, 2);
  // import.json: 통과한 것만 candidates 로
  const body = importBody({}, null, null, { ledger: j.ledger, status: j.status });
  assert.deepEqual(body.candidates.map((c) => c.id), ['etf_quality_lowvol_v1']);
  assert.equal(body.candidateStatus.etf_allweather_v1.status, 'rejected');
});

test('worker import: refuses before the release date and unknown ids; accepts after → paper ledger starts next tick', async () => {
  const env = { DB: makeD1() };
  const ready = dayT('2026-12-11');
  await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', ready)]);
  const body = { candidates: [{ id: 'etf_quality_lowvol_v1', releasedAt: DEC13 }, { id: 'evil_v1' }, { id: 'krx_bh_v1' }], candidateStatus: { etf_quality_lowvol_v1: { status: 'released', note: 'x', at: DEC13 }, evil_v1: { status: 'x' } } };
  const r0 = await withNow(NOV24, () => importResearch(env, body));
  assert.equal(r0.candidates, 0);
  let kv = await kvAll(env.DB);
  assert.ok(!kv['candidates:released']);
  assert.ok(!activeStrategies(kv).some((s) => s.candidate));
  const r1 = await withNow(DEC13, () => importResearch(env, body));
  assert.equal(r1.candidates, 1);
  kv = await kvAll(env.DB);
  assert.deepEqual(kv['candidates:released'].map((c) => c.id), ['etf_quality_lowvol_v1']);
  assert.deepEqual(Object.keys(kv['candidates:status']), ['etf_quality_lowvol_v1']);
  const ev = env.DB.raw.prepare("SELECT strategy_id, message FROM events WHERE strategy_id = 'etf_quality_lowvol_v1'").all();
  assert.equal(ev.length, 1);
  const r2 = await withNow(DEC13 + 600, () => importResearch(env, body)); // 같은 파일을 또 읽어도 한 번만
  assert.equal(r2.candidates, 0);
  // 다음 틱: 모의 장부가 등록 뒤 첫 봉부터(앞으로만) 생김. 다른 후보는 안 생김
  await paperTask(env, await kvAll(env.DB), DEC13 + 1200, { maxSteps: 0 });
  const runs = (await getRuns(env.DB)).map((x) => x.id);
  assert.ok(runs.includes('etf_quality_lowvol_v1:paper'));
  assert.ok(!runs.includes('etf_allweather_v1:paper') && !runs.includes('etf_dev_trend_v1:paper'));
  const run = (await getRuns(env.DB)).find((x) => x.id === 'etf_quality_lowvol_v1:paper');
  assert.equal(run.start_after, ready);
});

test('worker import: backtest evidence for a candidate is accepted only once it is released', async () => {
  const env = { DB: makeD1() };
  const bt = { strategy_id: 'etf_allweather_v1', kind: 'wf', source: 'local', summary: { years: 12 }, curve: null };
  await withNow(Date.parse('2026-12-27T06:00:00+09:00') / 1000, () => importResearch(env, { backtests: [bt] }));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM backtests WHERE strategy_id = 'etf_allweather_v1'").get().n, 0);
  await withNow(Date.parse('2026-12-27T06:00:00+09:00') / 1000, () => importResearch(env, { candidates: [{ id: 'etf_allweather_v1' }], backtests: [bt] }));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM backtests WHERE strategy_id = 'etf_allweather_v1'").get().n, 1);
});

// ---- 규칙이 사전 등록대로인지(합성 자료, 판단 함수만) ----
const T0 = dayT('2026-12-14');
function ctxOf(series, extra = {}) {
  return { t: T0, params: extra.params, mem: {}, barIndex: 0, closes: (sym, n) => (series[sym] || []).slice(-n), ...extra };
}
const ramp = (n, p0, step) => Array.from({ length: n }, (_, i) => p0 + i * step);
const wiggle = (n, p0, amp, step = 0) => Array.from({ length: n }, (_, i) => p0 + i * step + (i % 2 ? amp : -amp));

test('rule: all-weather 15/15/40/15/15; a symbol without data gives its share to short-term bonds', () => {
  const s = candidateById.etf_allweather_v1;
  const full = { '069500': ramp(30, 100, 1), '379800': ramp(30, 100, 1), '148070': ramp(30, 100, 1), '132030': ramp(30, 100, 1), '153130': ramp(30, 100, 0.01) };
  const a = s.decide(ctxOf(full, { params: s.params }));
  assert.deepEqual(a.targets, { '069500': 0.15, '379800': 0.15, '148070': 0.40, '132030': 0.15, '153130': 0.15 });
  const { '379800': _, ...no379 } = full;
  const b = s.decide(ctxOf(no379, { params: s.params }));
  assert.equal(b.targets['153130'], 0.30); assert.ok(!('379800' in b.targets));
  // 같은 분기 안에서는 다시 맞추지 않음
  assert.equal(s.decide(ctxOf(full, { params: s.params, barIndex: 5, mem: a.mem, t: T0 + 7 * 86400 })), null);
  assert.equal(s.risk.minCash, 0); assert.equal(s.risk.maxPositionWeight, 0.40);
});

test('rule: quality/low-vol picks the 2 calmest with >=250 bars, 30% each; below 200d MA → bonds', () => {
  const s = candidateById.etf_quality_lowvol_v1;
  const series = {
    '174350': wiggle(300, 100, 0.2, 0.05),   // 가장 잔잔·상승
    '161510': wiggle(300, 100, 0.6, 0.05),   // 중간·상승
    '279530': wiggle(200, 100, 0.1, 0.05),   // 가장 잔잔하지만 자료 200봉(<250) → 제외
    '153130': ramp(300, 100, 0.01),
  };
  const a = s.decide(ctxOf(series, { params: s.params }));
  assert.equal(a.targets['174350'], 0.30); assert.equal(a.targets['161510'], 0.30); assert.ok(!('279530' in a.targets));
  assert.ok(!('153130' in a.targets)); // 60% 다 찼으면 채권 없음
  const down = { ...series, '161510': wiggle(300, 200, 0.3, -0.2) }; // 하락 → 200일 평균 아래
  const b = s.decide(ctxOf(down, { params: s.params }));
  assert.equal(b.targets['174350'], 0.30); assert.ok(!('161510' in b.targets)); assert.equal(b.targets['153130'], 0.30);
});

test('rule: developed/US trend — 30% each above the 200d MA, else that share to bonds', () => {
  const s = candidateById.etf_dev_trend_v1;
  const up = { '251350': ramp(260, 100, 1), '379800': ramp(260, 300, -0.5), '153130': ramp(260, 100, 0.01) };
  const a = s.decide(ctxOf(up, { params: s.params }));
  assert.equal(a.targets['251350'], 0.30); assert.ok(!('379800' in a.targets)); assert.equal(a.targets['153130'], 0.30);
  const short = { '251350': ramp(150, 100, 1), '153130': ramp(150, 100, 0.01) };
  const b = s.decide(ctxOf(short, { params: s.params }));
  assert.ok(!('251350' in b.targets)); assert.equal(b.targets['153130'], 0.30);
});
