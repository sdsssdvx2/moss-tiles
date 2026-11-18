// 2026-11-18 점검: heartbeat + /health stall detection, stage-event repeat fix, cash-substitute exemption in overlays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { healthReport, errTasks, heartbeatStmts } from '../src/jobs/health.js';
import { lifecycleTask } from '../src/jobs/lifecycle.js';
import { backtestStmt, kvSetStmt } from '../src/db/store.js';
import { dayT, DAY, HOUR, kstAt, latestFinalKrxDay, latestFinalCryptoDay, latestFinalHour, prevKrxBusinessDay } from '../src/core/calendar.js';
import { etfTrendAiV1, etfTrendVetoV1 } from '../src/strategies/research-set.js';
import { CASH_LIKE_EXEMPT_FROM } from '../src/config.js';
import worker from '../src/worker.js';

const NOW = kstAt(dayT('2026-11-18'), 14, 25); // Wed 14:25 KST
const freshKv = (now = NOW) => ({
  'tick:last': { t: now - 300 },
  'ready:krx:1d': prevKrxBusinessDay(latestFinalKrxDay(now)), // official file arrives next morning: 1 day lag is normal
  'ready:crypto:1d': latestFinalCryptoDay(now),
  'ready:crypto:1h': latestFinalHour(now),
  'lc:at': now - 3600,
});

test('healthReport: fresh state is ok; stale tick / data lag / recent task error are problems', () => {
  assert.deepEqual(healthReport(freshKv(), [], NOW).problems, []);
  const stale = healthReport({ ...freshKv(), 'tick:last': { t: NOW - 3 * HOUR } }, [], NOW);
  assert.equal(stale.ok, false);
  assert.ok(stale.problems.some((p) => p.startsWith('tick:stale')));
  const krx = healthReport({ ...freshKv(), 'ready:krx:1d': latestFinalKrxDay(NOW) - 10 * DAY }, [], NOW);
  assert.ok(krx.problems.some((p) => p.startsWith('krx1d:lag')));
  const c1h = healthReport({ ...freshKv(), 'ready:crypto:1h': latestFinalHour(NOW) - 6 * HOUR }, [], NOW);
  assert.ok(c1h.problems.some((p) => p.startsWith('crypto1h:lag')));
  const err = healthReport({ ...freshKv(), 'tick:lastErr': { t: NOW - 600, tasks: ['paper'], detail: ['paper:ERR:secret-ish text'] } }, [], NOW);
  assert.deepEqual(err.problems, ['task:error:paper']);
  assert.ok(!JSON.stringify(err).includes('secret-ish')); // error texts are never exposed
  // failing core source is a problem; failing optional feed is only listed
  const src = healthReport(freshKv(), [{ source: 'upbit:1h', last_ok: NOW - 7200, last_err: NOW - 60 }, { source: 'feed:news_kr', last_ok: NOW - 7200, last_err: NOW - 60 }], NOW);
  assert.deepEqual(src.problems, ['source:upbit:1h']);
  assert.deepEqual(src.checks.failingSources, ['upbit:1h', 'feed:news_kr']);
});

test('errTasks / heartbeat keep only task names in tick:last', () => {
  assert.deepEqual(errTasks(['crypto1h', 'paper:ERR:boom', 'notify:ERR:x', 'paper:ERR:again']), ['paper', 'notify']);
  const DB = makeD1();
  return DB.batch(heartbeatStmts(DB, NOW, ['crypto1h', 'paper:ERR:boom'])).then(() => {
    const rows = Object.fromEntries(DB.raw.prepare("SELECT k, v FROM kv WHERE k LIKE 'tick:%'").all().map((r) => [r.k, JSON.parse(r.v)]));
    assert.deepEqual(rows['tick:last'].log, ['crypto1h', 'paper:ERR']);
    assert.deepEqual(rows['tick:lastErr'].tasks, ['paper']);
    DB.raw.close();
  });
});

test('/health reads the heartbeat; ?strict=1 answers 503 when stalled', async () => {
  const DB = makeD1();
  const env = { DB };
  const ctx = { waitUntil() {} };
  // nothing recorded yet -> not ok
  let r = await worker.fetch(new Request('https://x/health?strict=1'), env, ctx);
  assert.equal(r.status, 503);
  let body = await r.json();
  assert.equal(body.liveOrders, false);
  assert.ok(body.problems.includes('tick:none'));
  // fresh heartbeat + data -> ok (uses the real clock inside the handler)
  const now = Math.floor(Date.now() / 1000);
  await DB.batch(Object.entries(freshKv(now)).map(([k, v]) => kvSetStmt(DB, k, v)));
  r = await worker.fetch(new Request('https://x/health?strict=1'), env, ctx);
  body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  DB.raw.close();
});

test('lifecycle: a superseded version is not re-announced on every full pass', async () => {
  const DB = makeD1();
  const goodBt = {
    holdout: { totalReturn: 0.2, mdd: 0.03, sharpe: 1.5, trades: 120, bench: { mdd: 0.2, sharpe: 0.5 }, riskMatched: { weight: 0.4, totalReturn: 0.1, mdd: 0.1, sharpe: 0.6, cash: 'bond' } },
    holdout2x: { totalReturn: 0.1 }, years: 12, totalTrades: 140, dsr: 0.99, trials: 10,
  };
  const variants = [{ id: 'etf_trend_v2', base: 'etf_trend_v1', version: 2, params: { sma: 100 }, trials: 11 }];
  await DB.batch([backtestStmt(DB, 'etf_trend_v1', 'wf', 't', goodBt, null), backtestStmt(DB, 'etf_trend_v2', 'wf', 't', goodBt, null)]);
  for (let i = 0; i < 3; i++) {
    const rows = await lifecycleTask({ DB }, { variants }, NOW + i * 7 * HOUR);
    assert.equal(rows.find((r) => r.id === 'etf_trend_v1').stage, 'retired');
  }
  const n = DB.raw.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'stage' AND strategy_id = 'etf_trend_v1'").get().n;
  assert.equal(n, 0); // was 1 per pass before the fix ("새 버전으로 대체됨 → 모의 검증 중")
  DB.raw.close();
});

test('AI / 뉴스 거부권 overlays leave the cash substitute (153130) alone from the effective bar on', () => {
  const ctxAt = (t) => ({
    t, barIndex: 0, params: etfTrendAiV1.params, weights: {}, positions: {}, avgCost: {}, mem: {},
    closes: (sym, n) => Array.from({ length: n }, (_, i) => 100 - i * 0.01), // falling -> only the bond target
    history: () => [],
    signals: { aiRequired: true, vetoRequired: true, ai: {}, veto: { value: 1, note: 'test' } },
  });
  const before = CASH_LIKE_EXEMPT_FROM - 7 * DAY, after = CASH_LIKE_EXEMPT_FROM;
  const ai0 = etfTrendAiV1.decide(ctxAt(before)), ai1 = etfTrendAiV1.decide(ctxAt(after));
  assert.ok(ai1.targets['153130'] > 0.02);
  assert.equal(ai0.targets['153130'], ai1.targets['153130'] * 0.5); // old rule kept for already stored bars (replay 1:1)
  assert.ok(!ai1.reasons['153130'].includes('AI 판단'));
  const v0 = etfTrendVetoV1.decide(ctxAt(before)), v1 = etfTrendVetoV1.decide(ctxAt(after));
  assert.equal(v0.targets['153130'], 0); // veto used to block parking idle money in the bond ETF
  assert.ok(v1.targets['153130'] > 0.02);
});

test('dashboard: "왜 숫자가 잘 안 바뀌나요" notice renders from overview data', async () => {
  const vm = (await import('node:vm')).default;
  const { dashboardHtml } = await import('../src/ui/dashboard.js');
  const html = dashboardHtml();
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const ctx = vm.createContext({ console, setInterval() {}, setTimeout() {}, clearTimeout() {},
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, AbortController,
    document: { addEventListener() {}, querySelector: () => ({ addEventListener() {}, innerHTML: '', style: {}, classList: { add() {}, remove() {} } }), querySelectorAll: () => [] },
    fetch: () => new Promise(() => {}) });
  vm.runInContext(js, ctx);
  ctx.auditData = { strategies: [
    { market: 'krx', timeframe: '1d', stage: 'paper', paper: { ret: 0 }, curve: [{}, {}], positions: [{ sym: '153130' }] },
    { market: 'crypto', timeframe: '1d', stage: 'paper', paper: { ret: 0 }, curve: [{}, {}, {}], positions: [{ sym: 'KRW-BTC' }] },
    { market: 'krx', timeframe: '1d', stage: 'benchmark', benchmarkOnly: true, paper: { ret: 0 }, curve: [], positions: [] },
  ] };
  const out = vm.runInContext('DATA=auditData; pace()', ctx);
  assert.match(out, /국내 2거래일 · 코인 3일째/);
  assert.match(out, /2개 중 <b>1개가 현금·단기채권만/);
});
