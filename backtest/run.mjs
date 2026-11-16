#!/usr/bin/env node
// Heavy backtest + weekly research job (plain Node >= 20, no dependencies, no LLM needed).
// Same engine code as the Worker (src/core). Runs locally, on a Windows scheduled task, or in
// GitHub Actions. Usage:
//   node backtest/run.mjs                     # fetch/cached data -> backtest all strategies -> results/
//   node backtest/run.mjs --research          # + random variant search per family (G1 with trial penalty)
//   node backtest/run.mjs --seed-sql out.sql  # + D1 seed (recent candles, readiness cursors, backtests)
//   node backtest/run.mjs --push https://<worker>/api/import   (env IMPORT_TOKEN)  # upload results
//   node backtest/run.mjs --research --export backtest/results/import.json  # file the Worker pulls (RESEARCH_URL)
//   node backtest/run.mjs --fixtures          # offline: synthetic fixture data (CI smoke test)
//   options: --no-fetch (cache only), --only id1,id2, --quick
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES, byId, trialsFor } from '../src/strategies/index.js';
import { runBacktest, walkForward, gridVariants } from '../src/core/backtest.js';
import { evaluateStage, GATE_DEFAULTS } from '../src/core/lifecycle.js';
import { deflatedSharpe, periodReturns } from '../src/core/stats.js';
import { mergeCosts, stressCosts } from '../src/core/costs.js';
import { computeMetrics } from '../src/core/metrics.js';
import { fetchUpbitCandles, finalOnly } from '../src/data/upbit.js';
import { fetchNaverDaily } from '../src/data/krx.js';
import { DAY, HOUR, ymd, latestFinalKrxDay, latestFinalCryptoDay, latestFinalHour } from '../src/core/calendar.js';
import { KRX_ALL, krxMeta, CRYPTO_CORE, CRYPTO_HOURLY, RETENTION } from '../src/config.js';
import { downsample } from '../src/db/store.js';
import { SEARCH_SPACES, VARIANTS_PER_FAMILY_PER_RUN } from './search-spaces.mjs';
import { llmIdeas } from './llm-ideas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const OUT = join(HERE, 'results');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const NOW = Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
mkdirSync(CACHE, { recursive: true }); mkdirSync(OUT, { recursive: true });

// ---------------- data ----------------
const cacheFile = (k) => join(CACHE, `${k.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
function readCache(k, maxAgeSec) {
  const f = cacheFile(k);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  return !maxAgeSec || NOW - j.at < maxAgeSec || flag('--no-fetch') ? j.bars : null;
}
const writeCache = (k, bars) => writeFileSync(cacheFile(k), JSON.stringify({ at: NOW, bars }));

async function upbitHistory(market, tf, maxPages) {
  const k = `upbit_${tf}_${market}`;
  const c = readCache(k, 20 * HOUR);
  if (c) return c;
  if (flag('--no-fetch')) return [];
  let all = [], to;
  for (let p = 0; p < maxPages; p++) {
    let bars;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { bars = await fetchUpbitCandles(fetch, market, tf, { count: 200, toSec: to }); break; } catch (e) { if (attempt === 2) throw e; await sleep(1500); }
    }
    if (!bars.length) break;
    all = [...bars, ...all];
    to = bars[0].t + (tf === '1d' ? 9 * HOUR : 0);
    if (bars.length < 200) break;
    await sleep(130);
  }
  const uniq = [...new Map(all.map((b) => [b.t, b])).values()].sort((a, b) => a.t - b.t);
  const fin = finalOnly(uniq, tf, NOW);
  writeCache(k, fin);
  return fin;
}
async function naverHistory(code) {
  const k = `naver_${code}`;
  const c = readCache(k, 20 * HOUR);
  if (c) return c;
  if (flag('--no-fetch')) return [];
  const bars = (await fetchNaverDaily(fetch, code, 6000)).filter((b) => b.t <= latestFinalKrxDay(NOW));
  writeCache(k, bars);
  await sleep(150);
  return bars;
}
/** Extend a short-lived ETF backwards with a proxy (price-scaled at the first overlapping day). */
export function spliceProxy(target, proxy) {
  if (!target.length || !proxy.length) return target;
  const first = target[0];
  const p = proxy.find((b) => b.t === first.t);
  if (!p) return target;
  const k = first.c / p.c;
  const pre = proxy.filter((b) => b.t < first.t).map((b) => ({ t: b.t, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k, v: b.v, proxy: true }));
  return [...pre, ...target];
}

async function loadData() {
  if (flag('--fixtures')) return fixtureData();
  log('· 데이터 받는 중 (캐시 20시간)…');
  const krx = {};
  for (const code of Object.keys(KRX_ALL)) {
    try { krx[code] = await naverHistory(code); } catch (e) { log(`  ! ${code} ${e.message}`); krx[code] = []; }
  }
  const krxRaw = { ...krx };
  // 278530 (2017~) extended with 069500 (2002~) for long verification (research 5-2: 지수로 대체 검증)
  krx['278530'] = spliceProxy(krx['278530'], krx['069500']);
  const crypto1d = {}, crypto1h = {};
  for (const m of CRYPTO_CORE) { try { crypto1d[m] = await upbitHistory(m, '1d', flag('--quick') ? 3 : 20); } catch (e) { log(`  ! ${m} ${e.message}`); crypto1d[m] = []; } }
  for (const m of CRYPTO_HOURLY) { try { crypto1h[m] = await upbitHistory(m, '1h', flag('--quick') ? 4 : Number(opt('--hourly-pages') || 60)); } catch (e) { log(`  ! ${m} 1h ${e.message}`); crypto1h[m] = []; } }
  return { krx, krxRaw, crypto1d, crypto1h, source: 'live' };
}

function fixtureData() {
  const f = JSON.parse(readFileSync(join(HERE, '..', 'test', 'fixtures', 'market-fixture.json'), 'utf8'));
  return { ...f, krxRaw: f.krx, source: 'fixtures' };
}

// ---------------- evaluation ----------------
function seriesFor(s, data) {
  if (s.market === 'krx') return data.krx;
  return s.timeframe === '1h' ? data.crypto1h : data.crypto1d;
}
function timeline(s, series) {
  const b = series[s.benchSym] || series[s.universe[0]] || [];
  return b.map((x) => x.t);
}

/** Holdout start is FIXED once (frozen in holdout.json) so later runs cannot move it. */
function holdoutFrom(key, tl, warm) {
  // synthetic fixture data has its own dates: never mix it with the real frozen cut-offs
  if (flag('--fixtures')) return tl[warm + Math.floor((tl.length - warm) * 0.75)];
  const f = join(HERE, 'holdout.json');
  const j = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  if (!j[key] && tl.length > warm + 50) {
    j[key] = tl[warm + Math.floor((tl.length - warm) * 0.75)];
    if (!flag('--fixtures')) writeFileSync(f, JSON.stringify(j, null, 2));
  }
  return j[key] || tl[Math.floor(tl.length * 0.75)];
}

function srStd(results) {
  const sr = results.map((r) => { const x = periodReturns(r.points); const m = x.reduce((a, b) => a + b, 0) / (x.length || 1); const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length - 1)); return sd > 0 ? m / sd : 0; });
  if (sr.length < 2) return 0;
  const m = sr.reduce((a, b) => a + b, 0) / sr.length;
  return Math.sqrt(sr.reduce((a, b) => a + (b - m) ** 2, 0) / (sr.length - 1));
}

export function evaluateStrategy(s, data, { params: forced, extraTrials = 0 } = {}) {
  const series = seriesFor(s, data);
  const tl = timeline(s, series);
  const warm = Math.min(s.lookback || 100, Math.floor(tl.length / 4));
  if (tl.length < warm + 120) return null;
  const meta = s.market === 'krx' ? krxMeta : {};
  const hoKey = `${s.market}:${s.timeframe}:${s.benchSym}`;
  const hoFrom = holdoutFrom(hoKey, tl, warm);
  // development data = strictly before the frozen hold-out start (never fall back to a %-split:
  // if the cutoff bar is missing that would leak hold-out bars into training)
  const devTl = tl.filter((t) => t < hoFrom);
  if (devTl.length < warm + 120) return null;
  const devTo = devTl[devTl.length - 1];
  const ppy = s.market === 'krx' ? 252 : s.timeframe === '1h' ? 24 * 365 : 365;
  // 1) development period: walk-forward OOS (params chosen in-sample each fold)
  const devSeries = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.filter((b) => b.t <= devTo)]));
  const devLen = tl.filter((t) => t <= devTo).length - warm;
  const trainBars = Math.max(120, Math.min(ppy * 3, Math.floor(devLen * 0.5)));
  const testBars = Math.max(60, Math.min(ppy, Math.floor(devLen * 0.2)));
  const grid = forced ? null : s.grid;
  const base = { strategy: s, series: devSeries, meta };
  const wf = walkForward({ ...base, grid, trainBars, testBars });
  // 2) final params: chosen on the whole development period only (never on the hold-out)
  let params = forced || {};
  let gridResults = [];
  if (!forced && grid) {
    gridResults = gridVariants(grid).map((v) => ({ v, r: runBacktest({ ...base, params: v, fromT: tl[warm] }) }));
    gridResults.sort((a, b) => b.r.metrics.sharpe - a.r.metrics.sharpe);
    params = gridResults[0].v;
  }
  // 3) untouched hold-out, once, at 1x and 2x costs
  const full = { strategy: s, series, meta, params };
  const ho = runBacktest({ ...full, fromT: hoFrom });
  const ho2 = runBacktest({ ...full, fromT: hoFrom, costs: stressCosts(mergeCosts(s.market)) });
  const all = runBacktest({ ...full, fromT: tl[warm] });
  const trials = trialsFor(s) + extraTrials;
  const dsr = deflatedSharpe(periodReturns(ho.points), trials, srStd(gridResults.map((g) => g.r)));
  const years = (tl[tl.length - 1] - tl[warm]) / DAY / 365.25;
  const proxyNote = s.market === 'krx' && (series['278530']?.[0]?.proxy) ? '278530 상장(2017) 이전은 KODEX 200(069500)으로 대체' : null;
  return {
    params: { ...s.params, ...params }, wf: wf.oos, folds: wf.folds.length, holdout: ho.metrics, holdout2x: ho2.metrics, full: all.metrics,
    totalTrades: all.metrics.trades, years: Math.round(years * 10) / 10, dsr: Math.round(dsr * 1000) / 1000, trials,
    range: `${ymd(tl[warm])} ~ ${ymd(tl[tl.length - 1])}`, holdoutFrom: ymd(hoFrom), source: data.source === 'fixtures' ? 'fixtures' : 'local', proxyNote,
    generatedAt: NOW, curve: downsample(all.points.map((p) => ({ t: p.t, e: Math.round(p.equity), b: Math.round(p.bench) })), 200),
  };
}

function pickRandom(space, rnd) { return Object.fromEntries(Object.entries(space).map(([k, v]) => [k, v[Math.floor(rnd() * v.length)]])); }
function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// trial ledger (persisted locally; pushed to the Worker too)
const TRIALS = join(HERE, 'trials.json');
const readTrials = () => (existsSync(TRIALS) ? JSON.parse(readFileSync(TRIALS, 'utf8')) : {});
/** Distinct research trials already spent on a family (B03: the base strategy's DSR must include them). */
export function ledgerTrials(family) { const v = readTrials()[family]; return typeof v === 'number' ? v : (v?.count || 0); }
// variants this repo already exported (pull mode has no /api/research-state to ask)
const VARIANTS = join(HERE, 'variants.json');
const readVariants = () => (existsSync(VARIANTS) ? JSON.parse(readFileSync(VARIANTS, 'utf8')) : []);

async function research(data, results, remote) {
  // trial ledger: distinct parameter sets tried per family (re-trying the same set is not a new trial)
  const ledger = readTrials();
  const trialsDb = {};
  for (const [f, v] of Object.entries(ledger)) trialsDb[f] = typeof v === 'number' ? { count: v, seen: [] } : v;
  for (const [f, n] of Object.entries(remote?.trials || {})) trialsDb[f] = { count: Math.max(trialsDb[f]?.count || 0, n | 0), seen: trialsDb[f]?.seen || [] };
  const existing = new Set([...STRATEGIES.map((s) => s.id), ...(remote?.variants || []).map((v) => v.id)]);
  const found = [];
  const rnd = seeded(Math.floor(NOW / (7 * DAY)));
  for (const [family, cfg] of Object.entries(SEARCH_SPACES)) {
    const base = byId[cfg.base];
    const led = trialsDb[family] || { count: 0, seen: [] };
    const seen = new Set(led.seen);
    const tried = [];
    const devScore = (params) => {
      const s = { ...base, params: { ...base.params, ...params }, grid: null };
      const series = seriesFor(s, data);
      const tl = timeline(s, series);
      const warm = Math.min(s.lookback || 100, Math.floor(tl.length / 4));
      if (tl.length < warm + 200) return null;
      const hoFrom = holdoutFrom(`${s.market}:${s.timeframe}:${s.benchSym}`, tl, warm);
      if (tl.filter((t) => t < hoFrom).length < warm + 120) return null;
      return runBacktest({ strategy: s, series, meta: s.market === 'krx' ? krxMeta : {}, fromT: tl[warm], toT: hoFrom - 1 }).metrics.sharpe;
    };
    const baseDev = devScore({});
    const proposals = [...Array.from({ length: VARIANTS_PER_FAMILY_PER_RUN }, () => pickRandom(cfg.space, rnd)), ...(await llmIdeas(family, cfg, base.params))];
    for (const p of proposals) {
      const s = { ...base, params: { ...base.params, ...p }, grid: null };
      // development-period score only (hold-out untouched during selection)
      const series = seriesFor(s, data);
      const tl = timeline(s, series);
      const warm = Math.min(s.lookback || 100, Math.floor(tl.length / 4));
      if (tl.length < warm + 200) continue;
      const hoFrom = holdoutFrom(`${s.market}:${s.timeframe}:${s.benchSym}`, tl, warm);
      const dev = runBacktest({ strategy: s, series, meta: s.market === 'krx' ? krxMeta : {}, fromT: tl[warm], toT: hoFrom - 1 });
      tried.push({ p, sharpe: dev.metrics.sharpe });
      const key = JSON.stringify(p);
      if (!seen.has(key)) { seen.add(key); led.count++; }
    }
    const total = led.count;
    trialsDb[family] = { count: total, seen: [...seen] };
    tried.sort((a, b) => b.sharpe - a.sharpe);
    const best = tried[0];
    if (!best) continue;
    const s = { ...base, params: { ...base.params, ...best.p }, grid: null };
    const ev = evaluateStrategy(s, data, { params: best.p, extraTrials: total });
    const g1 = evaluateStage({ strategy: { ...s, researchOnly: false }, bt: ev, paper: null, kill: null, gates: GATE_DEFAULTS });
    // B02: "better than the base" is decided on the DEVELOPMENT period only, so repeated weekly runs do not
    // select on the hold-out. (The hold-out is still used once per candidate for the G1 pass/fail gate.)
    const better = baseDev == null || best.sharpe > baseDev;
    let version = base.version + 1;
    while (existing.has(`${family}_v${version}`)) version++;
    const id = `${family}_v${version}`;
    log(`  · ${family}: ${tried.length}개 변형 시도(누적 ${total}) → 최고 개발구간 샤프 ${best.sharpe.toFixed(2)}, 보존구간 ${(ev.holdout.totalReturn * 100).toFixed(1)}%, DSR ${ev.dsr} → ${g1.stage === 'paper' && better ? `등록 후보 ${id}` : '탈락'}`);
    if (g1.stage === 'paper' && better) { found.push({ id, base: base.id, version, params: best.p, trials: total, note: `weekly research ${ymd(NOW)}`, summary: ev }); existing.add(id); }
  }
  if (!flag('--fixtures')) writeFileSync(TRIALS, JSON.stringify(trialsDb, null, 2));
  return { variants: found, trials: Object.fromEntries(Object.entries(trialsDb).map(([f, v]) => [f, v.count])) };
}

// ---------------- seed SQL for D1 ----------------
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
function seedSql(data, results, research) {
  const lines = ['-- generated by backtest/run.mjs; safe to re-run (upserts)'];
  const push = (market, tf, sym, bars, src) => {
    for (let i = 0; i < bars.length; i += 200) {
      const chunk = bars.slice(i, i + 200).map((b) => `(${q(market)},${q(tf)},${q(sym)},${b.t},${+b.o.toFixed(4)},${+b.h.toFixed(4)},${+b.l.toFixed(4)},${+b.c.toFixed(4)},${+(+b.v).toFixed(4)},${q(src)})`);
      lines.push(`INSERT OR REPLACE INTO candles (market,tf,sym,t,o,h,l,c,v,src) VALUES ${chunk.join(',')};`);
    }
  };
  const cov = { krx: {}, c1d: {}, c1h: {} };
  const krxFloor = NOW - 4 * 365 * DAY, c1dFloor = NOW - 1100 * DAY, c1hFloor = NOW - RETENTION.hourlyDays * DAY;
  const krxFinal = latestFinalKrxDay(NOW);
  const cur = {};
  for (const [s, bars0] of Object.entries(data.krxRaw)) {
    const bars = bars0.filter((b) => b.t >= krxFloor && b.t <= krxFinal);
    if (!bars.length) continue;
    push('krx', '1d', s, bars, 'naver'); cov.krx[s] = { min: bars[0].t, max: bars[bars.length - 1].t }; cur[s] = bars[bars.length - 1].t;
  }
  for (const [s, bars0] of Object.entries(data.crypto1d)) { const bars = bars0.filter((b) => b.t >= c1dFloor); if (bars.length) { push('crypto', '1d', s, bars, 'upbit'); cov.c1d[s] = { min: bars[0].t, max: bars[bars.length - 1].t }; } }
  for (const [s, bars0] of Object.entries(data.crypto1h)) { const bars = bars0.filter((b) => b.t >= c1hFloor); if (bars.length) { push('crypto', '1h', s, bars, 'upbit'); cov.c1h[s] = { min: bars[0].t, max: bars[bars.length - 1].t }; } }
  const kv = (k, v) => lines.push(`INSERT INTO kv (k, v, updated_at) VALUES (${q(k)}, ${q(JSON.stringify(v))}, ${NOW}) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at;`);
  kv('cov:krx:1d', cov.krx); kv('cov:crypto:1d', cov.c1d); kv('cov:crypto:1h', cov.c1h); kv('krx:cur', cur);
  for (const s of Object.keys(cov.krx)) kv(`bf:krx:${s}`, 1);
  for (const s of Object.keys(cov.c1d)) kv(`bf:crypto:1d:${s}`, 1);
  for (const s of Object.keys(cov.c1h)) kv(`bf:crypto:1h:${s}`, 1);
  if (research?.variants?.length) {
    kv('variants', research.variants.map(({ summary, ...v }) => ({ ...v, registeredAt: NOW })));
    kv('research:trials', research.trials);
    for (const v of research.variants) results = { ...results, [v.id]: v.summary };
  }
  for (const [id, r] of Object.entries(results)) {
    const { curve, ...summary } = r;
    lines.push(`INSERT INTO backtests (strategy_id, kind, source, created_at, summary, curve) VALUES (${q(id)}, 'wf', ${q(r.source)}, ${NOW}, ${q(JSON.stringify(summary))}, ${q(JSON.stringify(curve))}) ON CONFLICT(strategy_id, kind) DO UPDATE SET source=excluded.source, created_at=excluded.created_at, summary=excluded.summary, curve=excluded.curve;`);
  }
  return lines.join('\n') + '\n';
}

// ---------------- report ----------------
const pc = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
function reportKo(results, research) {
  const L = [`# 백테스트 결과 (${ymd(NOW)} 생성, 데이터: ${flag('--fixtures') ? '테스트용 가짜 데이터' : '업비트·네이버 공개 시세'})`, '',
    '판정은 "끝까지 안 본 마지막 25% 구간(보존 구간)" 기준입니다. 비용(수수료·세금·미끄러짐)을 뺀 값입니다.', '',
    '| 전략 | 기간 | 보존구간 수익 | 기준선 | 비용2배 | 최대낙폭(기준선) | 샤프 | 전체 거래 | DSR(시도) | 1단계 판정 |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of STRATEGIES) {
    const r = results[s.id];
    if (!r) continue;
    const g = evaluateStage({ strategy: s, bt: r, paper: null });
    const verdict = s.benchmarkOnly ? '기준선' : g.stage === 'bt_failed' ? '미통과' : '통과 → 모의 검증' + (s.researchOnly ? '(연구용)' : '');
    L.push(`| ${s.name} | ${r.years}년 | ${pc(r.holdout.totalReturn)} | ${pc(r.holdout.bench.totalReturn)} | ${pc(r.holdout2x.totalReturn)} | ${(r.holdout.mdd * 100).toFixed(1)}% (${(r.holdout.bench.mdd * 100).toFixed(1)}%) | ${r.holdout.sharpe.toFixed(2)} | ${r.totalTrades} | ${Math.round(r.dsr * 100)}% (${r.trials}) | ${verdict} |`);
  }
  if (research) { L.push('', '## 자동 연구(변형 탐색)', ''); for (const v of research.variants) L.push(`- 새 후보 ${v.id}: ${JSON.stringify(v.params)} (누적 시도 ${v.trials})`); if (!research.variants.length) L.push('- 이번 주 통과한 새 변형 없음 (정상: 대부분 탈락해야 함)'); }
  L.push('', '※ 과거 성과는 미래를 보장하지 않습니다. 대형주·코인 목록은 "지금" 기준이라 생존 편향이 있습니다.');
  return L.join('\n');
}

async function main() {
  const data = await loadData();
  const only = opt('--only')?.split(',');
  const results = {};
  for (const s of STRATEGIES) {
    if (s.external || (only && !only.includes(s.id))) continue;
    const t0 = Date.now();
    try {
      const r = evaluateStrategy(s, data, { extraTrials: ledgerTrials(s.family) });
      if (!r) { log(`  - ${s.id}: 데이터 부족`); continue; }
      results[s.id] = r;
      log(`  · ${s.id.padEnd(22)} ${r.range}  보존구간 ${pc(r.holdout.totalReturn)} (기준 ${pc(r.holdout.bench.totalReturn)})  MDD ${(r.holdout.mdd * 100).toFixed(1)}%  샤프 ${r.holdout.sharpe.toFixed(2)}  거래 ${r.totalTrades}  DSR ${r.dsr}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    } catch (e) { log(`  ! ${s.id}: ${e.stack}`); }
  }
  let remote = null;
  const pushUrl = opt('--push');
  if (pushUrl && process.env.IMPORT_TOKEN) {
    try { const r = await fetch(pushUrl.replace(/\/api\/import$/, '/api/research-state'), { headers: { authorization: `Bearer ${process.env.IMPORT_TOKEN}` } }); if (r.ok) remote = await r.json(); } catch {}
  }
  if (!remote) remote = { variants: readVariants(), trials: {} };
  const res = flag('--research') ? await research(data, results, remote) : null;
  const tag = flag('--fixtures') ? 'fixtures' : 'latest';
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify({ generatedAt: NOW, results, research: res }, null, 1));
  writeFileSync(join(OUT, `${tag}-report-ko.md`), reportKo(results, res));
  log(`\n결과: backtest/results/${tag}.json, ${tag}-report-ko.md`);
  const seedOut = opt('--seed-sql');
  if (seedOut) { writeFileSync(seedOut, seedSql(data, results, res)); log(`D1 시드 SQL: ${seedOut}`); }
  const body = importBody(results, res);
  const exportOut = opt('--export');
  if (exportOut) { writeFileSync(exportOut, JSON.stringify(body)); log(`가져오기 파일(워커가 RESEARCH_URL 로 읽음): ${exportOut}`); }
  if (res?.variants?.length && !flag('--fixtures')) writeFileSync(VARIANTS, JSON.stringify([...readVariants(), ...res.variants.map(({ summary, ...v }) => v)], null, 1));
  if (pushUrl) {
    if (!process.env.IMPORT_TOKEN) { log('IMPORT_TOKEN 이 없어 업로드를 건너뜀'); return; }
    const r = await fetch(pushUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.IMPORT_TOKEN}` }, body: JSON.stringify(body) });
    log(`업로드: HTTP ${r.status} ${await r.text()}`);
    if (!r.ok) process.exitCode = 2;
  }
}

/** Body for /api/import and for the pulled import.json (same validation on the Worker side). */
export function importBody(results, res) {
  const body = {
    format: 'fip-research-1', generatedAt: NOW,
    backtests: Object.entries(results).map(([id, r]) => { const { curve, ...summary } = r; return { strategy_id: id, kind: 'wf', source: r.source, summary, curve }; }),
    variants: (res?.variants || []).map(({ summary, ...v }) => v),
    trials: res?.trials || null,
  };
  for (const v of res?.variants || []) { const { curve, ...summary } = v.summary; body.backtests.push({ strategy_id: v.id, kind: 'wf', source: 'research', summary, curve }); }
  return body;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
