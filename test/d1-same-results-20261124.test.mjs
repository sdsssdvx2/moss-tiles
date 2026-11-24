// 2026-11-24 #F-011: D1 읽기 줄이기(#F-010)는 '같은 결과를 덜 읽고 내는 것'만 — 고치기 전(색인 없음·계량 없음)과 뒤(색인·계량)를
// 같은 입력으로 돌려 틱 결과(시세·모의 장부 상태·체결·평가액·신호·평가 단계·이벤트·kv)가 차이 0인 것을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeBars } from './helpers.mjs';
import { tick } from '../src/jobs/tick.js';
import { dayT, ymd, ymdCompact, kstAt } from '../src/core/calendar.js';
import { AI_SYMBOLS } from '../src/jobs/ai.js';
import { signalsFor } from '../src/jobs/paper.js';
import { guardFor } from '../src/jobs/market-signals.js';
import { byId } from '../src/strategies/index.js';
import { meteredDB } from '../src/db/meter.js';

const NOW = kstAt(dayT('2026-11-16'), 10, 5);
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

const aiAnswer = JSON.stringify({ scores: AI_SYMBOLS.map((sym, i) => ({ sym, score: [0.4, -0.2, 0.6, 0.1][i], basis: ['trend'], reason: '시험' })), veto: { krx: 'NO_VETO', crypto: 'NO_VETO' } });
const envOf = (DB) => ({ DB, COLLECT_ENABLED: 'true', DATA_TASKS_PER_TICK: '3', FEEDS_ENABLED: 'true', AI: { run: async () => ({ response: aiAnswer }) }, AI_PROVIDER: 'workers-ai' });
const dump = (DB) => {
  const q = (sql) => DB.raw.prepare(sql).all();
  return {
    candles: q('SELECT market, tf, sym, t, o, h, l, c, v FROM candles ORDER BY market, tf, sym, t'),
    runs: q('SELECT id, strategy_id, mode, state, start_after, last_t FROM runs ORDER BY id'),
    fills: q('SELECT * FROM fills ORDER BY run_id, t, seq'),
    equity: q('SELECT * FROM equity ORDER BY run_id, t'),
    signals: q('SELECT * FROM signals ORDER BY sym, t, kind'),
    lifecycle: q('SELECT strategy_id, stage, label, summary, checks, paper_since, promoted_t FROM lifecycle ORDER BY strategy_id'),
    events: q('SELECT t, kind, strategy_id, message FROM events ORDER BY id'),
    kv: q("SELECT k, v FROM kv WHERE k NOT IN ('d1:reads', 'd1:reads:hist') ORDER BY k"),
  };
};

test('same input → identical tick results before (no index, no meter) and after (index + meter): 30 ticks', async () => {
  const before = makeD1(), after = makeD1();
  before.raw.exec('DROP INDEX signals_kind_t'); // 고치기 전 스키마
  const fb = mockFetch(), fa = mockFetch();
  for (let i = 0; i < 30; i++) {
    await tick(envOf(before), NOW + i * 600, { fetcher: fb, meter: { total: 0, byTask: {} } }); // meter를 넘기면 DB를 감싸지 않음 = 계량 없음
    await tick(envOf(after), NOW + i * 600, { fetcher: fa }); // 지금 코드: 색인 + 계량
  }
  const a = dump(before), b = dump(after);
  assert.ok(a.runs.length >= 5 && a.signals.some((r) => r.kind === 'ai_score'), JSON.stringify({ runs: a.runs.length, eq: a.equity.length, sig: a.signals.length }));
  for (const k of Object.keys(a)) assert.deepEqual(b[k], a[k], k);
  // 고친 뒤 쪽에만 계량 기록이 있음(결과 표에는 안 섞임)
  assert.ok(after.raw.prepare("SELECT v FROM kv WHERE k = 'd1:reads'").get());
  assert.ok(!before.raw.prepare("SELECT v FROM kv WHERE k = 'd1:reads'").get());
});

test('the two lookups the index changes give the same per-bar answers (ties on the same time included), metered or not', async () => {
  const seed = (DB) => {
    const ins = DB.raw.prepare('INSERT INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
    for (let d = 0; d < 40; d++) {
      const t = NOW - (40 - d) * 21600;
      for (const [i, sym] of AI_SYMBOLS.entries()) { ins.run(sym, t, 'ai_score', ((d * 7 + i * 3) % 11) / 10 - 0.5, `r${d}${i}`); ins.run(sym, t, 'ai_score_disc', ((d + i) % 5) / 5 - 0.4, `d${d}${i}`); }
      ins.run('*krx', t, 'news_veto', d % 3 === 0 ? 1 : 0, `v${d}`); ins.run('*crypto', t, 'news_veto', d % 4 === 0 ? 1 : 0, `c${d}`);
      ins.run('*', t, 'risk_snap', 0, JSON.stringify({ altHold: d % 2 ? 'hold' : null }));
      ins.run('KRW-XRP', t, 'risk_block', d % 3, `b${d}`); ins.run('KRW-BTC', t, 'risk_block', 1, `bb${d}`);
      ins.run('*', t, 'risk_damp', 0.5 + (d % 3) / 10, `damp${d}`);
      for (let j = 0; j < 30; j++) ins.run(`X${j}`, t, 'etf_nav', 100 + j, '{}'); // 다른 종류가 많은 표(운영의 etf_nav처럼)
    }
  };
  const before = makeD1(), after = makeD1();
  before.raw.exec('DROP INDEX signals_kind_t');
  seed(before); seed(after);
  const meter = { total: 0, byTask: {}, cur: 'x' };
  const envB = { DB: before }, envA = { DB: meteredDB(after, meter), AI: { run: async () => ({}) } };
  envB.AI = envA.AI;
  const from = NOW - 40 * 21600, toT = NOW;
  const bars = Array.from({ length: 60 }, (_, i) => from + i * 3600 * 4);
  for (const id of ['etf_trend_ai_v1', 'crypto_trend_ai_v1', 'etf_trend_aidisc_v1', 'crypto_trend_veto_v1']) {
    const s = byId[id];
    const fb = await signalsFor(envB, s, from, toT), fa = await signalsFor(envA, s, from, toT);
    for (const t of bars) assert.deepEqual(fa(t), fb(t), `${id} ${t}`);
  }
  for (const id of ['crypto_trend_v1', 'crypto_trend1h_v1']) {
    const s = byId[id];
    const gb = await guardFor(envB, s, from, toT), ga = await guardFor(envA, s, from, toT);
    assert.ok(gb && ga, id);
    for (const t of bars) assert.deepEqual(ga(t), gb(t), `${id} ${t}`);
  }
  const plan = (DB, sql) => DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plan(after, "SELECT * FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp') AND t >= 1 AND t <= 2 ORDER BY t"), /signals_kind_t/);
  assert.doesNotMatch(plan(before, "SELECT * FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp') AND t >= 1 AND t <= 2 ORDER BY t"), /signals_kind_t/);
});
