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
import { STRATEGIES, byId, trialsFor, variantStrategies } from '../src/strategies/index.js';
import { runBacktest, walkForward, gridVariants } from '../src/core/backtest.js';
import { evaluateStage, GATE_DEFAULTS } from '../src/core/lifecycle.js';
import { deflatedSharpe, periodReturns, expectedMaxSharpe } from '../src/core/stats.js';
import { mergeCosts, stressCosts } from '../src/core/costs.js';
import { computeMetrics, riskMatched } from '../src/core/metrics.js';
import { fetchUpbitCandles, finalOnly } from '../src/data/upbit.js';
import { fetchNaverDaily } from '../src/data/krx.js';
import { DAY, HOUR, ymd, latestFinalKrxDay, latestFinalCryptoDay, latestFinalHour } from '../src/core/calendar.js';
import { KRX_ALL, krxMeta, CRYPTO_CORE, CRYPTO_HOURLY, RETENTION } from '../src/config.js';
import { downsample } from '../src/db/store.js';
import { SEARCH_SPACES, VARIANTS_PER_FAMILY_PER_RUN } from './search-spaces.mjs';
import { llmIdeas } from './llm-ideas.mjs';
import { ALL_CANDIDATES as CANDIDATES, releaseAt } from '../src/strategies/candidates.js'; // 대기열 전체(앞 8개 + 규칙 문법 순서표 20개, #F-009 ③)

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
  // synthetic fixture data has its own dates: never mix it with the real frozen cut-offs (MOSS_SYNTHETIC=1: tests)
  if (flag('--fixtures') || process.env.MOSS_SYNTHETIC === '1') return tl[warm + Math.floor((tl.length - warm) * 0.75)];
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

/**
 * 연구실 전체 시도 수(여러 전략 중 우연히 좋은 것을 고르는 효과 보정용): 모든 비기준선 가족의
 * (등록 버전·그리드 + 이전 탈락 시도) + 주간 연구 장부의 변형 시도. 비교 장부(AI·거부권)도 각각 1번의 시도로 센다.
 */
export function labTrialsCount(registry = STRATEGIES) {
  const fam = new Map();
  for (const s of registry) {
    if (s.benchmarkOnly || s.external) continue;
    fam.set(s.family, Math.max(fam.get(s.family) || 0, trialsFor(s, registry) + ledgerTrials(s.family)));
  }
  return [...fam.values()].reduce((a, b) => a + b, 0);
}
let LAB_TRIALS = 0;

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
  const hoRet = periodReturns(ho.points);
  const dsr = deflatedSharpe(hoRet, trials, srStd(gridResults.map((g) => g.r)));
  // 위험 맞춤 기준선: 평균 투자 비율만큼 지수 + 나머지 단기채권(코인은 현금), 매월 조정 (lifecycle G1 검사)
  const bond = s.market === 'krx' ? (data.krx['153130'] || null) : null;
  const opt = { market: s.market, tf: s.timeframe };
  // index part = the strategy's own risky universe, equal weight (e.g. KODEX 200TR + 미국S&P500TR), else its benchmark
  const riskySyms = (s.universe || []).filter((x) => x !== '153130' && series[x]?.length);
  const idx = riskySyms.length ? riskySyms.map((x) => series[x]) : (s.benchSym && series[s.benchSym] ? [series[s.benchSym]] : []);
  if (idx.length) {
    ho.metrics.riskMatched = riskMatched(ho.points, idx, bond, opt);
    all.metrics.riskMatched = riskMatched(all.points, idx, bond, opt);
  }
  const labTrials = Math.max(trials, LAB_TRIALS);
  const dsrLab = deflatedSharpe(hoRet, labTrials);
  const ppy0 = s.market === 'krx' ? 252 : s.timeframe === '1h' ? 24 * 365 : 365;
  const luckSharpe = expectedMaxSharpe(labTrials, hoRet.length, ppy0);
  const years = (tl[tl.length - 1] - tl[warm]) / DAY / 365.25;
  const proxyNote = s.market === 'krx' && (series['278530']?.[0]?.proxy) ? '278530 상장(2017) 이전은 KODEX 200(069500)으로 대체' : null;
  return {
    params: { ...s.params, ...params }, wf: wf.oos, folds: wf.folds.length, holdout: ho.metrics, holdout2x: ho2.metrics, full: all.metrics,
    totalTrades: all.metrics.trades, years: Math.round(years * 10) / 10, dsr: Math.round(dsr * 1000) / 1000, trials,
    labTrials, dsrLab: Math.round(dsrLab * 1000) / 1000, luckSharpe: Math.round(luckSharpe * 100) / 100,
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

// ---------------- 사전 등록 후보 대기열 (src/strategies/candidates.js, backtest/CANDIDATES-PREREG.md) ----------------
// candidates.json = { <id>: { status: 'released'|'rejected', at, trials, note } }. 한 번 판정한 후보는 다시 판정하지 않는다
// (매주 보존 구간을 다시 보며 고르지 않게). 자료 기간이 모자라면 판정하지 않고 다음 주에 다시 본다(기록 안 함).
const CANDS = join(HERE, 'candidates.json');
const readCands = () => (existsSync(CANDS) ? JSON.parse(readFileSync(CANDS, 'utf8')) : {});
/** 자료 기간(년): evaluateStrategy 와 같은 방식으로 날짜만 보고 계산한다(수익·결과는 보지 않음). */
export function dataYears(s, data) {
  const tl = timeline(s, seriesFor(s, data));
  const warm = Math.min(s.lookback || 100, Math.floor(tl.length / 4));
  return tl.length > warm + 1 ? (tl[tl.length - 1] - tl[warm]) / DAY / 365.25 : 0;
}
/** 판정까지 간 후보(연구실 시도 수에 들어감): released + rejected. */
export const triedCandidates = (ledger) => CANDIDATES.filter((s) => ['released', 'rejected'].includes(ledger?.[s.id]?.status));
/** 원장에는 있는데 코드 목록에서 빠진 판정(지워도 시도 수는 줄지 않게 따로 1씩 더함). */
export const orphanTrials = (ledger) => Object.entries(ledger || {}).filter(([id, v]) => ['released', 'rejected'].includes(v?.status) && !CANDIDATES.some((s) => s.id === id)).length;
/** 판정 자료 완결성: universe 의 모든 종목이 기준 종목과 같은 마지막 날까지 있어야 판정한다(수집이 빈 주에 영구 판정되지 않게). */
export function dataComplete(s, data) {
  const series = seriesFor(s, data);
  const last = series[s.benchSym]?.at?.(-1)?.t;
  if (!last) return false;
  return (s.universe || []).every((x) => series[x]?.length && series[x][series[x].length - 1].t === last);
}
/**
 * 이번 실행에서 판정할 후보 고르기(순수). 공개 시각(KST 자정)이 지났고, 아직 판정 안 했고, 자료 기간이 관문 이상인 것.
 * 자료 기간이 모자라면 status 'no_data'(기록 안 함 → 다음 주 다시), 날짜 전이면 'waiting'.
 */
export function dueCandidates(now, ledger, yearsOf, minYears = GATE_DEFAULTS.backtest.slowMinYears, completeOf = () => true) {
  const due = [], status = {};
  for (const s of CANDIDATES) {
    const l = ledger?.[s.id];
    if (l?.status === 'released' || l?.status === 'rejected') { status[s.id] = { status: l.status, at: l.at, note: l.note || '' }; continue; }
    if (now < releaseAt(s)) { status[s.id] = { status: 'waiting', at: 0, note: `공개 ${s.releaseDate}` }; continue; }
    const y = yearsOf(s);
    if (y < minYears) { status[s.id] = { status: 'no_data', at: now, note: `자료 기간 ${y.toFixed(1)}년 < ${minYears}년 — 자료가 쌓이면 다시 봄` }; continue; }
    if (!completeOf(s)) { status[s.id] = { status: 'no_data', at: now, note: '이번 주 일부 종목 시세가 마지막 날까지 없음(수집 실패) — 다음 주 다시' }; continue; }
    due.push(s);
  }
  return { due, status };
}
/**
 * 판정(순수, 평가 함수 주입): 통과(G1 → 모의 검증) = released, 미통과 = rejected, 평가 불가(null) = no_data(기록 안 함).
 * 후보 가족은 STRATEGIES 밖이라 trialsFor 기본값이 0 → 자기 자신 1회 + 원장 시도를 꼭 더한다.
 */
export function judgeCandidates(due, ledger, now, evaluate) {
  const next = { ...(ledger || {}) }, status = {}, results = {};
  for (const s of due) {
    const r = evaluate(s, { extraTrials: trialsFor(s, [s]) + ledgerTrials(s.family) });
    if (!r) { status[s.id] = { status: 'no_data', at: now, note: '과거 검증에 쓸 개발 구간 자료 부족 — 다음 주 다시' }; continue; }
    const g1 = evaluateStage({ strategy: s, bt: r, paper: null, kill: null, gates: GATE_DEFAULTS });
    const ok = g1.stage === 'paper';
    const failed = (g1.checks || []).filter((c) => !c.ok).map((c) => c.text).slice(0, 3).join(' / ');
    next[s.id] = { status: ok ? 'released' : 'rejected', at: now, trials: r.trials, note: (ok ? `공개 ${ymd(now)}: 과거 검증 통과` : `공개 ${ymd(now)}: 미통과 — ${failed}`).slice(0, 200) };
    status[s.id] = { status: next[s.id].status, at: now, note: next[s.id].note };
    if (ok) results[s.id] = r;
  }
  return { ledger: next, status, results };
}

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
    if (!ev || baseDev == null) continue; // no dev evidence: skip, including before ev.holdout logging
    const g1 = evaluateStage({ strategy: { ...s, researchOnly: false }, bt: ev, paper: null, kill: null, gates: GATE_DEFAULTS });
    // B02: "better than the base" is decided on the DEVELOPMENT period only, so repeated weekly runs do not
    // select on the hold-out. (The hold-out is still used once per candidate for the G1 pass/fail gate.)
    const better = best.sharpe > baseDev;
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
function reportKo(results, research, cand = null) {
  const any = Object.values(results)[0];
  const L = [`# 백테스트 결과 (${ymd(NOW)} 생성, 데이터: ${flag('--fixtures') ? '테스트용 가짜 데이터' : '업비트·네이버 공개 시세'})`, '',
    '판정은 "끝까지 안 본 마지막 25% 구간(보존 구간)" 기준입니다. 비용(수수료·미끄러짐·해외주식형/채권형 ETF 매매차익 15.4% 세금)을 뺀 값입니다.',
    '**주의: 보존 구간도 설계하는 사람이 이미 지나간 시기라 "완전히 처음 보는 자료"가 아닙니다. 진짜 처음 보는 자료는 2026-11-16 이후 모의 기록뿐입니다.**', '',
    `여러 전략 중 우연히 좋은 것을 고르는 효과: 연구실 전체 시도 ${any?.labTrials ?? '-'}개 → 실력이 전혀 없어도 그중 최고 샤프는 운만으로 약 **${any?.luckSharpe ?? '-'}** (보존 구간 길이 기준) 나올 수 있습니다.`, '',
    '| 전략 | 기간 | 보존구간 수익 | 그냥 보유 | 위험 맞춤 기준(지수 비중) | 비용2배 | 최대낙폭(보유 / 위험맞춤) | 샤프(위험맞춤) | 전체 거래 | DSR 가족(시도) | DSR 연구실 전체 | 1단계 판정 |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const all = [...STRATEGIES, ...variantStrategies(readVariants()), ...CANDIDATES.filter((s) => results[s.id])];
  for (const s of all) {
    const r = results[s.id];
    if (!r) continue;
    const g = evaluateStage({ strategy: s, bt: r, paper: null });
    const verdict = s.benchmarkOnly ? '기준선' : g.stage === 'bt_failed' ? '미통과' : '통과 → 모의 검증' + (s.researchOnly ? '(연구용)' : '');
    const rm = r.holdout.riskMatched;
    L.push(`| ${s.name} | ${r.years}년 | ${pc(r.holdout.totalReturn)} | ${pc(r.holdout.bench.totalReturn)} | ${rm ? `${pc(rm.totalReturn)} (${Math.round(rm.weight * 100)}%)` : '-'} | ${pc(r.holdout2x.totalReturn)} | ${(r.holdout.mdd * 100).toFixed(1)}% (${(r.holdout.bench.mdd * 100).toFixed(1)}% / ${rm ? (rm.mdd * 100).toFixed(1) + '%' : '-'}) | ${r.holdout.sharpe.toFixed(2)} (${rm ? rm.sharpe.toFixed(2) : '-'}) | ${r.totalTrades} | ${Math.round(r.dsr * 100)}% (${r.trials}) | ${Math.round((r.dsrLab ?? 0) * 100)}% | ${verdict} |`);
  }
  if (cand?.status && Object.keys(cand.status).length) {
    const word = { waiting: '공개 전', no_data: '자료 부족(다음 주 다시)', released: '통과 → 모의 검증', rejected: '미통과(다시 고르지 않음)' };
    L.push('', '## 사전 등록 후보 대기열', '');
    for (const s of CANDIDATES) { const st = cand.status[s.id]; if (st) L.push(`- ${s.name} (${s.id}, 공개 ${s.releaseDate}): ${word[st.status] || st.status}${st.note ? ` — ${st.note}` : ''}`); }
  }
  if (research) { L.push('', '## 자동 연구(변형 탐색)', ''); for (const v of research.variants) L.push(`- 새 후보 ${v.id}: ${JSON.stringify(v.params)} (누적 시도 ${v.trials})`); if (!research.variants.length) L.push('- 이번 주 통과한 새 변형 없음 (정상: 대부분 탈락해야 함)'); }
  L.push('', '※ 과거 성과는 미래를 보장하지 않습니다. 대형주·코인 목록은 "지금" 기준이라 생존 편향이 있습니다. 투자 조언이 아닙니다.');
  return L.join('\n');
}

// ---------------- leverage study (모의 전용 선물 시뮬레이션, 2026-11-18) ----------------
/**
 * Same BTC trend rule (btc_perp_sim_v1) at 1x/2x/3x, three account sizes, with exchange lot size 0.001 BTC,
 * plus stress rows (no exchange stop, funding x3). Isolated margin: a liquidation loses that margin entirely.
 */
export function leverageStudy(data) {
  const base = byId.btc_perp_sim_v1;
  const series = data.crypto1d;
  const tl = (series['KRW-BTC'] || []).map((b) => b.t);
  const warm = Math.min(base.lookback, Math.floor(tl.length / 4));
  if (tl.length < warm + 200) return null;
  const hoFrom = holdoutFrom(`crypto:1d:KRW-BTC`, tl, warm);
  const lot = { qtyStep: 0.001, minQty: 0.001 }; // Binance BTCUSDT LOT_SIZE (2026-11-18 exchangeInfo), min notional 50 USDT
  const run = (lev, { account = 10_000_000, stop = true, funding = base.params.fundingPer8h, fromT = tl[warm] } = {}) => {
    const s = { ...base, params: { ...base.params, leverage: lev, stopAtr: stop ? base.params.stopAtr : 0, fundingPer8h: funding, ...lot } };
    const r = runBacktest({ strategy: s, series, fromT, initialCash: account });
    const st = r.state;
    return { lev, account, stop, funding, totalReturn: r.metrics.totalReturn, cagr: r.metrics.cagr, mdd: r.metrics.mdd, liquidations: st.liquidations || 0,
      entries: r.fills.filter((f) => f.phase === 'entry').length, skipped: st.skippedMin || 0,
      // 비용이 먹은 몫 = (수수료+펀딩) ÷ 비용 차감 전 이익 (복리로 커진 금액을 원금과 비교하면 과장되므로)
      costShare: (() => { const c = (st.fees || 0) + (st.funding || 0); const gross = st.equity - account + c; return gross > 0 ? Math.round((c / gross) * 10000) / 10000 : null; })() };
  };
  const won = (n) => (n >= 1e7 ? `${n / 1e7 * 1000}만` : `${n / 1e4}만`);
  const ho = `보존 구간(${ymd(hoFrom)}~)`, full = '전체(설계 기간 포함)';
  const rows = [];
  for (const lev of [1, 2, 3]) rows.push({ label: `${lev}배 · 가상 1000만 원 · 손절 있음`, period: full, ...run(lev) });
  rows.push({ label: '3배 · 손절 없음(스트레스)', period: full, ...run(3, { stop: false }) });
  rows.push({ label: '3배 · 펀딩비 3배(0.03%/8h, 2021년 수준)', period: full, ...run(3, { funding: 0.0003 }) });
  for (const account of [10_000_000, 1_000_000, 100_000]) for (const lev of [1, 2, 3]) rows.push({ label: `${lev}배 · 가상 ${won(account)} 원 · 손절 있음`, period: ho, ...run(lev, { account, fromT: hoFrom }) });
  rows.push({ label: '3배 · 가상 1000만 원 · 손절 없음(스트레스)', period: ho, ...run(3, { stop: false, fromT: hoFrom }) });
  // 규칙 없이 계속 롱(청산되면 다음 날 남은 돈의 50%로 다시 진입): 레버리지 자체의 청산 위험을 보여 주는 대조군
  const alwaysLong = { ...base, id: 'always_long_sim', decideFutures: (ctx) => (ctx.position ? null : { order: { action: 'open', side: 1, size: 0.5, stopDist: 0, reason: '대조군: 규칙 없이 롱' } }) };
  for (const lev of [1, 2, 3]) {
    for (const [period, fromT] of [[full, tl[warm]], [ho, hoFrom]]) {
      const r = runBacktest({ strategy: { ...alwaysLong, params: { ...base.params, leverage: lev, ...lot } }, series, fromT, initialCash: 10_000_000 });
      const st = r.state, c = (st.fees || 0) + (st.funding || 0), gross = st.equity - 10_000_000 + c;
      rows.push({ label: `대조군: 규칙 없이 계속 롱 ${lev}배`, period, lev, account: 10_000_000, stop: false, funding: base.params.fundingPer8h, totalReturn: r.metrics.totalReturn, cagr: r.metrics.cagr, mdd: r.metrics.mdd,
        liquidations: st.liquidations || 0, entries: r.fills.filter((f) => f.phase === 'entry').length, skipped: st.skippedMin || 0, costShare: gross > 0 ? Math.round((c / gross) * 10000) / 10000 : null });
    }
  }
  const bh = runBacktest({ strategy: byId.crypto_bh_v1, series, fromT: tl[warm] }).metrics;
  const bhHo = runBacktest({ strategy: byId.crypto_bh_v1, series, fromT: hoFrom }).metrics;
  rows.push({ label: '참고: 비트코인 그냥 보유(현물 1배, 100% 투자)', period: full, lev: 1, account: 10_000_000, stop: false, funding: 0, totalReturn: bh.totalReturn, cagr: bh.cagr, mdd: bh.mdd, liquidations: 0, entries: 1, skipped: 0, costShare: 0 });
  rows.push({ label: '참고: 비트코인 그냥 보유(현물 1배, 100% 투자)', period: ho, lev: 1, account: 10_000_000, stop: false, funding: 0, totalReturn: bhHo.totalReturn, cagr: bhHo.cagr, mdd: bhHo.mdd, liquidations: 0, entries: 1, skipped: 0, costShare: 0 });
  return { range: `${ymd(tl[warm])} ~ ${ymd(tl[tl.length - 1])}`, rows,
    note: '전체 기간 숫자는 규칙을 만들 때 이미 본 2018~2024년 상승장이 섞여 크게 부풀려져 있음 → 보존 구간을 보세요. 배수 = 증거금 대비 계약 크기(자본의 50%를 증거금으로 사용 → 1배는 자본 대비 0.5배 노출, 3배는 1.5배 노출). 업비트 현물 일봉으로 계산한 근사(실제 선물 가격·펀딩·청산 엔진과 다름). 과거 성과는 미래를 보장하지 않음.' };
}
function leverageMd(L) {
  if (!L) return '';
  const pc0 = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
  return ['## 레버리지 배수 비교 (모의 전용 · 선물 시뮬레이션)', '', `기간 ${L.range}. ${L.note}`, '', '| 조건 | 기간 | 총수익 | 연수익 | 최대 낙폭 | 강제 청산 | 진입 | 최소 주문 미달 | 비용이 먹은 몫(수수료+펀딩 ÷ 비용 전 이익) |', '|---|---|---|---|---|---|---|---|---|',
    ...L.rows.map((r) => `| ${r.label} | ${r.period} | ${pc0(r.totalReturn)} | ${pc(r.cagr)} | ${(r.mdd * 100).toFixed(1)}% | ${r.liquidations}회 | ${r.entries}회 | ${r.skipped}회 | ${r.costShare == null ? '-' : r.costShare > 1 ? '이익보다 큼' : (r.costShare * 100).toFixed(1) + '%'} |`), ''].join('\n');
}

async function main() {
  const data = await loadData();
  const only = opt('--only')?.split(',');
  const results = {};
  // 사전 등록 후보: 공개 날짜가 지난 것만, 주간 연구(--research)에서 한 번 판정. 이번 주에 판정할 것도 시도 수에 미리 넣는다.
  let cand = { ledger: readCands(), due: [], status: {} };
  if (flag('--research')) {
    // 날짜 주입(--candidates-as-of YYYY-MM-DD)은 가짜 자료(--fixtures)에서만 받는다
    const asOf = opt('--candidates-as-of') && flag('--fixtures') ? Date.parse(`${opt('--candidates-as-of')}T06:00:00+09:00`) / 1000 : NOW;
    cand = { ...cand, ...dueCandidates(asOf, cand.ledger, (s) => dataYears(s, data), undefined, (s) => dataComplete(s, data)) };
  }
  const candRegistry = [...triedCandidates(cand.ledger), ...cand.due];
  LAB_TRIALS = labTrialsCount([...STRATEGIES, ...candRegistry]) + orphanTrials(cand.ledger);
  log(`· 연구실 전체 시도 수(보정용): ${LAB_TRIALS}${candRegistry.length ? ` (사전 등록 후보 ${candRegistry.length}개 포함)` : ''}`);
  // registered weekly-research variants are re-evaluated too, so their evidence (risk-matched baseline etc.) stays current
  const releasedBefore = CANDIDATES.filter((s) => cand.ledger?.[s.id]?.status === 'released');
  for (const s of [...STRATEGIES, ...variantStrategies(readVariants()), ...releasedBefore]) {
    if (s.external || s.noBacktest || (only && !only.includes(s.id))) continue;
    const t0 = Date.now();
    try {
      // a registered variant already carries the family total at registration (priorTrials); add only trials spent since
      // an overlay (AI·뉴스 거부권 비교 장부) is the base rule plus one more idea: it inherits the base family's trials
      const baseOf = s.overlayOf ? byId[s.overlayOf] : null;
      const extra = s.generated ? Math.max(0, ledgerTrials(s.family) - (s.priorTrials || 0))
        : baseOf ? trialsFor(baseOf) + ledgerTrials(baseOf.family) + ledgerTrials(s.family)
        : s.candidate ? trialsFor(s, [s]) + ledgerTrials(s.family) : ledgerTrials(s.family);
      const r = evaluateStrategy(s, data, { extraTrials: extra });
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
  if (cand.due.length) {
    const j = judgeCandidates(cand.due, cand.ledger, NOW, (s, o) => evaluateStrategy(s, data, o));
    Object.assign(results, j.results);
    cand = { ...cand, ledger: j.ledger, status: { ...cand.status, ...j.status } };
    for (const [id, st] of Object.entries(j.status)) log(`  · 사전 등록 후보 ${id}: ${st.status} — ${st.note}`);
    if (!flag('--fixtures')) writeFileSync(CANDS, JSON.stringify(j.ledger, null, 2));
  }
  const res = flag('--research') ? await research(data, results, remote) : null;
  const tag = flag('--fixtures') ? 'fixtures' : 'latest';
  let lev = null;
  try { lev = leverageStudy(data); } catch (e) { log(`  ! leverage study: ${e.message}`); }
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify({ generatedAt: NOW, results, research: res, leverage: lev }, null, 1));
  writeFileSync(join(OUT, `${tag}-report-ko.md`), reportKo(results, res, cand) + '\n\n' + leverageMd(lev));
  log(`\n결과: backtest/results/${tag}.json, ${tag}-report-ko.md`);
  const seedOut = opt('--seed-sql');
  if (seedOut) { writeFileSync(seedOut, seedSql(data, results, res)); log(`D1 시드 SQL: ${seedOut}`); }
  const body = importBody(results, res, lev, cand);
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
export function importBody(results, res, leverage = null, cand = null) {
  const body = {
    format: 'fip-research-1', generatedAt: NOW, leverage,
    // 사전 등록 후보: 통과한 것만(Worker 가 코드의 목록·공개 날짜로 다시 거름) + 모든 후보의 상태 한 줄
    candidates: CANDIDATES.filter((s) => cand?.ledger?.[s.id]?.status === 'released').map((s) => ({ id: s.id, releasedAt: cand.ledger[s.id].at })),
    candidateStatus: cand?.status && Object.keys(cand.status).length ? cand.status : null,
    backtests: Object.entries(results).map(([id, r]) => { const { curve, ...summary } = r; return { strategy_id: id, kind: 'wf', source: r.source, summary, curve }; }),
    variants: (res?.variants || []).map(({ summary, ...v }) => v),
    trials: res?.trials || null,
  };
  for (const v of res?.variants || []) { const { curve, ...summary } = v.summary; body.backtests.push({ strategy_id: v.id, kind: 'wf', source: 'research', summary, curve }); }
  return body;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
