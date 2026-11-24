// 2026-11-24 사전 등록 후보용 새 ETF 수집(PR A): 새 종목이 늦거나 실패해도 기존 장부의 진행 조건은 그대로 전진해야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeBars } from './helpers.mjs';
import { kvAll, kvSetStmt } from '../src/db/store.js';
import { krxDailyTask, krxBackfillTask, krxCodes, coreKrxCodes } from '../src/jobs/collect.js';
import { CANDIDATE_ETFS, KRX_ETFS, KRX_STOCKS, krxMeta, ETF_GAIN_TAXED } from '../src/config.js';
import { STRATEGIES } from '../src/strategies/index.js';
import { dayT, ymdCompact, kstAt } from '../src/core/calendar.js';

const NOW = kstAt(dayT('2026-11-16'), 10, 5); // 월 10:05 KST → 마지막 확정 KRX 일봉 = 11-13(금)
const TARGET = dayT('2026-11-13');
const CAND = Object.keys(CANDIDATE_ETFS);

function naverXml(bars) {
  return `<chartdata>${bars.map((b) => `<item data="${ymdCompact(b.t)}|${Math.round(b.o)}|${Math.round(Math.max(b.h, b.o, b.c))}|${Math.round(Math.min(b.l, b.o, b.c))}|${Math.round(b.c)}|${b.v}" />`).join('')}</chartdata>`;
}
/** 네이버 차트 흉내: failSyms 는 항상 500. 공식 KRX API 흉내: 요청한 날짜(basDd)의 모든 종목 행. */
function mockFetch({ failSyms = new Set() } = {}) {
  const naver = {};
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u.href);
    if (u.hostname === 'fchart.stock.naver.com') {
      const s = u.searchParams.get('symbol');
      if (failSyms.has(s)) return new Response('err', { status: 500 });
      if (!naver[s]) naver[s] = makeBars({ start: '2024-01-02', n: 900, seed: Number(s.slice(0, 3)) + 1, skipNonKrx: true, p0: 30000 }).filter((b) => b.t <= TARGET);
      return new Response(naverXml(naver[s].slice(-Number(u.searchParams.get('count')))), { headers: { 'content-type': 'text/xml' } });
    }
    if (u.searchParams.get('basDd')) {
      const d = u.searchParams.get('basDd');
      const rows = Object.keys({ ...KRX_ETFS, ...KRX_STOCKS, ...CANDIDATE_ETFS }).map((c, i) => ({ BAS_DD: d, ISU_CD: c, TDD_OPNPRC: String(10000 + i), TDD_HGPRC: String(10100 + i), TDD_LWPRC: String(9900 + i), TDD_CLSPRC: String(10050 + i), ACC_TRDVOL: '1000' }));
      return Response.json({ OutBlock_1: rows });
    }
    return new Response('nope', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('candidate ETFs: collected (last in order) but outside the readiness set; meta/tax/names set', () => {
  const all = krxCodes(), core = coreKrxCodes();
  assert.deepEqual(all.slice(0, core.length), core); // 기존 종목이 먼저(틱당 대체 수집 몫)
  assert.deepEqual(all.slice(core.length).sort(), [...CAND].sort());
  for (const c of CAND) { assert.ok(!core.includes(c)); assert.equal(krxMeta[c].etf, true); assert.ok(krxMeta[c].name); }
  for (const c of ['148070', '132030', '251350']) assert.ok(ETF_GAIN_TAXED.has(c));
  for (const c of ['174350', '161510', '279530']) assert.ok(!ETF_GAIN_TAXED.has(c)); // 국내주식형: 매매차익 비과세
});

test('candidate ETFs: no existing strategy trades them (existing books unchanged)', () => {
  for (const s of STRATEGIES) for (const c of CAND) assert.ok(!(s.universe || []).includes(c), `${s.id} uses ${c}`);
});

test('naver path: candidate symbols failing forever do NOT stop ready:krx:1d', async () => {
  const env = { DB: makeD1() };
  const f = mockFetch({ failSyms: new Set(CAND) });
  for (let i = 0; i < 12; i++) {
    const kv = await kvAll(env.DB);
    await krxDailyTask(env, kv, NOW + i * 60, { fetcher: f });
  }
  const kv = await kvAll(env.DB);
  assert.equal(kv['ready:krx:1d'], TARGET);
  for (const c of coreKrxCodes()) assert.equal(kv['krx:cur'][c], TARGET);
  for (const c of CAND) assert.ok(!(kv['krx:cur'][c] >= TARGET), c);
  const n = env.DB.raw.prepare(`SELECT COUNT(*) n FROM candles WHERE sym IN (${CAND.map(() => '?').join(',')})`).get(...CAND).n;
  assert.equal(n, 0);
});

test('naver path: working candidate symbols get bars after the core ones', async () => {
  const env = { DB: makeD1() };
  const f = mockFetch();
  for (let i = 0; i < 12; i++) await krxDailyTask(env, await kvAll(env.DB), NOW + i * 60, { fetcher: f });
  const kv = await kvAll(env.DB);
  assert.equal(kv['ready:krx:1d'], TARGET);
  for (const c of CAND) assert.equal(kv['krx:cur'][c], TARGET, c);
  const firstCand = f.calls.findIndex((u) => CAND.some((c) => u.includes(`symbol=${c}`)));
  const lastCore = f.calls.map((u, i) => (coreKrxCodes().some((c) => u.includes(`symbol=${c}`)) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(firstCand > lastCore, 'candidates are fetched only after every core symbol');
});

test('official path: a candidate cursor stuck on an old day does not pull the official date back for core symbols', async () => {
  const env = { DB: makeD1() };
  const prev = dayT('2026-11-12'), old = dayT('2026-11-02');
  const cur = Object.fromEntries([...coreKrxCodes().map((c) => [c, prev]), ...CAND.map((c) => [c, old])]);
  await env.DB.batch([kvSetStmt(env.DB, 'krx:cur', cur)]);
  const f = mockFetch();
  await krxDailyTask({ ...env, KRX_AUTH_KEY: 'test' }, await kvAll(env.DB), NOW, { fetcher: f });
  const kv = await kvAll(env.DB);
  const days = f.calls.filter((u) => u.includes('basDd=')).map((u) => new URL(u).searchParams.get('basDd'));
  assert.ok(days.length && days.every((d) => d === '20261113'), JSON.stringify(days));
  assert.equal(kv['ready:krx:1d'], TARGET);
  for (const c of CAND) assert.equal(kv['krx:cur'][c], TARGET); // 같은 공식 응답에 들어 있으면 같이 채워짐
});

test('backfill: candidate symbols without history are backfilled one per tick (core already done)', async () => {
  const env = { DB: makeD1() };
  await env.DB.batch(coreKrxCodes().map((c) => kvSetStmt(env.DB, `bf:krx:${c}`, 1)));
  const f = mockFetch();
  for (let i = 0; i < CAND.length; i++) await krxBackfillTask(env, await kvAll(env.DB), NOW + i * 600, { fetcher: f });
  const kv = await kvAll(env.DB);
  for (const c of CAND) { assert.equal(kv[`bf:krx:${c}`], 1, c); assert.ok(kv['cov:krx:1d'][c]?.min < TARGET - 300 * 86400, c); }
});

test('backfill: one candidate failing forever does not starve the others (6h backoff per symbol)', async () => {
  const env = { DB: makeD1() };
  await env.DB.batch(coreKrxCodes().map((c) => kvSetStmt(env.DB, `bf:krx:${c}`, 1)));
  const f = mockFetch({ failSyms: new Set([CAND[0]]) });
  for (let i = 0; i < CAND.length + 2; i++) await krxBackfillTask(env, await kvAll(env.DB), NOW + i * 600, { fetcher: f });
  const kv = await kvAll(env.DB);
  assert.ok(!kv[`bf:krx:${CAND[0]}`]);
  for (const c of CAND.slice(1)) assert.equal(kv[`bf:krx:${c}`], 1, c);
  assert.ok(kv[`fail:krxbf:${CAND[0]}`] > NOW);
});

test('health: candidate-only collection failures use a cand: source (shown, not a stall alarm)', async () => {
  const env = { DB: makeD1() };
  const f = mockFetch({ failSyms: new Set(CAND) });
  await env.DB.batch(coreKrxCodes().map((c) => kvSetStmt(env.DB, `bf:krx:${c}`, 1)));
  for (let i = 0; i < 6; i++) { await krxDailyTask(env, await kvAll(env.DB), NOW + i * 60, { fetcher: f }); await krxBackfillTask(env, await kvAll(env.DB), NOW + i * 60, { fetcher: f }); }
  const rows = env.DB.raw.prepare('SELECT source, last_ok, last_err FROM data_health').all();
  const failing = rows.filter((r) => r.last_err && r.last_err > (r.last_ok || 0)).map((r) => r.source);
  assert.ok(failing.length && failing.every((s) => s.startsWith('cand:')), JSON.stringify(rows));
  assert.ok(!failing.some((s) => /^(upbit:1[dh]|krx:|naver)/.test(s)));
});
