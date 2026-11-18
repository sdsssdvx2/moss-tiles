// Regression tests for the independent Codex audit (CODEX-REVIEW-KO.md, 2026-11-16).
// Originally reproductions of each defect; now they assert the FIXED behaviour.
// No network, persistent database, deployed Worker, or real credential is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeD1 } from './helpers.mjs';
import { Feed, createState, stepBar } from '../src/core/engine.js';
import { buildOpts, runBacktest } from '../src/core/backtest.js';
import { mergeCosts, affordableQty, feesFor, stressCosts } from '../src/core/costs.js';
import { createFutState, stepFutures } from '../src/core/futures-sim.js';
import { evaluateStage } from '../src/core/lifecycle.js';
import { lifecycleTask, signalAgreement } from '../src/jobs/lifecycle.js';
import { advanceRun, paperTask } from '../src/jobs/paper.js';
import { candleStmts, fillStmts, equityStmts, runUpsertStmt, backtestStmt } from '../src/db/store.js';
import { dayT, DAY, HOUR, isKrxBusinessDay, nextKrxBusinessDay, latestFinalKrxDay, kstAt } from '../src/core/calendar.js';
import { STRATEGIES, byId, trialsFor } from '../src/strategies/index.js';
import { volBreakoutV1 } from '../src/strategies/aggressive.js';
import { recordLogin } from '../src/auth.js';
import { parseRssTitles, FEEDS } from '../src/data/feeds.js';
import { allocate } from '../src/core/allocator.js';
import { dashboardHtml } from '../src/ui/dashboard.js';
import { evaluateStrategy, ledgerTrials } from '../backtest/run.mjs';
import { scheduledSummary } from '../src/jobs/notify.js';

const bar = (t, p = 100) => ({ t, o: p, h: p, l: p, c: p, v: 1 });
const strategy = (over = {}) => ({
  id: 'codex_v1', family: 'codex', version: 1, name: 'local audit',
  market: 'crypto', timeframe: '1d', cadence: 'fast', universe: ['A'], benchSym: 'A',
  params: {}, lookback: 1, decide: () => null, ...over,
});
const noLimits = { minCash: 0, maxPositionWeight: 1, dailyLossLimit: 0, weeklyLossLimit: 0, maxDrawdownHalt: 0 };
const goodBt = {
  holdout: { totalReturn: 0.2, mdd: 0.03, sharpe: 1.5, trades: 120, bench: { mdd: 0.2, sharpe: 0.5 }, riskMatched: { weight: 0.4, totalReturn: 0.1, mdd: 0.1, sharpe: 0.6, cash: 'bond' } },
  holdout2x: { totalReturn: 0.1 }, years: 12, totalTrades: 140, dsr: 0.99, trials: 10,
};
const goodPaper = { days: 30, bars: 25, decisions: 25, rebalances: 14, trades: 25, mdd: 0.01, agreement: { matched: 5, total: 5 } };

test('[B01] no development data before the frozen cut-off → no evaluation (no hold-out leak)', () => {
  const frozen = JSON.parse(readFileSync(new URL('../backtest/holdout.json', import.meta.url), 'utf8'))['crypto:1h:KRW-BTC'];
  const s = strategy({ timeframe: '1h', universe: ['KRW-BTC'], benchSym: 'KRW-BTC',
    params: { weight: 0 }, grid: { weight: [0, 0.5] }, risk: noLimits,
    decide: (c) => c.barIndex === 0 ? { targets: { 'KRW-BTC': c.params.weight } } : null });
  const run = (sign) => {
    const bars = Array.from({ length: 400 }, (_, i) => bar(frozen + (i + 1) * HOUR, 1e7 * Math.exp(sign * (0.001 * i + 0.0002 * Math.sin(i)))));
    assert.ok(bars.every((b) => b.t > frozen)); // there is NO development-period input
    return evaluateStrategy(s, { crypto1h: { 'KRW-BTC': bars }, source: 'audit' });
  };
  // fixed: without development data before the frozen cut-off there is no evaluation at all
  assert.equal(run(1), null);
  assert.equal(run(-1), null);
});

test('[B03] base strategy DSR includes the persisted research ledger', () => {
  const ledger = JSON.parse(readFileSync(new URL('../backtest/trials.json', import.meta.url), 'utf8'));
  assert.ok(ledger.etf_trend.count >= 11);
  assert.equal(trialsFor(byId.etf_trend_v1), 1); // static count unchanged…
  assert.ok(ledgerTrials('etf_trend') >= 11);       // …but the runner now adds the ledger to the base DSR
});

test('[B04] missing backtest evidence fails closed', () => {
  for (const bt of [{}, { holdout: goodBt.holdout, totalTrades: 140 }]) {
    const ev = evaluateStage({ strategy: strategy(), bt, paper: goodPaper });
    assert.equal(ev.stage, 'bt_failed');
    assert.ok(ev.checks.some((c) => !c.ok && c.text.includes('필수 검증 자료')));
  }
  {
    const ev = evaluateStage({ strategy: strategy(), bt: goodBt, paper: goodPaper });
    assert.equal(ev.stage, 'live_candidate'); // complete evidence still passes
  }
});

test('[B05] stale agreement for an older last_t no longer promotes', async () => {
  const DB = makeD1(), s = byId.etf_dip_v1;
  const t0 = dayT('2026-09-01'), last = t0 + 24 * DAY, now = last + DAY;
  const state = createState(1e7);
  Object.assign(state, { epochT: t0, startT: t0, bars: 200, lastT: last });
  const id = `${s.id}:paper`;
  const points = Array.from({ length: 25 }, (_, i) => ({ t: t0 + i * DAY, equity: 1e7, cash: 1e7, invested: 0, bench: 1e7 }));
  const fills = Array.from({ length: 25 }, (_, i) => ({ t: t0 + i * DAY, seq: 0, sym: '278530', side: 'BUY', qty: 1, price: 100, gross: 100, fee: 0, tax: 0, pnl: 0, reason: 'local audit', cash: 1e7 }));
  await DB.batch([runUpsertStmt(DB, { id, strategy_id: s.id, mode: 'paper', state, start_after: t0 - DAY, last_t: last }),
    ...equityStmts(DB, id, points), ...fillStmts(DB, id, fills), backtestStmt(DB, s.id, 'wf', 'audit', goodBt, null)]);
  const kv = { [`agree:${s.id}`]: { matched: 5, total: 5, checkedT: t0, at: now } };
  const rows = await lifecycleTask({ DB }, kv, now);
  // fixed: the cached 5/5 was checked at an older last_t, so it no longer counts (ledger too long to replay this tick)
  assert.notEqual(rows.find((r) => r.id === s.id).stage, 'live_candidate');
  assert.notEqual(kv[`agree:${s.id}`].checkedT, last);
  DB.raw.close();
});

test('[B06] duplicate stored fills do not pass one-to-one agreement', async () => {
  const DB = makeD1();
  const s = strategy({ decide: (c) => c.barIndex === 0 ? { targets: { A: 0.3 } } : null });
  const start = dayT('2026-10-01'), bars = [bar(start), bar(start + DAY)];
  await DB.batch(candleStmts(DB, 'crypto', '1d', 'A', bars, 'audit'));
  const run = { id: 'codex_v1:paper', strategy_id: s.id, mode: 'paper', state: createState(1e7), start_after: start - DAY, last_t: null };
  const replay = await advanceRun({ DB, MARKET_SIGNALS_ENABLED: 'false' }, {}, s, structuredClone(run), start + DAY, 20);
  assert.equal(replay.fills.length, 1);
  const f = replay.fills[0];
  await DB.batch(fillStmts(DB, run.id, [{ ...f, seq: 0 }, { ...f, seq: 1 }]));
  run.last_t = start + DAY;
  const agreement = await signalAgreement({ DB, MARKET_SIGNALS_ENABLED: 'false' }, {}, s, run);
  assert.deepEqual({ matched: agreement.matched, total: agreement.total }, { matched: 1, total: 2 });
  DB.raw.close();
});

test('[B07] futures results respond to cost stress', () => {
  const s = strategy({ createState: createFutState, stepper: stepFutures, params: { fundingPer8h: 0 },
    decideFutures: (c) => c.barIndex === 0 ? { order: { action: 'open', side: 1, size: 0.5, reason: 'open' } }
      : c.barIndex === 2 ? { order: { action: 'close', reason: 'close' } } : null });
  const args = { strategy: s, series: { A: [100, 100, 110, 110].map((p, i) => bar((i + 1) * DAY, p)) } };
  const a = runBacktest(args), b = runBacktest({ ...args, costs: stressCosts(mergeCosts('crypto'), 20) });
  assert.equal(a.fills.length, 2);
  assert.ok(b.metrics.totalReturn < a.metrics.totalReturn); // stress now costs more
});

test('[B08] profitable short exits count as wins', () => {
  const s = strategy({ createState: createFutState, stepper: stepFutures, params: { fundingPer8h: 0 },
    decideFutures: (c) => c.barIndex === 0 ? { order: { action: 'open', side: -1, size: 0.5, reason: 'short' } }
      : c.barIndex === 2 ? { order: { action: 'close', reason: 'close' } } : null });
  const r = runBacktest({ strategy: s, series: { A: [100, 100, 90, 90].map((p, i) => bar((i + 1) * DAY, p)) } });
  assert.ok(r.fills.find((f) => f.side === 'BUY').pnl > 0);
  assert.ok(r.metrics.totalReturn > 0);
  assert.equal(r.metrics.winRate, 1);
});

test('[B09] full-cash crypto buy still fills after fee rounding', () => {
  const costs = mergeCosts('crypto');
  const qty = affordableQty(10000, 100, costs);
  assert.ok(qty * 100 + feesFor('BUY', qty * 100, costs).fee <= 10000 + 1e-9);
  const state = createState(10000);
  state.pending = [{ sym: 'A', side: 'BUY', qty: 100 }];
  const r = stepBar(state, DAY, new Feed({ A: [bar(DAY)] }), buildOpts(strategy(), { costs: { ...costs, slippage: 0, tickRound: null } }));
  assert.equal(r.fills.length, 1);
  assert.ok(state.cash >= 0);
});

test('[B10] sub-cent crypto fill keeps its real price', () => {
  const state = createState(1e7);
  state.pending = [{ sym: 'A', side: 'BUY', qty: 1e7 }];
  const r = stepBar(state, DAY, new Feed({ A: [bar(DAY, 0.0012)] }), buildOpts(strategy()));
  assert.equal(r.fills.length, 1);
  assert.ok(r.fills[0].gross > 5000);
  assert.ok(r.fills[0].price > 0);
});

test('[B11] SELL below the minimum order value is not executed', () => {
  const state = createState(10000);
  state.pos.A = { qty: 1, cost: 1000, entryT: 0 };
  state.pending = [{ sym: 'A', side: 'SELL', all: true, qty: 1 }];
  const r = stepBar(state, DAY, new Feed({ A: [bar(DAY, 1000)] }), buildOpts(strategy()));
  assert.equal(r.fills.length, 0);
  assert.equal(state.pos.A.qty, 1); // dust kept, not "sold"
  assert.ok(r.events.some((e) => e.kind === 'order_cancel'));
});

test('[B12] holding outside the universe is valued at its current price', () => {
  const state = createState(10000);
  state.cash = 9000; state.pos.B = { qty: 10, cost: 1000, entryT: 0 }; state.lastPx.B = 100;
  const r = stepBar(state, DAY, new Feed({ A: [bar(DAY)], B: [bar(DAY, 50)] }), buildOpts(strategy()));
  assert.equal(r.point.equity, 9500);
  assert.equal(state.lastPx.B, 50);
});

test('[B13] 2026-09-28 (Monday after Chuseok) is a trading day', () => {
  assert.equal(isKrxBusinessDay(dayT('2026-09-28')), true);
  assert.equal(nextKrxBusinessDay(dayT('2026-09-23')), dayT('2026-09-28'));
  assert.equal(latestFinalKrxDay(kstAt(dayT('2026-09-28'), 17)), dayT('2026-09-28'));
});

test('[B14] volatility breakout exits at the 09 KST open', () => {
  const midnight = dayT('2026-11-16'); // 09:00 KST
  const bars = Array.from({ length: 170 }, (_, i) => bar(midnight + (i - 168) * HOUR));
  const state = createState(1e7);
  state.cash = 9e6; state.pos['KRW-BTC'] = { qty: 1e4, cost: 1e6, entryT: midnight - 6 * HOUR };
  state.lastPx['KRW-BTC'] = 100;
  const s = { ...volBreakoutV1, universe: ['KRW-BTC'], risk: noLimits };
  const feed = new Feed({ 'KRW-BTC': bars }), opts = buildOpts(s);
  assert.equal(stepBar(state, midnight - HOUR, feed, opts).fills.length, 0);
  assert.equal(state.pending.length, 1); // decided at the close of the 08-09 KST bar
  const exit = stepBar(state, midnight, feed, opts).fills[0];
  assert.equal(exit.side, 'SELL');
  assert.equal(exit.t, midnight); // fills at the 09:00 KST open
});

test('[B15] concurrent failed logins accumulate (atomic upsert)', async () => {
  const DB = makeD1();
  const env = { DB, OWNER_PASSWORD: crypto.randomUUID() }; // synthetic, process-local
  const request = new Request('https://audit.invalid/login');
  await Promise.all(Array.from({ length: 8 }, () => recordLogin(request, env, false, 1800000000)));
  const row = DB.raw.prepare('SELECT failures, blocked_until FROM login_rate_limits').get();
  assert.equal(row.failures, 8);
  assert.equal(row.blocked_until, 1800000000 + 1800);
  // a failure after the window resets the count
  await recordLogin(request, env, false, 1800000000 + 3600);
  assert.equal(DB.raw.prepare('SELECT failures FROM login_rate_limits').get().failures, 1);
  DB.raw.close();
});

test('[B16] strategy card renders without ReferenceError', () => {
  const html = dashboardHtml();
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const ctx = vm.createContext({ console, setInterval() {}, setTimeout() {}, clearTimeout() {},
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, AbortController,
    document: { addEventListener() {}, querySelector: () => ({ addEventListener() {}, innerHTML: '', style: {}, classList: { add() {}, remove() {} } }), querySelectorAll: () => [] },
    fetch: () => new Promise(() => {}) });
  vm.runInContext(js, ctx);
  const s = { ...byId.etf_trend_v1, stage: 'paper', label: 'paper', paper: null, curve: [], positions: [], recent: [], pending: [], risk: noLimits, checks: [] };
  ctx.auditStrategy = s;
  assert.doesNotThrow(() => vm.runInContext('stratCard(auditStrategy)', ctx));
});

test('[control] RSS pubDate is preserved and old headlines are excluded', async () => {
  const xml = '<rss><item><title>old headline</title><pubDate>Sat, 01 Jan 2000 00:00:00 GMT</pubDate></item></rss>';
  assert.equal(parseRssTitles(xml)[0].t, 946684800);
  const now = dayT('2026-11-16');
  const items = await FEEDS.find((f) => f.id === 'news_kr').fetch(async () => new Response(xml), {}, now);
  assert.equal(items.length, 0);
});

test('[B17] summary marks 101 queued events in chunks within the D1 bind limit', async () => {
  const DB = makeD1(), now = kstAt(dayT('2026-11-16'), 8, 40);
  const insert = DB.raw.prepare("INSERT INTO events (t,kind,message,notified) VALUES (1,'halt',?,2)");
  for (let i = 0; i < 101; i++) insert.run(`local audit ${i}`);
  const capped = { batch: DB.batch.bind(DB), prepare(sql) {
    const st = DB.prepare(sql);
    return { bind(...args) { if (args.length > 100) throw new Error('D1 maximum bound parameters exceeded'); return st.bind(...args); },
      all: st.all.bind(st), first: st.first.bind(st), run: st.run.bind(st) };
  } };
  let sends = 0;
  const env = { DB: capped, TELEGRAM_BOT_TOKEN: crypto.randomUUID(), TELEGRAM_CHAT_ID: 'local-only' };
  await scheduledSummary(env, now, { fetcher: async () => { sends++; return new Response('{"ok":true}'); } });
  assert.equal(sends, 1);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM events WHERE notified=2').get().n, 0);
  DB.raw.close();
});

test('[B18] paperTask processes bars that follow an empty short load window', async () => {
  const DB = makeD1(), start = dayT('2026-11-01');
  const s = strategy({ timeframe: '1h' }), id = `${s.id}:paper`;
  await DB.batch([runUpsertStmt(DB, { id, strategy_id: s.id, mode: 'paper', state: createState(1e7), start_after: start, last_t: start }),
    ...candleStmts(DB, 'crypto', '1h', 'A', [bar(start + 12 * HOUR), bar(start + 13 * HOUR)], 'audit')]);
  await paperTask({ DB, MARKET_SIGNALS_ENABLED: 'false' }, { 'ready:crypto:1h': start + 13 * HOUR }, start + DAY, { strategies: [s] });
  assert.equal(DB.raw.prepare('SELECT last_t FROM runs WHERE id = ?').get(id).last_t, start + 13 * HOUR);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM equity').get().n, 2); // both later bars were processed
  DB.raw.close();
});

test('[B19] allocator drops a halted strategy to 0 immediately', () => {
  const a = allocate([{ id: 'A', stage: 'halted', dailyReturns: [] }, { id: 'base', benchmarkOnly: true }],
    { t: 0, weights: { A: 0.4, base: 0.6 } }, 8 * DAY);
  assert.equal(a.weights.A, undefined);
  assert.match(a.notes.A, /0%/);
  // even inside the 7-day interval a disqualified strategy is removed at once
  const b = allocate([{ id: 'A', stage: 'halted', dailyReturns: [] }, { id: 'base', benchmarkOnly: true }], { t: 0, weights: { A: 0.4, base: 0.6 } }, 1 * DAY);
  assert.equal(b.weights.A, undefined);
});

test('[S02] (known, not fixed yet) overview equity/fill queries are full scans', () => {
  const DB = makeD1();
  const plans = [
    ["SELECT run_id,t,equity,bench FROM equity WHERE run_id LIKE '%:paper' AND (t % 86400)=0 ORDER BY run_id,t", []],
    ["SELECT run_id,t FROM fills WHERE run_id LIKE '%:paper' ORDER BY t DESC,seq DESC LIMIT 60", []],
  ];
  for (const [sql, args] of plans) {
    const details = DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((x) => x.detail).join('; ');
    assert.match(details, /SCAN/);
  }
  DB.raw.close();
});

test('[control] all strategy registration remains readable without real order APIs', () => {
  assert.ok(STRATEGIES.length >= 15);
});
