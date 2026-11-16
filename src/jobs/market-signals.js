// 코인 시장 신호 수집 + point-in-time guard history for paper ledgers.
// Cadence: each group has its own interval (30 min – 6 h); at most `maxGroups` due groups per cron tick,
// fetched in parallel (I/O, tiny CPU). Latest compact snapshot per group -> kv 'mkt:<id>'.
// The combined guard is written to the `signals` table ONLY WHEN IT CHANGES:
//   ('*mkt', t, 'risk_snap', nCoins, {altHold, triggers}) + ('KRW-X', t, 'risk_block', level 0.5|1|2, why)
//   + ('*crypto', t, 'risk_damp', factor, reason)
// so a paper ledger (and its agreement replay) sees exactly the guard that was active at each bar close.
// Derivatives (funding/OI/long-short/liquidations) are a SHADOW LOG ('deriv_log' rows), no rule by default.
import { MKT_GROUPS, mktConfig, computeGuard, guardKey, PROBE_TARGETS } from '../data/market-signals.js';
import { kvSetStmt, healthOk, healthErr, eventStmt } from '../db/store.js';
import { cryptoUniverse } from './collect.js';
import { CRYPTO_CORE, symName } from '../config.js';
import { DAY, HOUR } from '../core/calendar.js';

const LEVEL_CODE = { half: 0.5, block: 1, close: 2 };
const CODE_LEVEL = { 0.5: 'half', 1: 'block', 2: 'close' };

export function mktSnaps(kv) {
  return Object.fromEntries(MKT_GROUPS.map((g) => [g.id, kv[`mkt:${g.id}`] || null]));
}
export const relevantSyms = (kv) => new Set([...CRYPTO_CORE, ...cryptoUniverse(kv)]);

export async function marketSignalsTask(env, kv, now, { fetcher = fetch, maxGroups = 2 } = {}) {
  const cfg = mktConfig(env);
  if (!cfg.enabled) return false;
  const due = MKT_GROUPS.filter((g) => (kv[`mkt:at:${g.id}`] || 0) <= now - g.every)
    .sort((a, b) => (kv[`mkt:at:${a.id}`] || 0) - (kv[`mkt:at:${b.id}`] || 0)).slice(0, maxGroups);
  if (!due.length) return false;
  const res = await Promise.all(due.map(async (g) => {
    try { return { g, data: await g.fetch(fetcher, env, now, kv[`mkt:${g.id}`], cfg) }; } catch (err) { return { g, err }; }
  }));
  const stmts = [];
  for (const { g, data } of res) {
    kv[`mkt:at:${g.id}`] = now;
    stmts.push(kvSetStmt(env.DB, `mkt:at:${g.id}`, now));
    if (!data) continue;
    kv[`mkt:${g.id}`] = { at: now, ...data };
    stmts.push(kvSetStmt(env.DB, `mkt:${g.id}`, kv[`mkt:${g.id}`]));
    if (g.id === 'derivs') stmts.push(...derivLogStmts(env, data, now));
    if (g.id === 'notices') stmts.push(...noticeStmts(env, data, now));
  }
  stmts.push(...guardStmts(env, kv, now, cfg));
  await env.DB.batch(stmts);
  for (const { g, data, err } of res) {
    if (data) await healthOk(env.DB, `mkt:${g.id}`);
    else await healthErr(env.DB, `mkt:${g.id}`, err);
  }
  return true;
}

function derivLogStmts(env, d, now) {
  const ins = env.DB.prepare('INSERT OR REPLACE INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  const out = [];
  for (const c of ['BTC', 'ETH']) {
    if (d.funding?.[c] == null && !d.hl?.[c]) continue;
    out.push(ins.bind(c, now, 'deriv_log', d.funding?.[c] ?? 0, JSON.stringify({ hl8h: d.hl?.[c]?.funding8h ?? null, hlOiUsd: d.hl?.[c]?.oiUsd ?? null, oiUsd: d.oi?.[c]?.usd ?? null, oiChg: d.oi?.[c]?.chg24h ?? null, ls: d.ls?.[c] ?? null, liqUsd: d.liq?.usd ?? null, liqLong: d.liq?.longShare ?? null })));
  }
  return out;
}
/** Every classified Upbit notice is recorded once in D1 with its original link. */
function noticeStmts(env, d, now) {
  const st = env.DB.prepare('INSERT OR IGNORE INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)');
  return (d.upbitNotices || []).filter((n) => n.t && n.t > now - 3 * DAY).slice(0, 25)
    .map((n) => st.bind('upbit_notice', n.t, n.coins?.[0] ? `KRW-${n.coins[0]}` : '*crypto', n.rule || 'notice', JSON.stringify({ id: n.id, title: n.title, url: n.url, rule: n.rule, coins: n.coins }), now));
}

/** Recompute the guard; returns statements (history rows only when it changed). Mutates kv. */
export function guardStmts(env, kv, now, cfg = mktConfig(env)) {
  const g = computeGuard(mktSnaps(kv), cfg, now, relevantSyms(kv));
  const key = guardKey(g);
  const prev = kv['mkt:guard'];
  const stmts = [];
  if (!prev || prev.key !== key) {
    const ins = env.DB.prepare('INSERT OR REPLACE INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
    stmts.push(ins.bind('*mkt', now, 'risk_snap', Object.keys(g.coins).length, JSON.stringify({ altHold: g.altHold, triggers: g.damp?.triggers || [] })));
    for (const [sym, c] of Object.entries(g.coins)) stmts.push(ins.bind(sym, now, 'risk_block', LEVEL_CODE[c.level], c.why.slice(0, 200)));
    if (g.damp) stmts.push(ins.bind('*crypto', now, 'risk_damp', g.damp.factor, g.damp.reason.slice(0, 200)));
    stmts.push(env.DB.prepare("DELETE FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp','deriv_log') AND t < ?").bind(now - 400 * DAY));
    const pc = prev?.coins || {};
    const alert = Object.entries(g.coins).filter(([s, c]) => (c.level === 'close' || g.frozen.includes(s)) && pc[s]?.level !== c.level);
    const other = Object.entries(g.coins).filter(([s, c]) => !alert.some(([a]) => a === s) && pc[s]?.level !== c.level);
    const fmt = (xs) => xs.slice(0, 6).map(([s, c]) => `${symName(s)}(${c.why})`).join(', ');
    if (alert.length) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_alert', message: `🚨 코인 시장 신호: ${fmt(alert)} → 청산 전용·새로 사지 않음 (자동 매도 없음, 공격형 슬롯은 다음 판단 때 정리)` }));
    if (other.length) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_signal', message: `🛡️ 코인 시장 신호: ${fmt(other)} → ${other.every(([, c]) => c.level === 'half') ? '새 매수 절반' : '새로 사지 않음'}` }));
    if (g.altHold && !prev?.altHold) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_alert', message: `⚠️ ${g.altHold} → 알트코인 새 매수 보류 (비트·이더는 그대로)` }));
    if (!g.altHold && prev?.altHold) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_signal', message: '✓ 코인 공지·경보 데이터 정상화 → 알트코인 매수 보류 해제' }));
    if (g.damp && (!prev?.damp || prev.damp.factor !== g.damp.factor)) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_signal', message: `🌡️ 코인 시장 신호(${g.damp.reason}) → 코인 전략 새 매수 ${g.damp.factor === 0 ? '보류' : `×${g.damp.factor}`}` }));
    if (!g.damp && prev?.damp) stmts.push(eventStmt(env.DB, { t: now, kind: 'market_signal', message: '🌡️ 코인 시장 과열·이상 신호 해제 → 새 매수량 원래대로' }));
  }
  kv['mkt:guard'] = { at: now, key, coins: g.coins, altHold: g.altHold, damp: g.damp, frozen: g.frozen, warnings: g.warnings.slice(0, 20), changedAt: !prev || prev.key !== key ? now : prev.changedAt };
  stmts.push(kvSetStmt(env.DB, 'mkt:guard', kv['mkt:guard']));
  return stmts;
}

const barClose = (s, t) => (s.timeframe === '1h' ? t + HOUR : t + DAY);

/**
 * Point-in-time guard for a crypto PAPER run over bars (from, toT]. Returns t -> guard|null
 * (guard active at the bar's close), or undefined when not applicable.
 */
export async function guardFor(env, strategy, from, toT) {
  if (strategy.market !== 'crypto' || strategy.benchmarkOnly || strategy.stepper) return undefined;
  const cfg = mktConfig(env);
  if (!cfg.enabled || (!cfg.guard && !cfg.dampener)) return undefined;
  const lo = Number.isFinite(from) ? barClose(strategy, from) : 0;
  const hi = barClose(strategy, toT);
  const first = await env.DB.prepare("SELECT MAX(t) AS m FROM signals WHERE kind = 'risk_snap' AND t <= ?").bind(lo).first();
  const { results } = await env.DB.prepare("SELECT sym, t, kind, value, note FROM signals WHERE kind IN ('risk_snap','risk_block','risk_damp') AND t >= ? AND t <= ? ORDER BY t")
    .bind(first?.m ?? lo, hi).all();
  if (!results.length) return undefined;
  const snaps = new Map();
  for (const r of results) {
    if (!snaps.has(r.t)) snaps.set(r.t, { t: r.t, coins: {}, damp: null, altHold: null, snap: false });
    const s = snaps.get(r.t);
    if (r.kind === 'risk_snap') { s.snap = true; try { s.altHold = JSON.parse(r.note || '{}').altHold || null; } catch { s.altHold = null; } }
    else if (r.kind === 'risk_block') s.coins[r.sym] = { level: CODE_LEVEL[r.value] || 'block', why: r.note || '시장 위험 신호' };
    else if (r.kind === 'risk_damp') s.damp = { factor: r.value, reason: r.note || '시장 이상 신호' };
  }
  const list = [...snaps.values()].filter((s) => s.snap).sort((a, b) => a.t - b.t);
  return (t) => {
    const c = barClose(strategy, t);
    let g = null;
    for (const s of list) { if (s.t <= c) g = s; else break; }
    if (!g) return null;
    return { coins: cfg.guard ? g.coins : {}, altHold: cfg.guard ? g.altHold : null, damp: cfg.dampener ? g.damp : null };
  };
}

/** Owner-only: reachability of every source from THIS egress (status, latency, size; bodies discarded). */
export async function probeSources({ fetcher = fetch, timeoutMs = 8000 } = {}) {
  const rows = await Promise.all(PROBE_TARGETS.map(async ([name, url, body]) => {
    const t0 = Date.now();
    try {
      const init = { method: body ? 'POST' : 'GET', headers: { 'User-Agent': 'family-invest-paper/2 (read-only market data; paper trading)', Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetcher(url, init);
      const bytes = (await res.arrayBuffer()).byteLength;
      return { name, host: new URL(url).hostname, status: res.status, ok: res.ok, optional: /바이낸스/.test(name), ms: Date.now() - t0, bytes };
    } catch (e) {
      return { name, host: new URL(url).hostname, status: 0, ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 80) };
    }
  }));
  return { at: Math.floor(Date.now() / 1000), ok: rows.filter((r) => r.ok).length, total: rows.length, rows };
}

/** Dashboard view (plain data; the UI words it in Korean). */
export async function marketSignalsView(env, kv, now, opts = {}) {
  const cfg = mktConfig(env);
  const snaps = mktSnaps(kv);
  const relevant = relevantSyms(kv);
  // overview() passes the row from its batch; otherwise query it here.
  const fg = 'fg' in opts ? opts.fg : await env.DB.prepare("SELECT t, payload FROM feed_items WHERE source = 'fear_greed' ORDER BY t DESC LIMIT 1").first();
  const w = snaps.notices?.wallet || {};
  const strip = (x) => { if (!x) return null; const { errors, ...rest } = x; return rest; };
  return {
    enabled: cfg.enabled,
    config: { guard: cfg.guard, dampener: cfg.dampener, derivRules: cfg.derivRules, halfFactor: cfg.halfFactor, premHalf: cfg.premHalf, premHold: cfg.premHold, premWarnLow: cfg.premWarnLow, priceDevMax: cfg.priceDevMax, tetherMax: cfg.tetherMax, coinbaseMin: cfg.coinbaseMin, suspendHours: cfg.suspendHours, listingDays: cfg.listingDays },
    groups: MKT_GROUPS.map((g) => ({ id: g.id, name: g.name, everyMin: g.every / 60, at: snaps[g.id]?.at || null, tried: kv[`mkt:at:${g.id}`] || null, errors: snaps[g.id]?.errors || [] })),
    premium: strip(snaps.premium),
    derivs: strip(snaps.derivs),
    flags: (snaps.upbit_flags?.flags || []).map((f) => ({ ...f, relevant: relevant.has(f.sym) })).sort((a, b) => b.relevant - a.relevant || b.warning - a.warning).slice(0, 30),
    flagCount: (snaps.upbit_flags?.flags || []).length,
    notices: (snaps.notices?.upbitNotices || []).filter((n) => n.rule).slice(0, 8),
    noticesOk: !!snaps.notices?.upbitOk,
    bithumbWarnings: (snaps.notices?.bithumbWarnings || []).filter((x) => x.step !== 'CAUTION').slice(0, 10),
    wallet: Object.entries(w).filter(([c]) => relevant.has(`KRW-${c}`)).map(([c, x]) => ({ sym: `KRW-${c}`, ...x })),
    walletCount: Object.keys(w).length,
    delist: snaps.notices?.delist || [],
    fearGreed: fg ? { t: fg.t, ...JSON.parse(fg.payload) } : null,
    guard: kv['mkt:guard'] || null,
  };
}
