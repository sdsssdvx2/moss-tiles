import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeBars } from './helpers.mjs';
import { tick } from '../src/jobs/tick.js';
import { kvAll, candleStmts, kvSetStmt, getRuns } from '../src/db/store.js';
import { paperTask, workerBacktestTask } from '../src/jobs/paper.js';
import { lifecycleTask, signalAgreement } from '../src/jobs/lifecycle.js';
import { overview, exportSignals } from '../src/api.js';
import { extractKrxRows, parseNaverChart } from '../src/data/krx.js';
import { parseUpbitCandles } from '../src/data/upbit.js';
import { byId } from '../src/strategies/index.js';
import { dayT, ymd, ymdCompact, DAY, kstAt, isKrxBusinessDay } from '../src/core/calendar.js';
import { KRX_ALL } from '../src/config.js';
import worker from '../src/worker.js';

const NOW = kstAt(dayT('2026-11-16'), 10, 5); // Monday 10:05 KST

function upbitRows(bars, tf, market) {
  return bars.map((b) => ({ market, candle_date_time_utc: tf === '1d' ? `${ymd(b.t)}T00:00:00` : new Date(b.t * 1000).toISOString().slice(0, 19), opening_price: b.o, high_price: b.h, low_price: b.l, trade_price: b.c, candle_acc_trade_volume: b.v })).reverse();
}
function mockFetch() {
  const daily = {}, hourly = {}, naver = {};
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(u.hostname + u.pathname);
    if (u.hostname === 'api.upbit.com') {
      if (u.pathname.includes('market/all')) return Response.json([{ market: 'KRW-BTC', market_event: { warning: false } }, { market: 'KRW-PUMP', market_event: { warning: true } }]);
      if (u.pathname.includes('ticker/all')) return Response.json(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-USDT', 'KRW-PUMP'].map((m, i) => ({ market: m, acc_trade_price_24h: 1e12 - i })));
      const m = u.searchParams.get('market'), tf = u.pathname.includes('days') ? '1d' : '1h';
      const store = tf === '1d' ? daily : hourly;
      if (!store[m]) store[m] = tf === '1d' ? makeBars({ start: '2025-06-01', n: 600, seed: m.length * 7, p0: 50_000_000, vol: 0.03 }).filter((b) => b.t <= dayT('2026-11-16')) : makeBars({ n: 3000, seed: 3 }).map((b, k) => ({ ...b, t: NOW - (NOW % 3600) - (3000 - k) * 3600 }));
      const to = u.searchParams.get('to') ? Date.parse(u.searchParams.get('to')) / 1000 : Infinity;
      const rows = store[m].filter((b) => b.t < to).slice(-Number(u.searchParams.get('count')));
      return Response.json(upbitRows(rows, tf, m));
    }
    if (u.hostname === 'fchart.stock.naver.com') {
      const s = u.searchParams.get('symbol');
      if (!naver[s]) naver[s] = makeBars({ start: '2024-01-02', n: 900, seed: Number(s.slice(0, 3)) + 1, skipNonKrx: true, p0: 30000 }).filter((b) => b.t <= dayT('2026-11-13'));
      const rows = naver[s].slice(-Number(u.searchParams.get('count')));
      return new Response(`<chartdata>${rows.map((b) => `<item data="${ymdCompact(b.t)}|${Math.round(b.o)}|${Math.round(Math.max(b.h, b.o, b.c))}|${Math.round(Math.min(b.l, b.o, b.c))}|${Math.round(b.c)}|${b.v}" />`).join('')}</chartdata>`, { headers: { 'content-type': 'text/xml' } });
    }
    if (u.hostname === 'news.google.com') return new Response('<rss><item><title>비트코인 뉴스</title></item></rss>');
    if (u.hostname === 'api.alternative.me') return Response.json({ data: [{ value: '55', value_classification: 'Greed', timestamp: String(NOW) }] });
    return new Response('nope', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('KRX official extractor picks only wanted rows and handles errors/empty days', () => {
  const doc = JSON.stringify({ OutBlock_1: [
    { BAS_DD: '20261113', ISU_CD: '069500', ISU_NM: 'KODEX 200', TDD_OPNPRC: '85,800', TDD_HGPRC: '86,835', TDD_LWPRC: '82,680', TDD_CLSPRC: '83,115', ACC_TRDVOL: '22,864,154' },
    { BAS_DD: '20261113', ISU_CD: '999999', TDD_OPNPRC: '1', TDD_HGPRC: '1', TDD_LWPRC: '1', TDD_CLSPRC: '1', ACC_TRDVOL: '1' },
    { BAS_DD: '20261113', ISU_CD: '278530', TDD_OPNPRC: '0', TDD_HGPRC: '0', TDD_LWPRC: '0', TDD_CLSPRC: '30530', ACC_TRDVOL: '0' } ] });
  const r = extractKrxRows(doc, ['069500', '278530'], dayT('2026-11-13'));
  assert.deepEqual(Object.keys(r.bars), ['069500']);
  assert.equal(r.bars['069500'].c, 83115);
  assert.equal(extractKrxRows('{"OutBlock_1":[]}', ['069500'], dayT('2026-11-13')).empty, true);
  assert.throws(() => extractKrxRows('{"respMsg":"Unauthorized Key","respCode":"401"}', ['069500'], dayT('2026-11-13')), /KRX_AUTH/);
  assert.equal(parseNaverChart('<item data="20261113|85800|86835|82680|83115|22864154" />')[0].c, 83115);
  assert.equal(parseUpbitCandles([{ candle_date_time_utc: '2026-11-15T00:00:00', opening_price: 1, high_price: 2, low_price: 1, trade_price: 2, candle_acc_trade_volume: 3 }], '1d')[0].t, dayT('2026-11-15'));
});

test('collectors: Upbit hourly/daily + universe + Naver KRX fill D1 incrementally and set readiness', async () => {
  const env = { DB: makeD1(), COLLECT_ENABLED: 'true', DATA_TASKS_PER_TICK: '3', FEEDS_ENABLED: 'true' };
  const f = mockFetch();
  for (let i = 0; i < 25; i++) await tick(env, NOW + i * 600, { fetcher: f });
  const kv = await kvAll(env.DB);
  assert.ok(kv['ready:crypto:1h'] >= NOW - NOW % 3600 - 3600 - 600);
  assert.equal(kv['ready:crypto:1d'], dayT('2026-11-15'));
  assert.equal(kv['ready:krx:1d'], dayT('2026-11-13'));
  assert.deepEqual(kv['crypto:universe'], ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']); // stablecoin + warned market excluded
  const n = env.DB.raw.prepare("SELECT market, tf, COUNT(*) n, MAX(t) mx FROM candles GROUP BY market, tf").all();
  const krx = n.find((r) => r.market === 'krx');
  assert.ok(krx.n >= Object.keys(KRX_ALL).length * 300, JSON.stringify(n));
  assert.ok(krx.mx <= dayT('2026-11-13')); // never stores an unfinished KRX bar
  const c1d = n.find((r) => r.market === 'crypto' && r.tf === '1d');
  assert.ok(c1d.mx <= dayT('2026-11-15')); // in-progress daily candle excluded
  const feeds = env.DB.raw.prepare('SELECT source, COUNT(*) n FROM feed_items GROUP BY source').all();
  assert.ok(feeds.some((x) => x.source === 'news_kr'));
  const health = env.DB.raw.prepare('SELECT source FROM data_health').all().map((x) => x.source);
  assert.ok(health.includes('upbit:1h') && health.includes('naver'));
});

async function seeded() {
  const env = { DB: makeD1(), COLLECT_ENABLED: 'false', OWNER_PASSWORD: 'correct horse battery staple' };
  const stmts = [];
  const krxSyms = Object.keys(KRX_ALL);
  krxSyms.forEach((s, i) => stmts.push(...candleStmts(env.DB, 'krx', '1d', s, makeBars({ start: '2025-01-02', n: 460, seed: 100 + i, skipNonKrx: true, drift: 0.0006, p0: 20000 + i * 1000 }), 'test')));
  for (const [i, s] of ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'].entries()) {
    stmts.push(...candleStmts(env.DB, 'crypto', '1d', s, makeBars({ start: '2025-06-01', n: 520, seed: 200 + i, drift: 0.001, vol: 0.03, p0: 50_000_000 / (i + 1) }), 'test'));
    stmts.push(...candleStmts(env.DB, 'crypto', '1h', s, makeBars({ n: 900, seed: 300 + i, vol: 0.006, p0: 50_000_000 }).map((b, k) => ({ ...b, t: 1_780_000_000 - (1_780_000_000 % 3600) + k * 3600 })), 'test'));
  }
  await env.DB.batch(stmts);
  const krxLast = env.DB.raw.prepare("SELECT MAX(t) m FROM candles WHERE market='krx'").get().m;
  const c1d = env.DB.raw.prepare("SELECT MAX(t) m FROM candles WHERE market='crypto' AND tf='1d'").get().m;
  const c1h = env.DB.raw.prepare("SELECT MAX(t) m FROM candles WHERE market='crypto' AND tf='1h'").get().m;
  // "deploy day": readiness markers 40 bars before the end, then reveal bars gradually
  const kvs = { 'crypto:universe': ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'] };
  for (const [m, tf] of [['krx', '1d'], ['crypto', '1d'], ['crypto', '1h']]) {
    kvs[`cov:${m}:${tf}`] = Object.fromEntries(env.DB.raw.prepare('SELECT sym, MIN(t) min, MAX(t) max FROM candles WHERE market=? AND tf=? GROUP BY sym').all(m, tf).map((r) => [r.sym, { min: r.min, max: r.max }]));
  }
  for (const [k, v] of Object.entries(kvs)) await kvSetStmt(env.DB, k, v).run();
  return { env, krxLast, c1d, c1h };
}

test('paper ledger: forward-only start, incremental steps, fills+equity persisted, signal agreement 100%, overview/export', async () => {
  const { env, krxLast, c1d, c1h } = await seeded();
  const krxDays = env.DB.raw.prepare("SELECT DISTINCT t FROM candles WHERE market='krx' ORDER BY t").all().map((r) => r.t);
  const cDays = env.DB.raw.prepare("SELECT DISTINCT t FROM candles WHERE market='crypto' AND tf='1d' ORDER BY t").all().map((r) => r.t);
  const cHours = env.DB.raw.prepare("SELECT DISTINCT t FROM candles WHERE market='crypto' AND tf='1h' ORDER BY t").all().map((r) => r.t);
  const setReady = async (i) => {
    await env.DB.batch([kvSetStmt(env.DB, 'ready:krx:1d', krxDays[krxDays.length - 60 + i]), kvSetStmt(env.DB, 'ready:crypto:1d', cDays[cDays.length - 60 + i]), kvSetStmt(env.DB, 'ready:crypto:1h', cHours[cHours.length - 60 + i])]);
  };
  await setReady(0);
  let kv = await kvAll(env.DB);
  await paperTask(env, kv, NOW, { maxSteps: 50 }); // creates runs (start_after = ready)
  const runs0 = await getRuns(env.DB);
  assert.ok(runs0.length >= 15);
  assert.ok(runs0.every((r) => r.last_t === null));
  for (let i = 1; i < 60; i++) {
    await setReady(i);
    kv = await kvAll(env.DB);
    for (let k = 0; k < 3; k++) await paperTask(env, kv, NOW, { maxSteps: 50 });
  }
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const r = runs['etf_dip_v1:paper'];
  assert.equal(r.last_t, krxDays[krxDays.length - 1]);
  assert.ok(r.start_after === krxDays[krxDays.length - 60]);
  const eq = env.DB.raw.prepare("SELECT COUNT(*) n, MIN(t) mn FROM equity WHERE run_id='etf_dip_v1:paper'").get();
  assert.equal(eq.n, 59);
  assert.ok(eq.mn > r.start_after); // forward-only
  const fills = env.DB.raw.prepare("SELECT COUNT(*) n FROM fills WHERE run_id LIKE '%:paper'").get().n;
  assert.ok(fills > 5, `fills ${fills}`);
  // accounting identity on stored state
  for (const run of Object.values(runs)) if (run.state.kind !== 'futures') {
    const inv = Object.entries(run.state.pos).reduce((a, [s, p]) => a + p.qty * run.state.lastPx[s], 0);
    assert.ok(Math.abs(run.state.equity - run.state.cash - inv) < 1e-3, run.id);
    assert.ok(run.state.cash >= -1e-6, run.id);
  }
  // signal agreement: replaying the whole paper ledger reproduces every fill
  for (const id of ['etf_dip_v1', 'etf_trend_v1', 'crypto_trend_v1']) {
    const a = await signalAgreement(env, kv, byId[id], runs[`${id}:paper`]);
    assert.equal(a.matched, a.total, id);
  }
  const rows = await lifecycleTask(env, kv, NOW);
  const st = Object.fromEntries(rows.map((x) => [x.id, x.stage]));
  assert.equal(st.krx_dca_v1, 'benchmark');
  assert.equal(st.etf_dip_v1, 'backtest'); // no backtest evidence uploaded yet
  const ov = await overview(env, NOW);
  assert.equal(ov.liveOrders, false);
  const dip = ov.strategies.find((s) => s.id === 'etf_dip_v1');
  assert.ok(dip.curve.length > 10 && dip.paper.fills >= 0);
  const ex = await exportSignals(env);
  assert.ok(ex.strategies.every((s) => s.eligibleForLive === false));
  // worker chunked backtest runs to completion and stores a summary
  kv = await kvAll(env.DB);
  for (let i = 0; i < 1500; i++) { const x = await workerBacktestTask(env, kv, NOW + i); if (!x) break; }
  const bt = env.DB.raw.prepare("SELECT strategy_id FROM backtests WHERE kind='worker'").all().map((x) => x.strategy_id);
  assert.ok(bt.length >= 3, JSON.stringify(bt));
  // 공격형 슬롯: total sleeve -30% -> every sleeve strategy halted, no automatic resume
  for (const r of (await getRuns(env.DB)).filter((x) => ['alt_mom_v1', 'vol_breakout_v1', 'btc_perp_sim_v1'].includes(x.strategy_id) && x.mode === 'paper')) {
    r.state.equity = r.state.initialCash * 0.6;
    env.DB.raw.prepare('UPDATE runs SET state = ? WHERE id = ?').run(JSON.stringify(r.state), r.id);
  }
  kv = await kvAll(env.DB);
  const rows2 = await lifecycleTask(env, kv, NOW + 100);
  assert.ok((await kvAll(env.DB))['sleeve:aggressive:stopped']);
  for (const id of ['alt_mom_v1', 'vol_breakout_v1', 'btc_perp_sim_v1']) assert.equal(rows2.find((x) => x.id === id).stage, 'halted', id);
  assert.notEqual(rows2.find((x) => x.id === 'etf_trend_v1').stage, 'halted');
  const sr = (await getRuns(env.DB)).find((x) => x.id === 'alt_mom_v1:paper');
  assert.ok(sr.state.halted && sr.state.haltBars < -1e9);
});

test('worker fetch: login required, rate-limited login, session cookie, overview, health', async () => {
  const { env } = await seeded();
  const ctx = { waitUntil() {} };
  const h = await worker.fetch(new Request('https://x/health'), env, ctx);
  assert.equal((await h.json()).liveOrders, false);
  assert.equal((await worker.fetch(new Request('https://x/api/overview'), env, ctx)).status, 401);
  const page = await worker.fetch(new Request('https://x/'), env, ctx);
  assert.ok((await page.text()).includes('관리자 비밀번호'));
  const bad = await worker.fetch(new Request('https://x/login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }) }), env, ctx);
  assert.equal(bad.status, 401);
  const ok = await worker.fetch(new Request('https://x/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) }), env, ctx);
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.ok(ok.headers.get('set-cookie').includes('HttpOnly') && ok.headers.get('set-cookie').includes('SameSite=Strict'));
  const ov = await worker.fetch(new Request('https://x/api/overview', { headers: { cookie } }), env, ctx);
  assert.equal(ov.status, 200);
  const dash = await worker.fetch(new Request('https://x/', { headers: { cookie } }), env, ctx);
  assert.ok((await dash.text()).includes('모의투자 연구실'));
  for (let i = 0; i < 8; i++) await worker.fetch(new Request('https://x/login', { method: 'POST', body: new URLSearchParams({ password: 'x' + i }) }), env, ctx);
  const blocked = await worker.fetch(new Request('https://x/login', { method: 'POST', body: new URLSearchParams({ password: env.OWNER_PASSWORD }) }), env, ctx);
  assert.equal(blocked.status, 429);
  const ingest = await worker.fetch(new Request('https://x/api/ingest', { method: 'POST', body: '{}' }), env, ctx);
  assert.equal(ingest.status, 401);
});
