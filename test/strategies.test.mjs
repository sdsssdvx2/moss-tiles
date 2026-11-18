import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STRATEGIES, validateStrategy, byId } from '../src/strategies/index.js';
import { runBacktest } from '../src/core/backtest.js';
import { withNewsVeto, etfTrendV1 } from '../src/strategies/research-set.js';
import { Feed, createState, stepBar } from '../src/core/engine.js';
import { buildOpts } from '../src/core/backtest.js';
import { createFutState, stepFutures, liqPrice } from '../src/core/futures-sim.js';
import { krxMeta, CRYPTO_CORE, KRX_ALL } from '../src/config.js';
import { makeBars } from './helpers.mjs';

function seriesFor(s) {
  const syms = new Set([...s.universe, s.benchSym, ...(s.market === 'crypto' ? CRYPTO_CORE : [])]);
  const out = {};
  let i = 0;
  for (const sym of syms) {
    out[sym] = s.timeframe === '1h'
      ? makeBars({ n: 1500, seed: 11 + i++, vol: 0.006 }).map((b, k) => ({ ...b, t: 1_700_000_000 + k * 3600 }))
      : makeBars({ n: 700, seed: 11 + i++, drift: 0.0008, vol: s.market === 'crypto' ? 0.03 : 0.012, skipNonKrx: s.market === 'krx', p0: s.market === 'crypto' ? 50_000_000 : 30000 });
  }
  return out;
}

test('every registered strategy is valid and runs end-to-end on synthetic data', () => {
  const ids = new Set();
  for (const s of STRATEGIES) {
    assert.deepEqual(validateStrategy(s), [], s.id);
    assert.ok(!ids.has(s.id)); ids.add(s.id);
    const r = runBacktest({ strategy: s, series: seriesFor(s), meta: s.market === 'krx' ? krxMeta : {} });
    assert.ok(r.points.length > 100, s.id);
    assert.ok(r.points.every((p) => Number.isFinite(p.equity) && p.equity >= 0), s.id);
    for (const f of r.fills) assert.ok(typeof f.reason === 'string' && f.reason.length > 3, `${s.id} reason`);
  }
});

test('first research set + baselines are present; research-only flags are set', () => {
  for (const id of ['etf_trend_v1', 'etf_dip_v1', 'crypto_trend_v1', 'krx_dca_v1', 'crypto_dca_v1', 'etf_trend_veto_v1', 'crypto_trend_veto_v1', 'btc_perp_sim_v1']) assert.ok(byId[id], id);
  for (const id of ['krx_trend_v1', 'crypto_mom_v1', 'crypto_trend1h_v1', 'btc_perp_sim_v1', 'etf_trend_veto_v1']) assert.ok(byId[id].researchOnly, id);
  assert.ok(!byId.etf_trend_v1.researchOnly && !byId.etf_dip_v1.researchOnly && !byId.crypto_trend_v1.researchOnly);
});

test('trades produce plain-Korean reasons such as moving-average explanations', () => {
  const s = byId.etf_trend_v1;
  const r = runBacktest({ strategy: s, series: seriesFor(s), meta: krxMeta });
  assert.ok(r.fills.some((f) => /평균/.test(f.reason)), 'reason mentions 평균');
  const d = byId.etf_dip_v1;
  const r2 = runBacktest({ strategy: d, series: seriesFor(d), meta: krxMeta });
  assert.ok(r2.fills.length > 10);
});

test('news veto overlay can only block or halve buys, never create trades; fail-closed when required', () => {
  const base = { id: 'q_v1', family: 'q', version: 1, market: 'krx', timeframe: '1d', universe: ['A'], benchSym: 'A', params: {}, description: 'd', name: 'n',
    decide: (ctx) => ({ targets: { A: ctx.barIndex < 3 ? 0.5 : 0 } }) };
  const v = withNewsVeto(base);
  const ctx = (signals, w = 0) => ({ weights: { A: w }, signals, barIndex: 0 });
  assert.equal(v.decide(ctx({})).targets.A, 0.5);
  assert.equal(v.decide(ctx({ veto: { value: 1 } })).targets.A, 0);
  assert.ok(Math.abs(v.decide(ctx({ veto: { value: 0.5 } }, 0.1)).targets.A - 0.3) < 1e-12);
  assert.equal(v.decide(ctx({ vetoRequired: true })).targets.A, 0);
  const sell = v.decide({ weights: { A: 0.5 }, signals: { veto: { value: 1 } }, barIndex: 5 });
  assert.equal(sell.targets.A, 0); // sells pass through untouched
  const noop = { ...base, decide: () => null };
  assert.equal(withNewsVeto(noop).decide(ctx({ veto: { value: 1 } })), null);
  assert.equal(etfTrendV1.decide.length, 1);
});

test('futures simulation: liquidation price, stop, liquidation on crash, funding cost', () => {
  assert.ok(Math.abs(liqPrice(100, 1, 2, 0.005) - 50.5) < 1e-9);
  assert.ok(Math.abs(liqPrice(100, -1, 2, 0.005) - 149.5) < 1e-9);
  const strat = { ...byId.btc_perp_sim_v1, decideFutures: (ctx) => (ctx.barIndex === 0 ? { order: { action: 'open', side: 1, size: 0.5, stopDist: null, reason: 'go' } } : null) };
  const bars = [100, 100, 100, 40, 40].map((p, i) => ({ t: (i + 1) * 86400, o: p, h: p, l: p, c: p, v: 1 }));
  const feed = new Feed({ 'KRW-BTC': bars });
  const st = createFutState(1_000_000);
  const opts = { strategy: strat, params: strat.params, universe: ['KRW-BTC'] };
  const evs = [];
  for (const b of bars) evs.push(...stepFutures(st, b.t, feed, opts).events);
  assert.equal(st.liquidations, 1);
  assert.ok(evs.some((e) => e.kind === 'liquidation'));
  assert.ok(st.equity < 520_000 && st.equity > 480_000); // lost the isolated 50% margin
  assert.ok(st.funding > 0);
  // stop hit before liquidation
  const strat2 = { ...strat, decideFutures: (ctx) => (ctx.barIndex === 0 ? { order: { action: 'open', side: 1, size: 0.5, stopDist: 10, reason: 'go' } } : null) };
  const bars2 = [100, 100, 95, 85, 85].map((p, i) => ({ t: (i + 1) * 86400, o: p, h: p + 1, l: p - 1, c: p, v: 1 }));
  const st2 = createFutState(1_000_000);
  const feed2 = new Feed({ 'KRW-BTC': bars2 });
  const fills = [];
  for (const b of bars2) fills.push(...stepFutures(st2, b.t, feed2, { ...opts, strategy: strat2 }).fills);
  assert.ok(fills.some((f) => f.reason.includes('손절')));
  assert.equal(st2.liquidations, 0);
});

test('static safety: no live order capability anywhere in src/', () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const forbidden = [/\/v1\/orders?\b/i, /api\.upbit\.com\/v1\/(orders|withdraws|deposits|accounts)/i, /openapi\.koreainvestment\.com/i, /order-cash|order-credit|inquire-balance/i, /access_key|secret_key|appsecret|APP_KEY/i, /fapi\.binance|dapi\.binance/i,
    /okx\.com\/api\/v5\/(trade|account|asset)/i, /bithumb\.com\/(trade|info)\//i, /coinbase\.com\/(orders|accounts)/i, /binance\.(com|vision)\/(api|sapi)\/v\d\/(order|account)/i];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of forbidden) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
  const fetchHosts = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]));
  const allowed = new Set(['api.upbit.com', 'data-dbg.krx.co.kr', 'apis.data.go.kr', 'fchart.stock.naver.com', 'api.telegram.org', 'news.google.com', 'api.alternative.me', 'opendart.fss.or.kr',
    // 코인 시장 신호 (public, read-only market data; risk signals only)
    'api.bithumb.com', 'data-api.binance.vision', 'www.binance.com', 'api.exchange.coinbase.com', 'www.okx.com', 'open.er-api.com', 't.me', 'api.hyperliquid.xyz',
    // read-only news headline RSS (AI 판단 inputs)
    'www.yna.co.kr', 'www.hankyung.com', 'www.blockmedia.co.kr', 'www.tokenpost.kr',
    // 세계 지표·온체인(2026-11-18 밤, 공개·읽기 전용 시세/통계. 주문·계정 경로 없음)
    'query1.finance.yahoo.com', 'api.frankfurter.dev', 'api.coingecko.com', 'api.blockchain.info']);
  for (const h of fetchHosts) assert.ok(allowed.has(h), `unexpected host ${h}`);
});

test('AI scale overlay: no-op without endpoint, 0.5x-1.0x of NEW buys only, fail-closed 0.5x', async () => {
  const { withAiScale, aiMultiplier } = await import('../src/strategies/research-set.js');
  const { parseAiResponse, buildPrompt } = await import('../src/jobs/ai.js');
  const base = { id: 'q_v1', family: 'q', version: 1, market: 'krx', timeframe: '1d', universe: ['A'], benchSym: 'A', params: {}, description: 'd', name: 'n', decide: (ctx) => ({ targets: { A: 0.4 } }) };
  const ai = withAiScale(base);
  assert.equal(ai.id, 'q_ai_v1');
  const c = (signals, w = 0) => ({ weights: { A: w }, signals });
  assert.equal(ai.decide(c({})).targets.A, 0.4);
  assert.equal(ai.decide(c({ aiRequired: true, ai: { A: { score: 1 } } })).targets.A, 0.4);
  assert.ok(Math.abs(ai.decide(c({ aiRequired: true, ai: { A: { score: -1 } } })).targets.A - 0.2) < 1e-12);
  assert.ok(Math.abs(ai.decide(c({ aiRequired: true })).targets.A - 0.2) < 1e-12);
  assert.equal(ai.decide(c({ aiRequired: true, ai: { A: { score: -1 } } }, 0.4)).targets.A, 0.4); // held: untouched
  assert.equal(aiMultiplier(5), 1);
  const p = parseAiResponse('{"scores":[{"sym":"KRW-BTC","score":3,"reason":"x"},{"sym":"EVIL","score":1}],"veto":{"crypto":"REDUCE_HALF"}}');
  assert.deepEqual(p.scores, { 'KRW-BTC': { score: 1, reason: 'x' } });
  assert.equal(p.veto.crypto, 0.5);
  assert.equal(parseAiResponse('not json'), null);
  assert.ok(buildPrompt([{ sym: '*crypto', type: 'headline', payload: '{"title":"비트코인 급락"}' }]).includes('비트코인 급락'));
});

test('feed parsers: RSS titles', async () => {
  const { parseRssTitles } = await import('../src/data/feeds.js');
  const xml = '<rss><channel><item><title><![CDATA[코스피 &amp; 상승]]></title><pubDate>Sat, 14 Nov 2026 01:00:00 GMT</pubDate></item><item><title>둘째</title></item></channel></rss>';
  const r = parseRssTitles(xml);
  assert.equal(r[0].title, '코스피 & 상승');
  assert.equal(r.length, 2);
});
