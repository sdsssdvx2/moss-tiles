// JSON builders for the dashboard and the signal export.
import { allStrategies, strategyById, trialsFor } from './strategies/index.js';
import { getRuns, lifecycleAll, downsample, kvAll, kvSetStmt } from './db/store.js';
import { mergeRisk } from './core/risk.js';
import { DEFAULT_COSTS } from './core/costs.js';
import { symName } from './config.js';
import { DAY, krxSessionOpen } from './core/calendar.js';
import { gatesFrom, btEvidence } from './jobs/lifecycle.js';
import { universeFor } from './jobs/paper.js';
import { aiConfigured, aiLabel } from './jobs/ai.js';
import { FEEDS } from './data/feeds.js';
import { marketSignalsView } from './jobs/market-signals.js';
import { membersView } from './core/members.js';
import { criteriaView } from './core/criteria.js';

const r4 = (x) => Math.round(x * 10000) / 10000;

function positionsOf(state) {
  if (state.kind === 'futures') {
    if (!state.pos) return [];
    const px = state.lastPx[state.pos.sym] || state.pos.entry;
    const upnl = state.pos.side * (px - state.pos.entry) * state.pos.qty;
    return [{ sym: state.pos.sym, name: `${symName(state.pos.sym)} ${state.pos.side > 0 ? '롱' : '숏'} ${state.pos.lev}배(시뮬)`, qty: state.pos.qty, value: Math.round(state.pos.margin + upnl), weight: r4((state.pos.margin + upnl) / state.equity), pnlPct: r4(upnl / state.pos.margin), stop: state.pos.stop, liq: state.pos.liq }];
  }
  return Object.entries(state.pos || {}).map(([sym, p]) => {
    const px = state.lastPx[sym] || 0;
    const value = p.qty * px;
    return { sym, name: symName(sym), qty: p.qty, price: px, value: Math.round(value), weight: r4(state.equity > 0 ? value / state.equity : 0), pnlPct: r4(p.cost > 0 ? value / p.cost - 1 : 0) };
  }).sort((a, b) => b.value - a.value);
}

// kv keys the overview needs (everything else in kv — cursors, backfill state, research trials — is skipped).
const OVERVIEW_KV = ['family:members', 'criteria:log', 'ai:scorecard', 'ai:cross', 'decision:current', 'decision:log', 'ai:consistency', 'research:leverage', 'variants', 'crypto:universe', 'sleeve:aggressive:stopped', 'ready:krx:1d', 'ready:crypto:1d', 'ready:crypto:1h', 'cov:krx:1d', 'cov:crypto:1d', 'cov:crypto:1h', 'research:lastImport', 'research:lastError', 'research:checkedAt'];
const parseKv = (rows) => { const o = {}; for (const r of rows) { try { o[r.k] = JSON.parse(r.v); } catch { o[r.k] = r.v; } } return o; };
const btFromRow = (r) => ({ ...r, summary: JSON.parse(r.summary) });

/**
 * Dashboard JSON. Two D1 round trips (one batch for everything + one for the equity curves);
 * no backtest curves (the dashboard does not draw them), only the kv keys it shows.
 */
export async function overview(env, now = Math.floor(Date.now() / 1000)) {
  const db = env.DB;
  const kvIn = OVERVIEW_KV.map(() => '?').join(',');
  const [rRuns, rLc, rBt, rKv, rFills, rHealth, rEvents, rAlloc, rFeeds, rAi, rFg, rReb] = await db.batch([
    db.prepare("SELECT id, strategy_id, mode, state, start_after, last_t FROM runs WHERE mode = 'paper'"),
    db.prepare('SELECT strategy_id, stage, label, summary, checks, paper_since, promoted_t FROM lifecycle'),
    db.prepare("SELECT strategy_id, kind, source, summary FROM backtests WHERE kind IN ('wf', 'worker')"),
    db.prepare(`SELECT k, v FROM kv WHERE k IN (${kvIn}) OR k LIKE 'mkt:%'`).bind(...OVERVIEW_KV),
    db.prepare("SELECT run_id, t, sym, side, qty, price, fee, tax, pnl, reason FROM fills WHERE run_id LIKE '%:paper' ORDER BY t DESC, seq DESC LIMIT 60"),
    db.prepare('SELECT * FROM data_health ORDER BY source'),
    db.prepare('SELECT t, kind, strategy_id, message FROM events ORDER BY id DESC LIMIT 40'),
    db.prepare('SELECT t, weights, notes FROM allocations ORDER BY t DESC LIMIT 12'),
    db.prepare('SELECT source, COUNT(*) AS n, MAX(t) AS last FROM feed_items WHERE t >= ? GROUP BY source').bind(now - 3 * DAY),
    db.prepare("SELECT t, model, ok, note FROM ai_audit WHERE note IS NULL OR note NOT LIKE 'qa;%' ORDER BY id DESC LIMIT 5"),
    db.prepare("SELECT t, payload FROM feed_items WHERE source = 'fear_greed' ORDER BY t DESC LIMIT 1"),
    db.prepare("SELECT run_id, COUNT(DISTINCT t) AS n FROM fills WHERE run_id LIKE '%:paper' GROUP BY run_id"),
  ]);
  const rebal = Object.fromEntries(rReb.results.map((r) => [r.run_id, r.n]));
  const runs = rRuns.results.map((r) => ({ ...r, state: JSON.parse(r.state) }));
  const lc = Object.fromEntries(rLc.results.map((r) => [r.strategy_id, { ...r, checks: JSON.parse(r.checks) }]));
  const bts = rBt.results.map(btFromRow);
  const kv = parseKv(rKv.results);
  const fills = rFills.results;
  const byRun = Object.fromEntries(runs.map((r) => [r.id, r]));
  const gates = gatesFrom(env);
  // Equity curves for every paper run in ONE query. Daily points are stored at UTC midnight (KST date
  // label), so `t % 86400 = 0` keeps every daily point and one point per day for hourly runs.
  const curves = {};
  if (runs.length) {
    const { results } = await db.prepare("SELECT run_id, t, equity, bench, invested FROM equity WHERE run_id LIKE '%:paper' AND (t % 86400) = 0 ORDER BY run_id, t").all();
    for (const p of results) (curves[p.run_id] ||= []).push(p);
  }
  const strategies = [];
  const ALL = allStrategies(kv);
  for (const s of ALL) {
    const run = byRun[`${s.id}:paper`];
    const l = lc[s.id];
    let curve = [];
    if (run) curve = downsample(curves[run.id] || [], 120).map((p) => ({ t: p.t, e: Math.round(p.equity), b: Math.round(p.bench) }));
    const fresh = run ? freshStats(curves[run.id] || [], run.state, rebal[run.id] || 0) : null;
    const st = run?.state;
    const bt = btEvidence(bts, s.id, s);
    const risk = mergeRisk(s.risk);
    strategies.push({
      id: s.id, name: s.name, market: s.market, timeframe: s.timeframe, description: s.description, family: s.family, version: s.version,
      cadence: s.cadence, sleeve: s.sleeve || null, researchOnly: !!s.researchOnly, simulationOnly: !!s.simulationOnly, benchmarkOnly: !!s.benchmarkOnly, overlayOf: s.overlayOf || null, profile: s.profile || null,
      closed: !!s.closed, memberKey: s.memberKey || null, book: s.book || null, growthCandidate: !!s.growthCandidate, dynamicLeverage: !!s.dynamicLeverage,
      trials: trialsFor(s, ALL), generated: !!s.generated, variantOf: s.variantOf || null,
      stage: l?.stage || (s.benchmarkOnly ? 'benchmark' : 'backtest'), label: l?.label || (s.benchmarkOnly ? '기준선' : '백테스트 중'),
      summary: l?.summary || '첫 평가를 기다리는 중', checks: l?.checks || [], paperSince: l?.paper_since || null, promotedT: l?.promoted_t || null,
      paper: st ? {
        equity: Math.round(st.equity), initial: st.initialCash, ret: r4(st.equity / st.initialCash - 1), bench: Math.round(st.bench), benchRet: r4(st.bench / st.initialCash - 1),
        cash: Math.round(st.cash), dd: r4(st.peak > 0 ? 1 - st.equity / st.peak : 0), fills: st.fills, halted: !!st.halted, haltReason: st.haltReason,
        startT: st.startT, lastT: run.last_t, startAfter: run.start_after, fees: Math.round((st.fees || 0) + (st.taxes || 0)), liquidations: st.liquidations || 0,
      } : null,
      curve, fresh, positions: st ? positionsOf(st) : [], leverageCompare: s.leverageCompare || (s.id === 'btc_perp_sim_v1' ? 2 : null), aiSolo: !!s.aiSolo, noBacktest: !!s.noBacktest,
      pending: (st?.kind === 'futures' ? (st.pending ? [st.pending] : []) : st?.pending || []).map((o) => ({ sym: o.sym, side: o.side, qty: o.qty, reason: o.reason })),
      recent: fills.filter((f) => f.run_id === `${s.id}:paper`).slice(0, 8).map(({ run_id, ...f }) => ({ ...f, name: symName(f.sym) })),
      bt: bt ? { holdout: bt.holdout || null, holdout2x: bt.holdout2x || null, wf: bt.wf || null, years: bt.years, dsr: bt.dsr, trials: bt.trials, totalTrades: bt.totalTrades, source: bt.source || 'local', range: bt.range || null, labTrials: bt.labTrials ?? null, dsrLab: bt.dsrLab ?? null, luckSharpe: bt.luckSharpe ?? null } : null,
      risk: { maxPositionWeight: risk.maxPositionWeight, minCash: risk.minCash, dailyLossLimit: risk.dailyLossLimit, weeklyLossLimit: risk.weeklyLossLimit, maxDrawdownHalt: risk.maxDrawdownHalt },
      universe: universeFor(s, kv).map((x) => ({ sym: x, name: symName(x) })),
    });
  }
  const health = rHealth.results, events = rEvents.results, alloc = rAlloc.results;
  const cov = (m, tf) => { const c = kv[`cov:${m}:${tf}`] || {}; const v = Object.values(c); return { symbols: v.length, from: v.length ? Math.min(...v.map((x) => x.min)) : null, to: v.length ? Math.max(...v.map((x) => x.max)) : null }; };
  const sl = strategies.filter((x) => x.sleeve === 'aggressive' && x.paper);
  const slInit = sl.reduce((a, x) => a + x.paper.initial, 0), slEq = sl.reduce((a, x) => a + x.paper.equity, 0);
  const labBt = bts.map((r) => r.summary).filter((x) => x?.labTrials).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0))[0];
  return {
    now, paperOnly: true, liveOrders: false, version: '2.2.0',
    honesty: {
      freshFrom: Math.min(...runs.map((r) => r.state?.startT).filter(Boolean)) || null,
      labTrials: labBt?.labTrials ?? null, luckSharpe: labBt?.luckSharpe ?? null,
      note: '과거 검증(보존 구간 포함)은 설계자가 이미 지나간 시기라 완전히 처음 보는 자료가 아님. 모의 기록만 진짜 처음 보는 자료.',
    },
    decision: kv['decision:current'] || null,
    members: membersView(kv['family:members']),
    criteria: (() => { const c = criteriaView(gates); return { version: c.version, hash: c.hash, goal: c.goal, plain: c.plain, history: c.history, log: [...(kv['criteria:log'] || [])].reverse().slice(0, 20) }; })(),
    aiScorecard: kv['ai:scorecard'] ? (({ scored, ...x }) => x)(kv['ai:scorecard']) : null,
    aiCross: kv['ai:cross'] ? { n: kv['ai:cross'].n, signAgree: kv['ai:cross'].signAgree, model: kv['ai:cross'].model, at: kv['ai:cross'].at } : null,
    ask: { ai: aiConfigured(env) },
    decisionLog: (kv['decision:log'] || []).slice(-15).reverse(),
    aiCompare: aiCompare(strategies, curves, byRun),
    aiConsistency: kv['ai:consistency'] ? { n: kv['ai:consistency'].n, meanAbsDiff: kv['ai:consistency'].meanAbsDiff, signAgree: kv['ai:consistency'].signAgree, vetoAgree: kv['ai:consistency'].vetoAgree, at: kv['ai:consistency'].at } : null,
    leverage: kv['research:leverage'] || null,
    sleeve: { ret: slInit ? slEq / slInit - 1 : null, stopped: kv['sleeve:aggressive:stopped'] || null, ...(gates.live.sleeves?.aggressive || {}) },
    market: { krxOpen: krxSessionOpen(now) },
    strategies,
    allocation: alloc.map((a) => ({ t: a.t, weights: JSON.parse(a.weights), notes: JSON.parse(a.notes) })),
    data: {
      ready: { krx: kv['ready:krx:1d'] || null, crypto1d: kv['ready:crypto:1d'] || null, crypto1h: kv['ready:crypto:1h'] || null },
      coverage: { krx: cov('krx', '1d'), crypto1d: cov('crypto', '1d'), crypto1h: cov('crypto', '1h') },
      universe: (kv['crypto:universe'] || []).map((s) => ({ sym: s, name: symName(s) })),
      sources: { krxKey: !!env.KRX_AUTH_KEY, dataGoKr: !!env.DATA_GO_KR_KEY, naver: String(env.ALLOW_UNOFFICIAL_NAVER ?? 'true') !== 'false', telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), newsVeto: env.NEWS_VETO_PROVIDER || 'none', ai: aiLabel(env) },
      feeds: FEEDS.map((f) => ({ id: f.id, name: f.name, enabled: !f.needs || !!env[f.needs], needs: f.needs })),
      feedCounts: rFeeds.results,
      aiAudit: rAi.results,
      research: { url: !!env.RESEARCH_URL, last: kv['research:lastImport'] || null, error: kv['research:lastError'] || null, checkedAt: kv['research:checkedAt'] || null },
      health,
    },
    marketSignals: await marketSignalsView(env, kv, now, { fg: rFg.results[0] || null }),
    events,
    assumptions: { krxCommission: DEFAULT_COSTS.krx.commission, krxSellTaxStock: DEFAULT_COSTS.krx.sellTaxStock, krxSellTaxEtf: DEFAULT_COSTS.krx.sellTaxEtf, etfTaxNote: 'ETF 매도세는 출처마다 설명이 달라 "면제(0%)"로 가정함. 설정으로 바꿀 수 있음.', upbitFee: DEFAULT_COSTS.crypto.commission, upbitMinOrder: DEFAULT_COSTS.crypto.minOrderKrw, slippage: { krx: DEFAULT_COSTS.krx.slippage, crypto: DEFAULT_COSTS.crypto.slippage } },
    gates,
  };
}

/**
 * 처음 보는 자료(모의 장부 시작 이후) 요약. 같은 투자비율 기준 = 장부의 평균 투자 비율만큼만 기준 지수를 들고
 * 나머지는 현금(0%)인 고정 비율(일별 근사). 짧은 기간이라 실력 판단 근거가 아님(화면에도 그렇게 표시).
 */
export function freshStats(points, state, rebalances = 0) {
  if (!state) return null;
  const init = state.initialCash || 1;
  const pts = points || [];
  const exp = pts.length ? pts.reduce((a, p) => a + (p.equity > 0 ? Math.min(1, (p.invested || 0) / p.equity) : 0), 0) / pts.length : 0;
  let rm = 1;
  for (let i = 1; i < pts.length; i++) if (pts[i - 1].bench > 0) rm *= 1 + exp * (pts[i].bench / pts[i - 1].bench - 1);
  if (pts.length && pts[0].bench > 0) rm *= 1 + exp * (pts[0].bench / init - 1);
  return { from: state.startT || null, days: pts.length, ret: r4(state.equity / init - 1), benchRet: r4(state.bench / init - 1), rmRet: r4(rm - 1), exposure: r4(exp), rebalances };
}

/** AI 공정 비교: 같은 시장의 규칙 / 규칙+AI 비중 / 규칙+뉴스 거부권 / AI 단독 장부를 "모두 기록이 있는 공통 기간"에서 비교. */
export const AI_GROUPS = [
  { market: 'krx', label: 'ETF (A 규칙 기준)', ids: ['etf_trend_v1', 'etf_trend_ai_v1', 'etf_trend_veto_v1', 'ai_solo_etf_v1'] },
  { market: 'crypto', label: '비트·이더 (C 규칙 기준)', ids: ['crypto_trend_v1', 'crypto_trend_ai_v1', 'crypto_trend_veto_v1', 'ai_solo_crypto_v1'] },
];
export function aiCompare(strategies, curves, byRun) {
  return AI_GROUPS.map((g) => {
    const rows = g.ids.map((id) => ({ id, s: strategies.find((x) => x.id === id), c: curves[`${id}:paper`] || [] })).filter((x) => x.s && x.c.length);
    if (!rows.length) return { ...g, from: null, rows: [] };
    const from = Math.max(...rows.map((x) => x.c[0].t));
    return { ...g, from, rows: rows.map((x) => {
      const c = x.c.filter((p) => p.t >= from);
      if (!c.length) return { id: x.id, name: x.s.name, days: 0 };
      let peak = -Infinity, mdd = 0;
      for (const p of c) { peak = Math.max(peak, p.equity); mdd = Math.max(mdd, 1 - p.equity / peak); }
      return { id: x.id, name: x.s.name, days: c.length, ret: r4(c[c.length - 1].equity / c[0].equity - 1), mdd: r4(mdd), fills: byRun[`${x.id}:paper`]?.state?.fills ?? 0 };
    }) };
  });
}

/** Read-only export of latest target positions for a FUTURE external executor (e.g. Oracle VM). */
export async function exportSignals(env) {
  const [runs, lc, kv] = await Promise.all([getRuns(env.DB), lifecycleAll(env.DB), kvAll(env.DB)]);
  const out = [];
  for (const r of runs.filter((x) => x.mode === 'paper')) {
    const s = strategyById(kv, r.strategy_id);
    if (!s) continue;
    out.push({
      strategy_id: s.id, market: s.market, timeframe: s.timeframe, stage: lc[s.id]?.stage || null,
      eligibleForLive: lc[s.id]?.stage === 'live_candidate' && !s.researchOnly && !s.benchmarkOnly && !s.simulationOnly && !s.growthCandidate && !s.closed,
      asOf: r.last_t, targets: r.state.lastTargets || null,
      pendingPaperOrders: (Array.isArray(r.state.pending) ? r.state.pending : []).map((o) => ({ sym: o.sym, side: o.side, qty: o.qty })),
    });
  }
  const g = kv['mkt:guard'];
  const marketRisk = g ? { asOf: g.at, changedAt: g.changedAt, coins: g.coins, altHold: g.altHold, damp: g.damp, frozen: g.frozen, note: 'Risk signals only. coins[sym].level: close = no new buys + exit-only, block = no new buys, half = new buys x0.5; altHold = no new alt buys; damp.factor scales new crypto buys (0 = hold). Aggressive sleeve exits close/block coins.' } : null;
  return { generatedAt: Math.floor(Date.now() / 1000), note: 'Read-only paper signals. This service never places orders.', marketRisk, strategies: out };
}

// ---------- cached overview (kv 'overview:cache') ----------
// The data only changes on the 10-minute cron tick, so the dashboard is served from a cached JSON
// string (no parse/rebuild = ~no CPU). The tick refreshes it when it was a light tick; otherwise it
// marks 'overview:dirty' and the next request rebuilds it (60 s TTL while dirty, 15 min hard max).
export const CACHE_TTL_DIRTY = 60;
export const CACHE_MAX_AGE = 15 * 60;
const CACHE_MAX_BYTES = 1_500_000; // D1 row limit is ~2 MB

export function cacheFresh({ cacheAt, dirtyAt, now }) {
  if (!cacheAt) return false;
  const age = now - cacheAt;
  if (age < 0 || age >= CACHE_MAX_AGE) return false;
  if (age < CACHE_TTL_DIRTY) return true;
  return !(dirtyAt && dirtyAt > cacheAt);
}

export async function buildOverviewCache(env, now = Math.floor(Date.now() / 1000)) {
  const o = await overview(env, now);
  o.cachedAt = now;
  const text = JSON.stringify(o);
  if (text.length < CACHE_MAX_BYTES) {
    await env.DB.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('overview:cache', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(text, now).run();
  }
  return text;
}

/** Returns { text, hit }. `text` is the JSON string to send as-is. */
export async function overviewCached(env, now = Math.floor(Date.now() / 1000)) {
  const { results } = await env.DB.prepare("SELECT k, v, updated_at FROM kv WHERE k IN ('overview:cache', 'overview:dirty')").all();
  const c = results.find((r) => r.k === 'overview:cache');
  const d = results.find((r) => r.k === 'overview:dirty');
  if (c && cacheFresh({ cacheAt: c.updated_at, dirtyAt: d ? Number(d.v) : 0, now })) return { text: c.v, hit: true };
  return { text: await buildOverviewCache(env, now), hit: false };
}
export const markOverviewDirty = (env, now = Math.floor(Date.now() / 1000)) => kvSetStmt(env.DB, 'overview:dirty', now).run();
export const dropOverviewCache = (env) => env.DB.prepare("DELETE FROM kv WHERE k = 'overview:cache'").run();
