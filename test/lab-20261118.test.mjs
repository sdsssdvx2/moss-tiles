// 2026-11-18 연구실 발전 묶음: 정직한 평가(위험 맞춤 기준선·실제 조정 횟수·연구실 전체 시도 보정·세금·이상치)
// + 레버리지 시뮬레이션 현실화 + AI 판단 강화(근거·일관성·AI 단독 장부) + 새 전략.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBars, makeD1 } from './helpers.mjs';
import { DAY, dayT } from '../src/core/calendar.js';
import { Feed, createState, stepBar } from '../src/core/engine.js';
import { buildOpts, runBacktest } from '../src/core/backtest.js';
import { mergeCosts, gainTaxFor } from '../src/core/costs.js';
import { fixedMixCurve, riskMatched } from '../src/core/metrics.js';
import { expectedMaxSharpe } from '../src/core/stats.js';
import { evaluateStage, STAGES } from '../src/core/lifecycle.js';
import { createFutState, stepFutures } from '../src/core/futures-sim.js';
import { krxMeta, RULES_20261118_FROM, ETF_GAIN_TAXED } from '../src/config.js';
import { byId, STRATEGIES } from '../src/strategies/index.js';
import { aiSoloWeight, aiSoloEtfV1, aiSoloCryptoV1, btcPerpLev3V1, btcPerpLev1V1 } from '../src/strategies/lab-20261118.js';
import { consistencyOf, mergeSamples, rollConsistency, buildPrompt, parseAiResponse, priceFeatures } from '../src/jobs/ai.js';
import { jumpCheck } from '../src/jobs/collect.js';
import { freshStats, aiCompare } from '../src/api.js';
import { btEvidence } from '../src/jobs/lifecycle.js';

// ---------------- taxes ----------------
test('ETF gain tax: 15.4% on realised gain of 해외주식형·채권형 ETF only, only from the effective bar', () => {
  const c = mergeCosts('krx');
  assert.ok(ETF_GAIN_TAXED.has('379800') && ETF_GAIN_TAXED.has('153130') && !ETF_GAIN_TAXED.has('278530'));
  assert.equal(gainTaxFor(100, 1_100_000, 1_000_000, c, krxMeta['379800']), 15400);
  assert.equal(gainTaxFor(100, 900_000, 1_000_000, c, krxMeta['379800']), 0); // loss -> no tax
  assert.equal(gainTaxFor(100, 1_100_000, 1_000_000, c, krxMeta['278530']), 0); // domestic equity ETF: exempt
  const paper = { ...c, gainTaxFrom: RULES_20261118_FROM };
  assert.equal(gainTaxFor(RULES_20261118_FROM - DAY, 1_100_000, 1_000_000, paper, krxMeta['379800']), 0); // stored bars replay 1:1
  assert.equal(gainTaxFor(RULES_20261118_FROM, 1_100_000, 1_000_000, paper, krxMeta['379800']), 15400);
});

test('replay compatibility: with the effective date in the future, fills equal the old no-tax engine exactly', () => {
  const s = byId.etf_trend_v1;
  const series = {};
  let i = 0;
  for (const sym of s.universe) series[sym] = makeBars({ n: 520, seed: 31 + i++, drift: 0.0009, vol: 0.011, skipNonKrx: true, p0: 20000 });
  const old = runBacktest({ strategy: s, series, meta: krxMeta, costs: { ...mergeCosts('krx'), etfGainTax: 0 } });
  const now = runBacktest({ strategy: s, series, meta: krxMeta, costs: { ...mergeCosts('krx'), gainTaxFrom: Infinity } });
  const key = (f) => `${f.t}|${f.sym}|${f.side}|${f.qty}|${f.price}`;
  assert.ok(old.fills.length > 5);
  assert.deepEqual(now.fills.map(key), old.fills.map(key));
  const taxed = runBacktest({ strategy: s, series, meta: krxMeta });
  assert.ok(taxed.fills.some((f) => f.side === 'SELL' && ['379800', '153130'].includes(f.sym) && f.tax > 0) || taxed.state.taxes === 0);
});

// ---------------- risk-matched baseline ----------------
test('fixed-mix baseline: w=1 tracks the index, w=0 with no bond stays flat, monthly rebalance', () => {
  const a = makeBars({ n: 300, seed: 3 });
  const ts = a.map((b) => b.t);
  const full = fixedMixCurve(ts, a, null, 1, 100);
  assert.ok(Math.abs(full[full.length - 1].equity / 100 - a[a.length - 1].c / a[0].c) < 1e-9);
  const none = fixedMixCurve(ts, a, null, 0, 100);
  assert.ok(none.every((p) => Math.abs(p.equity - 100) < 1e-9));
  const pts = ts.map((t, k) => ({ t, equity: 100, invested: k % 2 ? 100 : 0 })); // 50% average exposure
  const rm = riskMatched(pts, a, null);
  assert.equal(rm.weight, 0.5);
  assert.equal(rm.cash, 'cash');
});

test('G1 gate: a strategy whose Sharpe is below the risk-matched baseline fails; missing baseline fails closed', () => {
  const s = { id: 'x_v1', market: 'krx', cadence: 'slow' };
  const ho = { totalReturn: 0.3, mdd: 0.1, sharpe: 1.0, trades: 50, bench: { totalReturn: 0.9, mdd: 0.4, sharpe: 0.9 } };
  const bt = (rm) => ({ holdout: { ...ho, riskMatched: rm }, holdout2x: { totalReturn: 0.2 }, years: 11, totalTrades: 90, dsr: 0.95, trials: 1 });
  assert.equal(evaluateStage({ strategy: s, bt: bt({ weight: 0.5, totalReturn: 0.4, mdd: 0.2, sharpe: 0.8, cash: 'bond' }) }).stage, 'paper');
  const fail = evaluateStage({ strategy: s, bt: bt({ weight: 0.5, totalReturn: 0.5, mdd: 0.2, sharpe: 1.2, cash: 'bond' }) });
  assert.equal(fail.stage, 'bt_failed');
  assert.ok(fail.checks.some((c) => !c.ok && c.text.includes('위험 맞춤 기준선')));
  assert.equal(evaluateStage({ strategy: s, bt: bt(undefined) }).stage, 'bt_failed');
});

test('paper gate counts REAL adjustments: a weekly strategy with 25 daily bars but 4 rebalances does not pass', () => {
  const s = { id: 'w_v1', market: 'krx', cadence: 'slow' };
  const bt = { holdout: { totalReturn: 0.3, mdd: 0.05, sharpe: 1.5, trades: 50, bench: { totalReturn: 0.2, mdd: 0.4, sharpe: 0.5 }, riskMatched: { weight: 0.5, totalReturn: 0.1, mdd: 0.2, sharpe: 0.5, cash: 'bond' } }, holdout2x: { totalReturn: 0.2 }, years: 11, totalTrades: 90, dsr: 0.95, trials: 1 };
  const paper = { days: 35, bars: 25, decisions: 25, rebalances: 4, trades: 8, mdd: 0.01, agreement: { matched: 8, total: 8 } };
  const ev = evaluateStage({ strategy: s, bt, paper });
  assert.equal(ev.stage, 'paper');
  assert.ok(ev.checks.some((c) => !c.ok && c.text.includes('실제 조정')));
  const ok = evaluateStage({ strategy: s, bt, paper: { ...paper, rebalances: 12 } });
  assert.equal(ok.stage, 'live_candidate');
  assert.equal(STAGES.live_candidate.label, '운영 점검 통과(실력 증명 아님)');
  assert.ok(ok.summary.includes('실력 증명 아님'));
});

test('lab-wide luck threshold grows with the number of strategies tried', () => {
  assert.equal(expectedMaxSharpe(1, 700, 252), 0);
  const a = expectedMaxSharpe(10, 700, 252), b = expectedMaxSharpe(200, 700, 252);
  assert.ok(a > 0.5 && b > a && b < 3);
});

// ---------------- data outliers ----------------
test('jump check: ETF ±15%, stocks ±30% (KRX price limit)', () => {
  assert.equal(jumpCheck(100, { c: 110 }, { etf: true }), null);
  assert.ok(jumpCheck(31775, { c: 38810 }, { etf: true })); // 2026-07-31 KODEX 200TR +22.1% (real per KRX official close)
  assert.equal(jumpCheck(100, { c: 125 }, { etf: false }), null);
  assert.ok(jumpCheck(100, { c: 140 }, { etf: false }));
  assert.equal(jumpCheck(0, { c: 140 }), null);
});

// ---------------- futures realism ----------------
function perpRun(strategy, bars, extra = {}, cash = 10_000_000) {
  const series = { 'KRW-BTC': bars };
  const opts = buildOpts(strategy, { params: { ...strategy.params, ...extra } });
  const feed = new Feed(series);
  const st = createFutState(cash);
  const fills = [];
  for (const b of bars) { const r = stepFutures(st, b.t, feed, opts); fills.push(...r.fills); }
  return { st, fills };
}
const forceLong = (lev) => ({ ...btcPerpLev3V1, params: { ...btcPerpLev3V1.params, leverage: lev }, decideFutures: (ctx) => (ctx.position ? null : { order: { action: 'open', side: 1, size: 0.5, stopDist: 0, reason: 'test' } }) });

test('leverage sim: 3x long is liquidated by a -35% bar and loses that margin; 1x survives', () => {
  const t0 = dayT('2025-01-01');
  const bars = [0, 1, 2, 3].map((k) => ({ t: t0 + k * DAY, o: 100, h: 101, l: k === 2 ? 65 : 99, c: k === 2 ? 70 : 100, v: 1 }));
  const r3 = perpRun(forceLong(3), bars);
  assert.ok(r3.st.liquidations >= 1);
  assert.ok(r3.st.equity < 10_000_000 * 0.55); // ~50% margin gone (plus re-entry)
  const r1 = perpRun(forceLong(1), bars);
  assert.equal(r1.st.liquidations, 0);
  // sim hard cap: leverage 10 is clipped to 3
  const r10 = perpRun(forceLong(10), bars.slice(0, 2));
  assert.equal(r10.st.pos.lev, 3);
});

test('leverage sim: lot size 0.001 blocks entries a tiny account cannot afford; roll-over costs are charged', () => {
  const t0 = dayT('2025-01-01');
  const bars = Array.from({ length: 5 }, (_, k) => ({ t: t0 + k * DAY, o: 90_000_000, h: 90_500_000, l: 89_500_000, c: 90_000_000, v: 1 }));
  const small = perpRun(forceLong(1), bars, { qtyStep: 0.001, minQty: 0.001 }, 100_000); // 50k margin x1 < 0.001 BTC (90k)
  assert.equal(small.st.pos, null);
  assert.ok(small.st.skippedMin >= 1);
  const ok = perpRun(forceLong(2), bars, { qtyStep: 0.001, minQty: 0.001 }, 100_000); // 100k notional -> 0.001 BTC
  assert.equal(ok.st.pos.qty, 0.001);
  const roll = perpRun(forceLong(1), bars, { rollEveryDays: 2, rollCost: 0.001, fundingPer8h: 0 });
  assert.ok(roll.st.rolls >= 1);
});

test('leverage comparison books are research-only simulations outside the aggressive sleeve', () => {
  for (const s of [btcPerpLev1V1, btcPerpLev3V1]) {
    assert.ok(s.researchOnly && s.simulationOnly && !s.sleeve);
    assert.ok(STRATEGIES.includes(s));
  }
  assert.equal(btcPerpLev1V1.params.leverage, 1);
  assert.equal(byId.btc_perp_sim_v1.params.leverage, 2); // existing book unchanged
});

// ---------------- AI ----------------
const p = (scores, veto = { krx: 0, crypto: 0 }) => ({ scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v, reason: '' }])), veto });

test('AI consistency + merge: average scores, conservative veto, rolling record', () => {
  const a = p({ '278530': 0.4, 'KRW-BTC': -0.2 }, { krx: 0, crypto: 0.5 }), b = p({ '278530': 0.2, 'KRW-BTC': 0.3 }, { krx: 0, crypto: 1 });
  const c = consistencyOf(a, b);
  assert.equal(c.n, 2); assert.equal(c.meanAbsDiff, 0.35); assert.equal(c.signAgree, 0.5); assert.equal(c.vetoAgree, 0.5);
  const m = mergeSamples(a, b);
  assert.equal(m.scores['278530'].score, 0.3); assert.equal(m.veto.crypto, 1);
  assert.equal(mergeSamples(a, null), a);
  const r = rollConsistency(rollConsistency(null, c, 1), { ...c, meanAbsDiff: 0.15 }, 2);
  assert.equal(r.n, 2); assert.equal(r.meanAbsDiff, 0.25);
  assert.equal(consistencyOf(a, null), null);
});

test('AI prompt carries price structure + breadth; basis is parsed into the recorded reason', () => {
  const bars = makeBars({ n: 260, seed: 5 });
  const f = priceFeatures(bars, 252);
  assert.ok(Number.isFinite(f.vsSma200) && Number.isFinite(f.vol20));
  const prompt = buildPrompt([], ['278530'], { features: { '278530': f }, breadth: { krx: { above: 7, total: 20 } } });
  assert.match(prompt, /vs 200d avg/); assert.match(prompt, /7\/20/); assert.match(prompt, /basis/);
  const r = parseAiResponse(JSON.stringify({ scores: [{ sym: '278530', score: 0.2, basis: ['trend', 'news', 'bogus'], reason: '추세 위' }] }), ['278530']);
  assert.equal(r.scores['278530'].reason, '[추세·뉴스] 추세 위');
});

test('AI solo books: no-op without AI, keep weights when the score is missing, fixed score->weight map', () => {
  assert.equal(aiSoloWeight(0.5), 0.30); assert.equal(aiSoloWeight(0.1), 0.15); assert.equal(aiSoloWeight(-0.1), 0);
  const ctx = (signals, weights = {}) => ({ t: dayT('2026-11-20'), barIndex: 3, weights, signals, closes: () => [], mem: {} });
  assert.equal(aiSoloCryptoV1.decide(ctx({})), null);
  const d = aiSoloCryptoV1.decide(ctx({ aiRequired: true, ai: { 'KRW-BTC': { score: 0.5, reason: 'r' } } }, { 'KRW-ETH': 0.1 }));
  assert.equal(d.targets['KRW-BTC'], 0.30);
  assert.equal(d.targets['KRW-ETH'], 0.1); // missing AI score -> unchanged (fail-closed, no forced sale)
  // 2026-11-20 is the last KRX day of that week -> ETF solo decides; bond fills the idle part
  const e = aiSoloEtfV1.decide(ctx({ aiRequired: true, ai: { '278530': { score: -0.5 }, '379800': { score: 0.1 } } }));
  assert.equal(e.targets['278530'], 0); assert.equal(e.targets['379800'], 0.15); assert.ok(Math.abs(e.targets['153130'] - 0.30) < 1e-12);
  // no backtest possible -> evidence ignored, stage = paper (research)
  assert.equal(btEvidence([{ strategy_id: 'ai_solo_etf_v1', kind: 'worker', summary: { oos: {}, full: {} } }], 'ai_solo_etf_v1', aiSoloEtfV1), null);
  assert.equal(evaluateStage({ strategy: aiSoloEtfV1, bt: null, paper: { days: 3, bars: 3, mdd: 0 } }).stage, 'paper');
});

// ---------------- dashboard helpers ----------------
test('fresh (first-seen) stats and the AI fair comparison use only the paper record', () => {
  const pts = [{ t: 1, equity: 100, bench: 100, invested: 50 }, { t: 2, equity: 101, bench: 110, invested: 50.5 }];
  const f = freshStats(pts, { initialCash: 100, equity: 101, bench: 110, startT: 1 }, 3);
  assert.equal(f.ret, 0.01); assert.equal(f.benchRet, 0.1); assert.equal(f.exposure, 0.5); assert.equal(f.rmRet, 0.05); assert.equal(f.rebalances, 3);
  const strategies = [{ id: 'etf_trend_v1', name: 'A' }, { id: 'ai_solo_etf_v1', name: 'S' }];
  const curves = { 'etf_trend_v1:paper': [{ t: 1, equity: 100 }, { t: 2, equity: 90 }, { t: 3, equity: 99 }], 'ai_solo_etf_v1:paper': [{ t: 2, equity: 100 }, { t: 3, equity: 105 }] };
  const g = aiCompare(strategies, curves, {})[0];
  assert.equal(g.from, 2);
  assert.equal(g.rows.find((r) => r.id === 'etf_trend_v1').ret, 0.1);
  assert.equal(g.rows.find((r) => r.id === 'ai_solo_etf_v1').ret, 0.05);
});

test('new candidate strategies are registered as ordinary pipeline strategies (paper starts forward-only)', () => {
  for (const id of ['etf_voltarget_v1', 'etf_dualmom_v1', 'crypto_volbrk_d_v1']) {
    const s = byId[id];
    assert.ok(s && !s.researchOnly && !s.benchmarkOnly, id);
  }
});

test('AI task writes two audit rows and a consistency record when both samples parse', async () => {
  const { aiTask } = await import('../src/jobs/ai.js');
  const DB = makeD1();
  let k = 0;
  const AI = { run: async () => ({ response: JSON.stringify({ scores: [{ sym: 'KRW-BTC', score: k++ ? 0.2 : 0.4, reason: 'x' }], veto: { krx: 'NO_VETO', crypto: 'NO_VETO' } }) }) };
  const kv = {};
  assert.equal(await aiTask({ DB, AI, AI_MODEL: 'm' }, kv, 1_800_000_000), true);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM ai_audit').get().n, 2);
  const sig = DB.raw.prepare("SELECT value FROM signals WHERE sym = 'KRW-BTC' AND kind = 'ai_score'").get();
  assert.ok(Math.abs(sig.value - 0.3) < 1e-9);
  assert.equal(kv['ai:consistency'].n, 1);
});

test('risk-matched baseline splits the index part equally over several symbols and ignores bond holdings as exposure', () => {
  const a = makeBars({ n: 120, seed: 8 }), b = makeBars({ n: 120, seed: 9 });
  const ts = a.map((x) => x.t);
  const two = fixedMixCurve(ts, [a, b], null, 1, 100);
  const first = two[0].equity, end = two[two.length - 1].equity;
  assert.ok(end > 0 && Math.abs(first - 100) < 1e-9);
  const pts = ts.map((t) => ({ t, equity: 100, invested: 60, risky: 30 })); // 30% in index, 30% in 단기채권
  assert.equal(riskMatched(pts, [a, b], null).weight, 0.3);
  assert.equal(riskMatched(pts, [a, b], null).n, 2);
});
