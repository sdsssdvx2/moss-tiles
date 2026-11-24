// Incremental market-data collection. Small batches per cron tick (Workers Free: 10 ms CPU,
// 50 external subrequests). Coverage cursors live in kv (no full-table scans: D1 free tier
// enforces daily row-read limits).
import { DAY, HOUR, latestFinalCryptoDay, latestFinalHour, latestFinalKrxDay, nextKrxBusinessDay, prevKrxBusinessDay, kstAt } from '../core/calendar.js';
import { fetchUpbitCandles, finalOnly, fetchUpbitTop } from '../data/upbit.js';
import { fetchKrxDay, fetchNaverDaily, fetchDataGoKrHistory } from '../data/krx.js';
import { candleStmts, kvSetStmt, healthOk, healthErr } from '../db/store.js';
import { CRYPTO_CORE, KRX_ETFS, KRX_STOCKS, CANDIDATE_ETFS, krxMeta, CRYPTO_MAX, RETENTION, ETF_NAV_UNIVERSE } from '../config.js';

export function cryptoUniverse(kv) {
  const u = kv['crypto:universe'];
  return Array.isArray(u) && u.length ? u : CRYPTO_CORE;
}
/** 기존 장부가 쓰는 종목: 이것만 수집 진행 조건(ready:krx:1d)과 공식 API 날짜 커서를 정한다. */
export const coreKrxCodes = () => [...Object.keys(KRX_ETFS), ...Object.keys(KRX_STOCKS)];
/** 수집 대상 전체: 후보용 새 ETF는 맨 뒤(틱당 대체 수집 몫에서 기존 종목이 먼저). */
const isCandidateCode = (c) => c in CANDIDATE_ETFS && !(c in KRX_ETFS) && !(c in KRX_STOCKS);
export const krxCodes = () => [...coreKrxCodes(), ...Object.keys(CANDIDATE_ETFS).filter(isCandidateCode)];
/** 후보 종목의 수집 실패는 'cand:' 출처로 기록 → /health 는 보여 주기만 하고 멈춤 경보로 세지 않는다(health.js 정규식 밖). */
const srcFor = (src, c) => (isCandidateCode(c) ? `cand:${src}` : src);

function covKey(market, tf) { return `cov:${market}:${tf}`; }
function mergeCov(cov, sym, bars) {
  if (!bars.length) return;
  const c = cov[sym] || { min: bars[0].t, max: bars[bars.length - 1].t };
  c.min = Math.min(c.min, bars[0].t); c.max = Math.max(c.max, bars[bars.length - 1].t);
  cov[sym] = c;
}

/**
 * 자료 이상치 점검(2026-11-18): 국내 1배 ETF가 하루 ±15%, 개별주가 ±30%(가격제한폭) 넘게 움직이면 경고.
 * 비공식(네이버) 자료면 KRX 공식 종가(etf_bydd_trd → signals 'etf_nav'.note.c)와 대조한다. 자료를 고치지는 않는다:
 * 2026-07-31 KODEX 200TR +22.1%는 KRX 공식 종가 38,810원 = 네이버 38,810원, NAV +20%로 실제 시세였다.
 * Pure part: returns null or {ret, limit}.
 */
export function jumpCheck(prevClose, bar, { etf = false } = {}) {
  if (!(prevClose > 0) || !(bar?.c > 0)) return null;
  const ret = bar.c / prevClose - 1, limit = etf ? 0.15 : 0.30;
  return Math.abs(ret) > limit ? { ret, limit } : null;
}
async function jumpEvents(env, kv, sym, bars, src) {
  const recent = Date.now() / 1000 - 10 * DAY; // only fresh bars (backfills of old history would spam)
  if (!bars.length || bars[bars.length - 1].t < recent) return [];
  const prev = await env.DB.prepare("SELECT c FROM candles WHERE market = 'krx' AND tf = '1d' AND sym = ? AND t < ? ORDER BY t DESC LIMIT 1").bind(sym, bars[0].t).first();
  const out = [];
  let pc = prev?.c;
  for (const b of bars) {
    const j = b.t >= recent && jumpCheck(pc, b, { etf: !!krxMeta[sym]?.etf });
    pc = b.c;
    const key = `jump:${sym}:${b.t}`;
    if (!j || kv[key]) continue;
    kv[key] = 1;
    let check = src === 'krx' ? 'KRX 공식 자료 기준 → 실제 급변으로 봄' : 'KRX 공식 종가와 대조 필요';
    if (src !== 'krx') {
      const nav = await env.DB.prepare("SELECT note FROM signals WHERE kind = 'etf_nav' AND sym = ? AND t = ?").bind(sym, b.t).first().catch(() => null);
      let oc = null; try { oc = JSON.parse(nav?.note || 'null')?.c; } catch (_) {}
      if (oc > 0) check = Math.abs(oc / b.c - 1) < 0.005 ? `KRX 공식 종가(${oc.toLocaleString('ko-KR')}원)와 일치 → 실제 시세` : `⚠️ KRX 공식 종가 ${oc.toLocaleString('ko-KR')}원과 다름 → 자료 오류 가능`;
    }
    const d = new Date(b.t * 1000).toISOString().slice(0, 10);
    out.push(kvSetStmt(env.DB, key, 1), env.DB.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)')
      .bind(Math.floor(Date.now() / 1000), 'data_warn', null, `[자료 점검] ${krxMeta[sym]?.name || sym} ${d} 하루 ${(j.ret * 100).toFixed(1)}% (기준 ±${Math.round(j.limit * 100)}%, 출처 ${src}): ${check}`));
  }
  return out;
}

/** Write bars + updated coverage atomically (one D1 batch = one query). */
async function store(env, kv, market, tf, sym, bars, src, extra = []) {
  const cov = kv[covKey(market, tf)] || (kv[covKey(market, tf)] = {});
  mergeCov(cov, sym, bars);
  if (market === 'krx' && tf === '1d') { try { extra = [...extra, ...(await jumpEvents(env, kv, sym, bars, src))]; } catch (_) {} }
  const stmts = [...candleStmts(env.DB, market, tf, sym, bars, src), kvSetStmt(env.DB, covKey(market, tf), cov), ...extra];
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
}

/** ETF NAV snapshots -> signals(kind 'etf_nav'). value = NAV, note = {c, tv, na} JSON. Research data only. */
export function navStmts(db, dayLabelT, navs) {
  const ins = db.prepare('INSERT OR REPLACE INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  return Object.entries(navs || {}).map(([code, n]) => ins.bind(code, dayLabelT, 'etf_nav', n.nav, JSON.stringify({ c: n.c, tv: n.tv, na: n.na })));
}

const failKey = (src, sym) => `fail:${src}:${sym}`;
function inBackoff(kv, src, sym, now) { return (kv[failKey(src, sym)] || 0) > now; }

// ---------------- crypto ----------------
export async function cryptoCandlesTask(env, kv, now, tf, { perTick = 4, fetcher = fetch } = {}) {
  const universe = cryptoUniverse(kv);
  const target = tf === '1d' ? latestFinalCryptoDay(now) : latestFinalHour(now);
  const step = tf === '1d' ? DAY : HOUR;
  const cov = kv[covKey('crypto', tf)] || {};
  const stale = universe.filter((s) => (!cov[s] || cov[s].max < target) && !inBackoff(kv, 'upbit', s, now))
    .sort((a, b) => (cov[a]?.max || 0) - (cov[b]?.max || 0));
  const src = `upbit:${tf}`;
  let did = 0;
  for (const sym of stale.slice(0, perTick)) {
    try {
      const need = cov[sym] ? Math.ceil((target - cov[sym].max) / step) + 1 : 200;
      const bars = finalOnly(await fetchUpbitCandles(fetcher, sym, tf, { count: Math.min(200, need + 1) }), tf, now);
      await store(env, kv, 'crypto', tf, sym, bars, 'upbit');
      did++;
    } catch (e) {
      await healthErr(env.DB, src, e);
      kv[failKey('upbit', sym)] = now + 30 * 60;
      await env.DB.batch([kvSetStmt(env.DB, failKey('upbit', sym), kv[failKey('upbit', sym)])]);
    }
  }
  if (did) await healthOk(env.DB, src);
  // readiness: BTC present and >=80% of the universe updated, or 3h grace for stragglers.
  const c2 = kv[covKey('crypto', tf)] || {};
  const upd = universe.filter((s) => c2[s]?.max >= target).length;
  const graceOver = now > target + step + 3 * HOUR;
  const readyKey = `ready:crypto:${tf}`;
  if ((c2['KRW-BTC']?.max >= target) && (upd >= Math.ceil(universe.length * 0.8) || graceOver) && (kv[readyKey] || 0) < target) {
    kv[readyKey] = target;
    await env.DB.batch([kvSetStmt(env.DB, readyKey, target)]);
  }
  return did > 0;
}

export async function cryptoBackfillTask(env, kv, now, tf, { perTick = 2, fetcher = fetch } = {}) {
  const universe = cryptoUniverse(kv);
  const days = tf === '1d' ? Number(env.CRYPTO_BACKFILL_DAYS || 1100) : RETENTION.hourlyDays;
  const floor = now - days * DAY;
  const cov = kv[covKey('crypto', tf)] || {};
  const todo = universe.filter((s) => cov[s] && cov[s].min > floor && !kv[`bf:crypto:${tf}:${s}`]);
  let did = 0;
  for (const sym of todo.slice(0, perTick)) {
    try {
      const bars = await fetchUpbitCandles(fetcher, sym, tf, { count: 200, toSec: cov[sym].min + (tf === '1d' ? 9 * HOUR : 0) });
      const older = bars.filter((b) => b.t < cov[sym].min && b.t >= floor);
      const extra = older.length < 5 ? [kvSetStmt(env.DB, `bf:crypto:${tf}:${sym}`, 1)] : [];
      if (extra.length) kv[`bf:crypto:${tf}:${sym}`] = 1;
      await store(env, kv, 'crypto', tf, sym, older, 'upbit', extra);
      did++;
    } catch (e) { await healthErr(env.DB, `upbit:${tf}`, e); break; }
  }
  return did > 0;
}

export async function cryptoUniverseTask(env, kv, now, { fetcher = fetch } = {}) {
  if ((kv['crypto:universe:at'] || 0) > now - 7 * DAY) return false;
  try {
    const top = await fetchUpbitTop(fetcher, 10);
    const u = [...new Set(['KRW-BTC', 'KRW-ETH', ...top])].slice(0, CRYPTO_MAX);
    kv['crypto:universe'] = u; kv['crypto:universe:at'] = now;
    await env.DB.batch([kvSetStmt(env.DB, 'crypto:universe', u), kvSetStmt(env.DB, 'crypto:universe:at', now)]);
    await healthOk(env.DB, 'upbit:universe');
  } catch (e) {
    kv['crypto:universe:at'] = now - 7 * DAY + 6 * HOUR; // retry in 6h
    await env.DB.batch([kvSetStmt(env.DB, 'crypto:universe:at', kv['crypto:universe:at'])]);
    await healthErr(env.DB, 'upbit:universe', e);
  }
  return true;
}

export async function pruneHourlyTask(env, kv, now) {
  if ((kv['prune:at'] || 0) > now - DAY) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM candles WHERE market = 'crypto' AND tf = '1h' AND t < ?").bind(now - (RETENTION.hourlyDays + 5) * DAY),
    env.DB.prepare("DELETE FROM equity WHERE run_id LIKE '%:paper' AND t < ? AND run_id IN (SELECT id FROM runs WHERE strategy_id LIKE '%1h%')").bind(now - 400 * DAY),
    env.DB.prepare('DELETE FROM owner_sessions WHERE expires_at < ?').bind(now),
    kvSetStmt(env.DB, 'prune:at', now),
  ]);
  kv['prune:at'] = now;
  return true;
}

// ---------------- KRX ----------------
const allowNaver = (env) => String(env.ALLOW_UNOFFICIAL_NAVER ?? 'true') !== 'false';

/**
 * Daily KRX update. Strategy:
 *  1) Official KRX Open API (if KRX_AUTH_KEY): one request per day for all ETFs (+ stocks if the key is approved for it).
 *  2) Symbols still missing -> 공공데이터포털 (DATA_GO_KR_KEY) or Naver public chart (fallback), per symbol.
 *  ready:krx:1d advances only when every symbol has been checked for the target day.
 */
export async function krxDailyTask(env, kv, now, { perTick = 6, fetcher = fetch } = {}) {
  const target = latestFinalKrxDay(now);
  const codes = krxCodes();
  const core = coreKrxCodes();
  const cur = kv['krx:cur'] || {};
  const officialCovers = (c) => env.KRX_AUTH_KEY && (krxMeta[c].etf || !(kv['krx:stock:off'] > now));
  const fallbackDue = (c) => (cur[c] || 0) < target && !inBackoff(kv, 'krxfb', c, now) && (!officialCovers(c) || now > kstAt(target + DAY, 15));
  // 기존 종목이 다 모였으면 끝. 단, 후보용 새 ETF가 아직 대체 수집 차례면 그것만 계속(실패 종목은 30분 쉼)
  if ((kv['ready:krx:1d'] || 0) >= target && !codes.some((c) => !core.includes(c) && fallbackDue(c))) return false;
  const cov = kv['cov:krx:1d'] || {};
  let did = false;
  const extraStmts = [];

  if (env.KRX_AUTH_KEY) {
    const minCur = Math.min(...core.map((c) => cur[c] || 0)); // 후보 종목이 늦어도 공식 API 날짜는 기존 종목 기준
    const D = minCur ? nextKrxBusinessDay(minCur) : target;
    const tryKey = `krx:try:${D}`;
    if (D <= target && (kv[tryKey] || 0) < now - 50 * 60) {
      kv[tryKey] = now; extraStmts.push(kvSetStmt(env.DB, tryKey, now));
      for (const kind of ['etf', 'stock']) {
        if (kind === 'stock' && kv['krx:stock:off'] > now) continue;
        const want = codes.filter((c) => (kind === 'etf') === !!krxMeta[c].etf && (cur[c] || 0) < D);
        if (!want.length) continue;
        try {
          const { bars, navs, empty } = await fetchKrxDay(fetcher, env.KRX_AUTH_KEY, kind, D, want, kind === 'etf' ? ETF_NAV_UNIVERSE : null);
          did = true;
          if (empty) {
            // Not yet published (T+1 morning) or a closure the calendar missed. After D+1 15:00 KST treat as no session.
            if (now > kstAt(D + DAY, 15)) for (const c of want) cur[c] = Math.max(cur[c] || 0, D);
            continue;
          }
          for (const [c, b] of Object.entries(bars)) { await store(env, kv, 'krx', '1d', c, [b], 'krx'); cur[c] = Math.max(cur[c] || 0, D); }
          if (kind === 'etf') {
            extraStmts.push(...navStmts(env.DB, D, navs));
            if (Object.keys(navs || {}).length && !kv['nav:first']) { kv['nav:first'] = D; extraStmts.push(kvSetStmt(env.DB, 'nav:first', D)); }
          }
          // a symbol absent from a non-empty official day (trading halt) is considered checked
          for (const c of want) cur[c] = Math.max(cur[c] || 0, D);
          await healthOk(env.DB, `krx:${kind}`);
        } catch (e) {
          await healthErr(env.DB, `krx:${kind}`, e);
          if (kind === 'stock' && String(e.message) === 'KRX_AUTH') { kv['krx:stock:off'] = now + 7 * DAY; extraStmts.push(kvSetStmt(env.DB, 'krx:stock:off', kv['krx:stock:off'])); }
        }
      }
    }
  }

  // Per-symbol fallbacks for anything the official path did not cover (or no key).
  const fallback = codes.filter(fallbackDue);
  for (const c of fallback.slice(0, perTick)) {
    try {
      let bars;
      let src;
      if (env.DATA_GO_KR_KEY) {
        src = 'datagokr';
        bars = await fetchDataGoKrHistory(fetcher, env.DATA_GO_KR_KEY, c, krxMeta[c].etf, Math.max((cov[c]?.max || target - 40 * DAY) - 5 * DAY, target - 60 * DAY), target);
      } else if (allowNaver(env)) {
        src = 'naver';
        const count = cov[c] ? Math.min(60, Math.ceil((target - cov[c].max) / DAY) + 3) : 400;
        bars = await fetchNaverDaily(fetcher, c, count);
      } else break;
      bars = bars.filter((b) => b.t <= target);
      await store(env, kv, 'krx', '1d', c, bars, src);
      cur[c] = target;
      did = true;
      await healthOk(env.DB, srcFor(src, c));
    } catch (e) {
      await healthErr(env.DB, srcFor(env.DATA_GO_KR_KEY ? 'datagokr' : 'naver', c), e);
      kv[failKey('krxfb', c)] = now + 30 * 60;
      extraStmts.push(kvSetStmt(env.DB, failKey('krxfb', c), kv[failKey('krxfb', c)]));
    }
  }
  kv['krx:cur'] = cur;
  extraStmts.push(kvSetStmt(env.DB, 'krx:cur', cur));
  const allChecked = core.every((c) => (cur[c] || 0) >= target); // 후보 종목 수집 실패가 기존 장부를 멈추지 않게
  if (allChecked) { kv['ready:krx:1d'] = target; extraStmts.push(kvSetStmt(env.DB, 'ready:krx:1d', target)); }
  await env.DB.batch(extraStmts);
  return did;
}

/**
 * ETF NAV history backfill from the official KRX API (one request = all ETFs for one day), walking backwards
 * from the first collected day to KRX_NAV_BACKFILL_YEARS (default 5). A few days per tick; stops on auth errors.
 * Empty days (holidays the calendar missed) are simply skipped — NAV is never forward-filled.
 */
export async function krxNavBackfillTask(env, kv, now, { perTick = 3, fetcher = fetch } = {}) {
  if (!env.KRX_AUTH_KEY || kv['navbf:done'] || (kv['navbf:off'] || 0) > now) return false;
  const start = kv['navbf:cur'] || kv['nav:first'];
  if (!start) return false; // wait until the daily collector has produced the first NAV day
  const floor = now - Number(env.KRX_NAV_BACKFILL_YEARS || 5) * 365 * DAY;
  let D = start;
  const stmts = [];
  let did = false;
  for (let i = 0; i < perTick; i++) {
    D = prevKrxBusinessDay(D);
    if (D < floor) { kv['navbf:done'] = 1; stmts.push(kvSetStmt(env.DB, 'navbf:done', 1)); break; }
    try {
      const { navs } = await fetchKrxDay(fetcher, env.KRX_AUTH_KEY, 'etf', D, [], ETF_NAV_UNIVERSE);
      stmts.push(...navStmts(env.DB, D, navs));
      did = true;
    } catch (e) {
      await healthErr(env.DB, 'krx:navbf', e);
      const wait = String(e.message) === 'KRX_AUTH' ? 7 * DAY : HOUR;
      kv['navbf:off'] = now + wait; stmts.push(kvSetStmt(env.DB, 'navbf:off', kv['navbf:off']));
      D = nextKrxBusinessDay(D); // retry this day later
      break;
    }
  }
  if (D !== start) { kv['navbf:cur'] = D; stmts.push(kvSetStmt(env.DB, 'navbf:cur', D)); }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return did;
}

/** One-time deep history per symbol (naver count=N or data.go.kr), when the deploy seed did not provide it. */
export async function krxBackfillTask(env, kv, now, { perTick = 1, fetcher = fetch } = {}) {
  const years = Number(env.KRX_BACKFILL_YEARS || 5);
  const floor = now - years * 365 * DAY;
  const cov = kv['cov:krx:1d'] || {};
  // 실패한 종목은 6시간 쉼 → 한 종목이 계속 실패해도 뒤 종목(후보 ETF)이 굶지 않게
  const todo = krxCodes().filter((c) => (!cov[c] || cov[c].min > floor + 30 * DAY) && !kv[`bf:krx:${c}`] && !inBackoff(kv, 'krxbf', c, now));
  if (!todo.length) return false;
  if (!allowNaver(env) && !env.DATA_GO_KR_KEY) return false;
  let did = false;
  for (const c of todo.slice(0, perTick)) {
    try {
      const bars = env.DATA_GO_KR_KEY
        ? await fetchDataGoKrHistory(fetcher, env.DATA_GO_KR_KEY, c, krxMeta[c].etf, floor, latestFinalKrxDay(now))
        : (await fetchNaverDaily(fetcher, c, Math.ceil(years * 250))).filter((b) => b.t <= latestFinalKrxDay(now));
      kv[`bf:krx:${c}`] = 1;
      await store(env, kv, 'krx', '1d', c, bars, env.DATA_GO_KR_KEY ? 'datagokr' : 'naver', [kvSetStmt(env.DB, `bf:krx:${c}`, 1)]);
      did = true;
    } catch (e) {
      await healthErr(env.DB, srcFor('krx:backfill', c), e);
      kv[failKey('krxbf', c)] = now + 6 * HOUR;
      await env.DB.batch([kvSetStmt(env.DB, failKey('krxbf', c), kv[failKey('krxbf', c)])]);
      break;
    }
  }
  return did;
}
