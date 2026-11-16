// 코인 시장 신호 (RISK SIGNALS ONLY — they can only block or shrink NEW buys; they never open a trade).
// Rules follow CRYPTO-SOURCES-KO.md (top 5). All thresholds are provisional and configurable
// (MARKET_SIGNALS_JSON); calibrate them from the paper logs.
//
// Primary public endpoints, verified reachable from a US/cloud IP on 2026-11-16 (re-check from the
// Worker egress with the owner-only GET /probe route):
//   Upbit    api.upbit.com/v1/market/all?is_details=true   market_event warning + 5 caution flags (~250 KB)
//            api.upbit.com/v1/ticker                        KRW-BTC, KRW-USDT
//   Upbit 공지 t.me/s/upbit_news (Upbit's official Telegram channel, public web preview; the notice board
//            API api-manager.upbit.com answers a bot challenge and is NOT used)
//   Bithumb  api.bithumb.com/v1/ticker, /v1/market/virtual_asset_warning, /public/assetsstatus/ALL
//   Binance  data-api.binance.vision (official public market-data mirror; the main Binance spot/futures API
//            hosts answer 451 from US IPs), www.binance.com CMS catalog 161 (상장폐지 공지)
//   Coinbase api.exchange.coinbase.com/products/BTC-USD/ticker
//   OKX      www.okx.com/api/v5 public market data (spot ticker, funding, OI history, long/short, liquidations)
//   Hyperliquid api.hyperliquid.xyz/info metaAndAssetCtxs (funding hourly, OI) — shadow log only
//   FX       open.er-api.com/v6/latest/USD (display of the FX-based 김프 / 테더 김프 only; cached 6 h)
// Not used (bot protection / no free API): CNN Fear & Greed (418 to scripts), theddari.com, Coinglass.
import { HOUR, DAY } from '../core/calendar.js';

const MIN = 60;

export const MKT_DEFAULTS = {
  enabled: true,           // fetch + show signals
  guard: true,             // per-coin gates (업비트 경보, 공지, 입출금, 상장폐지)
  dampener: true,          // market-wide size rules (김프, 가격 괴리, 테더 김프, 코인베이스 프리미엄)
  premHalf: 0.03,          // USDT 기준 김프 > +3% → 새 매수 절반
  premHold: 0.05,          //                 > +5% → 새 매수 보류
  premWarnLow: -0.02,      //                 < -2% (역프) → 경고만
  priceDevMax: 0.02,       // 해외 기준가끼리 또는 업비트↔빗썸 BTC 차이 > 2% → 데이터 이상, 새 매수 보류
  tetherMax: 0.04,         // 테더 김프(환율 기준) > 4% → 절반
  coinbaseMin: -0.003,     // 코인베이스 프리미엄 < -0.3% → 절반
  halfFactor: 0.5,
  derivRules: false,       // 펀딩·OI·청산: 처음 90일은 기록만 (true로 바꾸면 아래 기준으로 절반)
  fundingMax: 0.0005, liqLongShareMax: 0.8, liqMinUsd: 5e6,
  flagsStaleHours: 3,      // 업비트 경보 데이터가 이보다 오래되면 알트 새 매수 보류
  staleHours: 3,           // 프리미엄 데이터가 이보다 오래되면 시장 규칙 미적용(경고만)
  suspendHours: 48,        // 입출금 중단 공지 → 48시간 새 매수 보류
  listingDays: 14,         // 신규 거래지원 → 14일간 새 매수 제외(추격 금지)
  delistDays: 14,
  fxEveryHours: 6,
};
export function mktConfig(env) {
  let o = {};
  try { o = env?.MARKET_SIGNALS_JSON ? JSON.parse(env.MARKET_SIGNALS_JSON) : {}; } catch { o = {}; }
  const c = { ...MKT_DEFAULTS, ...o };
  if (String(env?.MARKET_SIGNALS_ENABLED ?? 'true') === 'false') c.enabled = false;
  return c;
}

export const MAJORS = new Set(['KRW-BTC', 'KRW-ETH']);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const UA = 'family-invest-paper/2 (read-only market data; paper trading)';
async function getRes(fetcher, url, tag, init) {
  const opts = { ...(init || {}), headers: { Accept: 'application/json', 'User-Agent': UA, ...((init && init.headers) || {}) } };
  let res = await fetcher(url, opts);
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 1200)); res = await fetcher(url, opts); } // waiting costs no CPU
  if (res.status === 429) throw new Error(`${tag}_RATE_LIMIT`);
  if (res.status === 418) throw new Error(`${tag}_BANNED_418`);
  if (!res.ok) throw new Error(`${tag}_HTTP_${res.status}`);
  return res;
}
const getJson = async (f, url, tag, init) => (await getRes(f, url, tag, init)).json();
const median = (xs) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

export const CAUTION_KO = {
  PRICE_FLUCTUATIONS: '가격 급등락', TRADING_VOLUME_SOARING: '거래량 급증', DEPOSIT_AMOUNT_SOARING: '입금량 급증',
  GLOBAL_PRICE_DIFFERENCES: '해외와 가격 차이 큼', CONCENTRATION_OF_SMALL_ACCOUNTS: '소수 계정 거래 집중',
};
const CAUTION_BLOCK = new Set(['TRADING_VOLUME_SOARING', 'CONCENTRATION_OF_SMALL_ACCOUNTS']);
const CAUTION_HALF = new Set(['DEPOSIT_AMOUNT_SOARING', 'GLOBAL_PRICE_DIFFERENCES']);

/**
 * Upbit market/all?is_details=true -> compact {krw:[all KRW codes], flags:[{sym,name,warning,caution,missing}]}.
 * A KRW market WITHOUT market_event is reported as missing (fail-closed), never as "clean".
 */
export function parseUpbitFlags(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('UPBIT_FLAGS_FORMAT');
  const krw = [], flags = [];
  let withEvent = 0;
  for (const m of rows) {
    if (!String(m.market).startsWith('KRW-')) continue;
    krw.push(m.market);
    const ev = m.market_event;
    if (!ev || typeof ev !== 'object') { flags.push({ sym: m.market, name: m.korean_name || '', warning: false, caution: [], missing: true }); continue; }
    withEvent++;
    const caution = Object.keys(ev.caution || {}).filter((k) => ev.caution[k]);
    if (ev.warning || caution.length) flags.push({ sym: m.market, name: m.korean_name || '', warning: !!ev.warning, caution });
  }
  if (!withEvent) throw new Error('UPBIT_NO_MARKET_EVENT'); // e.g. the is_details parameter was dropped
  return { krw, flags: flags.slice(0, 120) };
}

/** Upbit official Telegram web preview -> last messages {id, t, title, url}. Only scans message text blocks. */
export function parseTelegramPreview(html, channel = 'upbit_news', max = 20) {
  if (typeof html !== 'string') throw new Error('TG_FORMAT');
  const out = [];
  const marker = `data-post="${channel}/`;
  let i = html.indexOf(marker);
  while (i >= 0) {
    const next = html.indexOf(marker, i + marker.length);
    const chunk = html.slice(i, next < 0 ? undefined : next);
    const id = Number(chunk.slice(marker.length, chunk.indexOf('"', marker.length)));
    const tm = chunk.match(/<time datetime="([^"]+)"/);
    const tx = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (Number.isFinite(id) && tx) {
      const text = tx[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      const t = tm ? Math.floor(Date.parse(tm[1]) / 1000) : null;
      out.push({ id, t: Number.isFinite(t) ? t : null, title: text.split('\n')[0].slice(0, 200), url: `https://t.me/${channel}/${id}` });
    }
    i = next;
  }
  return out.slice(-max);
}

/** Classify one Upbit notice title -> {rule, coins} | null. rule: close | suspend | listing */
export function classifyNotice(title) {
  const s = String(title || '');
  const coins = [...s.matchAll(/\(([A-Z0-9]{2,12})\)/g)].map((m) => m[1]);
  if (!coins.length) return null;
  if (/거래지원 종료|유의 촉구|유의 종목 지정|투자유의/.test(s) && !/해제/.test(s)) return { rule: 'close', coins };
  if (/(입출금|입금|출금).*중단/.test(s) && !/\(완료\)|재개/.test(s)) return { rule: 'suspend', coins };
  if (/신규 거래지원/.test(s)) return { rule: 'listing', coins };
  return null;
}

/** Bithumb assetsstatus -> {COIN: {dep, wd}} for coins whose deposit OR withdrawal is suspended. */
export function parseBithumbWallet(j) {
  if (j?.status !== '0000' || typeof j.data !== 'object') throw new Error('BITHUMB_WALLET_FORMAT');
  const out = {};
  for (const [c, v] of Object.entries(j.data)) {
    const dep = Number(v.deposit_status) === 1, wd = Number(v.withdrawal_status) === 1;
    if (!dep || !wd) out[c] = { dep, wd };
  }
  return out;
}
/** Bithumb virtual_asset_warning -> [{sym, type, step, end}] (end = epoch s; end_date is KST). */
export function parseBithumbWarnings(rows) {
  if (!Array.isArray(rows)) throw new Error('BITHUMB_WARN_FORMAT');
  return rows.filter((r) => String(r.market).startsWith('KRW-')).map((r) => {
    const end = Date.parse(String(r.end_date || '').replace(' ', 'T') + '+09:00') / 1000;
    return { sym: r.market, type: String(r.warning_type || ''), step: String(r.warning_step || ''), end: Number.isFinite(end) ? end : null };
  }).slice(0, 100);
}

/** Binance CMS "Delisting" catalog -> recent spot delist notices with coin tickers. */
export function parseBinanceDelist(j, now, days = 14) {
  const arts = j?.data?.catalogs?.[0]?.articles;
  if (!Array.isArray(arts)) throw new Error('BINANCE_CMS_FORMAT');
  const out = [];
  for (const a of arts) {
    const t = Math.floor(Number(a.releaseDate) / 1000);
    if (!Number.isFinite(t) || t < now - days * DAY) continue;
    const title = String(a.title || '');
    const m = title.match(/Will Delist (.+?)(?: on | \(|$)/i);
    if (!m || /futures|margin|alpha|options|convert|earn/i.test(title)) continue;
    const coins = m[1].split(/,|\band\b|&/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,12}$/.test(x));
    if (coins.length) out.push({ t, title: title.slice(0, 160), coins });
  }
  return out;
}

export function parseOkxFunding(j) { const r = num(j?.data?.[0]?.fundingRate); if (r == null) throw new Error('OKX_FUNDING_FORMAT'); return r; }
/** OKX open-interest-history (period 1H, limit 25): rows newest first [ts, oi, oiCcy, oiUsd]. */
export function parseOkxOiHist(j) {
  const d = j?.data;
  if (!Array.isArray(d) || !d.length) throw new Error('OKX_OI_FORMAT');
  const now = num(d[0][3]), then = num(d[d.length - 1][3]);
  return { usd: now, chg24h: now && then ? now / then - 1 : null };
}
export function parseOkxLs(j) { const r = num(j?.data?.[0]?.[1]); if (r == null) throw new Error('OKX_LS_FORMAT'); return r; }
/** OKX liquidation-orders (latest ≤100 fills) -> {usd, longUsd, n, hours}. ctVal = coins per contract. */
export function parseOkxLiq(j, ctVal) {
  const det = j?.data?.[0]?.details;
  if (!Array.isArray(det)) throw new Error('OKX_LIQ_FORMAT');
  let usd = 0, longUsd = 0, tMin = Infinity, tMax = -Infinity;
  for (const x of det) {
    const v = Number(x.sz) * ctVal * Number(x.bkPx);
    if (!Number.isFinite(v)) continue;
    usd += v; if (x.posSide === 'long') longUsd += v;
    const t = Number(x.ts); if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }
  return { usd, longUsd, n: det.length, hours: det.length > 1 ? (tMax - tMin) / 3.6e6 : 0 };
}
/** Hyperliquid metaAndAssetCtxs -> {BTC:{funding1h, funding8h, oiUsd}, ETH:{…}} */
export function parseHyperliquid(j) {
  const uni = j?.[0]?.universe, ctx = j?.[1];
  if (!Array.isArray(uni) || !Array.isArray(ctx)) throw new Error('HL_FORMAT');
  const out = {};
  uni.forEach((u, i) => {
    if (u.name !== 'BTC' && u.name !== 'ETH') return;
    const c = ctx[i] || {};
    const f = num(c.funding), oi = num(c.openInterest), px = num(c.markPx);
    out[u.name] = { funding1h: f, funding8h: f == null ? null : f * 8, oiUsd: oi != null && px != null ? oi * px : null };
  });
  return out;
}
function tickerPx(rows, market) { const r = Array.isArray(rows) ? rows.find((x) => x.market === market) : null; return num(r?.trade_price); }

/** Pure: premiums and price-consistency checks from raw prices. */
export function premiums({ upbitBtc, upbitUsdt, bithumbBtc, bithumbUsdt, binanceBtc, okxBtc, coinbaseBtc, hlBtc, fx }) {
  const foreign = [binanceBtc, okxBtc, coinbaseBtc, hlBtc].filter((x) => x > 0);
  const usdBtc = median([binanceBtc, okxBtc, coinbaseBtc, hlBtc]);
  const usdtBase = median([binanceBtc, okxBtc, hlBtc]); // stablecoin-quoted venues (Hyperliquid = USDC)
  return {
    usdBtc, foreignN: foreign.length,
    premUsdt: upbitBtc && usdtBase && upbitUsdt ? upbitBtc / (usdtBase * upbitUsdt) - 1 : null, // research rule 3 (no FX needed)
    kimchi: upbitBtc && usdBtc && fx ? upbitBtc / (usdBtc * fx) - 1 : null,                      // display (FX-based)
    tether: upbitUsdt && fx ? upbitUsdt / fx - 1 : null,
    tetherBithumb: bithumbUsdt && fx ? bithumbUsdt / fx - 1 : null,
    coinbase: coinbaseBtc && usdtBase ? coinbaseBtc / usdtBase - 1 : null,
    foreignDev: foreign.length >= 2 ? Math.max(...foreign) / Math.min(...foreign) - 1 : null,
    krDev: upbitBtc && bithumbBtc ? Math.abs(upbitBtc / bithumbBtc - 1) : null,
  };
}

const settle = async (o) => {
  const keys = Object.keys(o);
  const rs = await Promise.allSettled(keys.map((k) => o[k]()));
  const val = {}, errors = [];
  rs.forEach((r, i) => { if (r.status === 'fulfilled') val[keys[i]] = r.value; else { val[keys[i]] = null; errors.push(`${keys[i]}:${String(r.reason?.message || r.reason).slice(0, 40)}`); } });
  if (errors.length === keys.length) throw new Error(errors.join(' ').slice(0, 120));
  return { val, errors };
};

const OKX = 'https://www.okx.com/api/v5';
const CT_VAL = { BTC: 0.01, ETH: 0.1 };

// Groups: at most 2 due groups are fetched per cron tick (see jobs/market-signals.js).
export const MKT_GROUPS = [
  {
    id: 'upbit_flags', name: '업비트 시장경보(유의·주의)', every: 60 * MIN,
    async fetch(fetcher) { return parseUpbitFlags(await getJson(fetcher, 'https://api.upbit.com/v1/market/all?is_details=true', 'UPBIT')); },
  },
  {
    id: 'notices', name: '업비트 공지(공식 텔레그램)·빗썸 경보·입출금·바이낸스 상장폐지', every: 60 * MIN,
    async fetch(fetcher, env, now, prev, cfg) {
      const { val, errors } = await settle({
        upbit: async () => parseTelegramPreview(await (await getRes(fetcher, 'https://t.me/s/upbit_news', 'TG', { headers: { Accept: 'text/html' } })).text()),
        bwarn: async () => parseBithumbWarnings(await getJson(fetcher, 'https://api.bithumb.com/v1/market/virtual_asset_warning', 'BITHUMB')),
        wallet: async () => parseBithumbWallet(await getJson(fetcher, 'https://api.bithumb.com/public/assetsstatus/ALL', 'BITHUMB')),
        delist: async () => parseBinanceDelist(await getJson(fetcher, 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=10', 'BINANCE_CMS'), now, cfg?.delistDays || 14),
      });
      // Upbit notices: keep a rolling, de-duplicated list (the preview shows ~20 recent posts)
      const got = (val.upbit || []).map((n) => ({ ...n, ...(classifyNotice(n.title) || { rule: null, coins: [] }) }));
      const seen = new Set(got.map((n) => n.id));
      const keepFrom = now - Math.max(cfg?.listingDays || 14, 15) * DAY;
      const upbitNotices = [...got, ...(prev?.upbitNotices || []).filter((n) => !seen.has(n.id))].filter((n) => !n.t || n.t >= keepFrom).sort((a, b) => b.id - a.id).slice(0, 60);
      return {
        upbitNotices, upbitOk: got.length > 0, upbitAt: got.length ? now : prev?.upbitAt || null,
        bithumbWarnings: val.bwarn ?? prev?.bithumbWarnings ?? [],
        wallet: val.wallet ?? prev?.wallet ?? {}, delist: val.delist ?? prev?.delist ?? [], errors,
      };
    },
  },
  {
    id: 'premium', name: '김프(USDT 기준)·거래소 가격 대조·테더 김프·코인베이스 프리미엄', every: 30 * MIN,
    async fetch(fetcher, env, now, prev, cfg) {
      const needFx = !prev?.fx || (prev.fxAt || 0) < now - (cfg?.fxEveryHours || 6) * HOUR;
      const { val, errors } = await settle({
        upbit: () => getJson(fetcher, 'https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-USDT', 'UPBIT'),
        bithumb: () => getJson(fetcher, 'https://api.bithumb.com/v1/ticker?markets=KRW-USDT,KRW-BTC', 'BITHUMB'),
        binance: async () => num((await getJson(fetcher, 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT', 'BINANCE')).price),
        okx: async () => num((await getJson(fetcher, `${OKX}/market/ticker?instId=BTC-USDT`, 'OKX')).data?.[0]?.last),
        coinbase: async () => num((await getJson(fetcher, 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', 'COINBASE')).price),
        hl: async () => num((await getJson(fetcher, 'https://api.hyperliquid.xyz/info', 'HL', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"allMids"}' }))?.BTC),
        ...(needFx ? { fx: async () => num((await getJson(fetcher, 'https://open.er-api.com/v6/latest/USD', 'FX')).rates?.KRW) } : {}),
      });
      const fx = needFx ? (val.fx || prev?.fx || null) : prev.fx;
      const fxAt = needFx ? (val.fx ? now : prev?.fxAt || null) : prev.fxAt;
      const px = {
        upbitBtc: tickerPx(val.upbit, 'KRW-BTC'), upbitUsdt: tickerPx(val.upbit, 'KRW-USDT'),
        bithumbBtc: tickerPx(val.bithumb, 'KRW-BTC'), bithumbUsdt: tickerPx(val.bithumb, 'KRW-USDT'),
        binanceBtc: val.binance, okxBtc: val.okx, coinbaseBtc: val.coinbase, hlBtc: val.hl, fx,
      };
      return { ...px, fxAt, ...premiums(px), errors };
    },
  },
  {
    id: 'derivs', name: '선물 지표 기록: 펀딩비·미결제약정·롱숏·강제청산 (OKX·Hyperliquid)', every: 6 * HOUR,
    async fetch(fetcher) {
      const jobs = {
        hl: async () => parseHyperliquid(await getJson(fetcher, 'https://api.hyperliquid.xyz/info', 'HL', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: '{"type":"metaAndAssetCtxs"}' })),
      };
      for (const c of ['BTC', 'ETH']) {
        jobs[`f${c}`] = async () => parseOkxFunding(await getJson(fetcher, `${OKX}/public/funding-rate?instId=${c}-USDT-SWAP`, 'OKX'));
        jobs[`oi${c}`] = async () => parseOkxOiHist(await getJson(fetcher, `${OKX}/rubik/stat/contracts/open-interest-history?instId=${c}-USDT-SWAP&period=1H&limit=25`, 'OKX'));
        jobs[`ls${c}`] = async () => parseOkxLs(await getJson(fetcher, `${OKX}/rubik/stat/contracts/long-short-account-ratio-contract?instId=${c}-USDT-SWAP&period=1H&limit=1`, 'OKX'));
        jobs[`liq${c}`] = async () => parseOkxLiq(await getJson(fetcher, `${OKX}/public/liquidation-orders?instType=SWAP&uly=${c}-USDT&state=filled&limit=100`, 'OKX'), CT_VAL[c]);
      }
      const { val, errors } = await settle(jobs);
      const oiUsd = (val.oiBTC?.usd || 0) + (val.oiETH?.usd || 0);
      const prevOi = (x) => (x?.usd && x.chg24h != null ? x.usd / (1 + x.chg24h) : 0);
      const oiPrev = prevOi(val.oiBTC) + prevOi(val.oiETH);
      const liqs = [val.liqBTC, val.liqETH].filter(Boolean);
      const liqUsd = liqs.reduce((a, x) => a + x.usd, 0), liqLong = liqs.reduce((a, x) => a + x.longUsd, 0);
      return {
        funding: { BTC: val.fBTC, ETH: val.fETH }, hl: val.hl || null,
        oi: { BTC: val.oiBTC, ETH: val.oiETH, totalUsd: oiUsd || null, chg24h: oiUsd && oiPrev ? oiUsd / oiPrev - 1 : null },
        ls: { BTC: val.lsBTC, ETH: val.lsETH },
        liq: liqs.length ? { usd: liqUsd, longShare: liqUsd > 0 ? liqLong / liqUsd : null, n: liqs.reduce((a, x) => a + x.n, 0), hours: Math.max(...liqs.map((x) => x.hours)) } : null,
        errors,
      };
    },
  },
];

const fresh = (snap, now, h) => !!snap && snap.at >= now - h * HOUR;
const p1 = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const LEVEL = { half: 1, block: 2, close: 3 };

/**
 * Pure: combine the latest group snapshots into the risk guard.
 *   coins[sym] = {level: 'close'|'block'|'half', why}   (why is number-free so the change detector does not churn)
 *     close = 신규 금지 + 청산 전용(공격형 슬롯은 정리), block = 신규 금지, half = 신규 절반
 *   altHold   = reason | null   (alts only: no new buys; BTC·ETH unaffected)
 *   damp      = {factor (0 = hold), reason, triggers} | null   (all crypto)
 *   frozen    = [sym]           (relevant coins that disappeared from Upbit's market list → human alert)
 *   warnings  = [text]          (shown only, no effect)
 */
export function computeGuard(snaps, cfg, now, relevant) {
  const coins = {}, warnings = [];
  const add = (sym, level, why) => {
    if (relevant && !relevant.has(sym)) return;
    const c = coins[sym];
    if (!c) { coins[sym] = { level, why }; return; }
    if (!c.why.includes(why)) c.why = `${c.why}, ${why}`;
    if (LEVEL[level] > LEVEL[c.level]) c.level = level;
  };
  let altHold = null, frozen = [];
  if (cfg.guard) {
    const uf = snaps.upbit_flags;
    if (!fresh(uf, now, cfg.flagsStaleHours)) altHold = '업비트 경보 데이터 없음·오래됨';
    for (const f of uf?.flags || []) {
      if (f.missing) { add(f.sym, 'block', '경보 정보 없음(안전하게 제외)'); continue; }
      if (f.warning) add(f.sym, 'close', '업비트 투자유의');
      const blk = f.caution.filter((k) => CAUTION_BLOCK.has(k)), half = f.caution.filter((k) => CAUTION_HALF.has(k)), other = f.caution.filter((k) => !CAUTION_BLOCK.has(k) && !CAUTION_HALF.has(k));
      if (blk.length) add(f.sym, 'block', `업비트 주의(${blk.map((k) => CAUTION_KO[k]).join('·')})`);
      if (half.length) {
        const why = `업비트 주의(${half.map((k) => CAUTION_KO[k]).join('·')})`;
        if (MAJORS.has(f.sym)) warnings.push(`${f.sym} ${why} — 비트·이더는 경고만`); else add(f.sym, 'half', why);
      }
      if (other.length) warnings.push(`${f.sym} 업비트 주의(${other.map((k) => CAUTION_KO[k] || k).join('·')})`);
    }
    if (uf?.krw?.length && relevant) frozen = [...relevant].filter((s) => !uf.krw.includes(s));
    for (const s of frozen) add(s, 'block', '업비트 마켓 목록에서 사라짐(동결)');
    const nt = snaps.notices;
    if (!nt?.upbitOk && !altHold) altHold = '업비트 공지 데이터 없음';
    for (const n of nt?.upbitNotices || []) {
      if (!n.rule || !n.t) continue;
      for (const c of n.coins) {
        if (n.rule === 'close') add(`KRW-${c}`, 'close', n.title.includes('거래지원 종료') ? '업비트 거래지원 종료 공지' : '업비트 유의 공지');
        if (n.rule === 'suspend' && now - n.t < cfg.suspendHours * HOUR) add(`KRW-${c}`, 'block', `업비트 입출금 중단 공지(${cfg.suspendHours}시간)`);
        if (n.rule === 'listing' && now - n.t < cfg.listingDays * DAY) add(`KRW-${c}`, 'block', `신규 상장 ${cfg.listingDays}일 추격 금지`);
      }
    }
    for (const w of nt?.bithumbWarnings || []) if ((w.step === 'WARNING' || w.step === 'DANGER') && (!w.end || w.end > now)) add(w.sym, 'block', '빗썸 경보(경고·위험)');
    for (const [c, w] of Object.entries(nt?.wallet || {})) add(`KRW-${c}`, 'block', `${!w.dep && !w.wd ? '입출금' : !w.dep ? '입금' : '출금'} 중단(빗썸 기준)`);
    for (const d of nt?.delist || []) for (const c of d.coins) add(`KRW-${c}`, 'block', '바이낸스 상장폐지 공지');
  }
  let damp = null;
  if (cfg.dampener) {
    const tr = [], why = [];
    let factor = 1;
    const set = (f, id, text) => { factor = Math.min(factor, f); tr.push(id); why.push(text); };
    const pr = fresh(snaps.premium, now, cfg.staleHours) ? snaps.premium : null;
    if (!pr) warnings.push('김프·가격 대조 데이터 없음·오래됨 → 시장 규칙 미적용');
    if (pr?.foreignDev != null && pr.foreignDev > cfg.priceDevMax) set(0, 'priceDev', '해외 거래소끼리 가격 차이 이상');
    if (pr?.krDev != null && pr.krDev > cfg.priceDevMax) set(0, 'krDev', '업비트·빗썸 가격 차이 이상');
    if (pr?.premUsdt != null) {
      if (pr.premUsdt > cfg.premHold) set(0, 'premHold', `김프(USDT 기준) ${p1(pr.premUsdt)}`);
      else if (pr.premUsdt > cfg.premHalf) set(cfg.halfFactor, 'premHalf', `김프(USDT 기준) ${p1(pr.premUsdt)}`);
      else if (pr.premUsdt < cfg.premWarnLow) warnings.push(`역프리미엄 ${p1(pr.premUsdt)} (경고만)`);
    }
    if (pr?.tether != null && pr.tether > cfg.tetherMax) set(cfg.halfFactor, 'tether', `테더 김프 ${p1(pr.tether)}`);
    if (pr?.coinbase != null && pr.coinbase < cfg.coinbaseMin) set(cfg.halfFactor, 'coinbase', `코인베이스 프리미엄 ${(pr.coinbase * 100).toFixed(2)}%`);
    const dv = cfg.derivRules && fresh(snaps.derivs, now, 12) ? snaps.derivs : null; // shadow log unless enabled
    if (dv) {
      const fmax = Math.max(dv.funding?.BTC ?? -1, dv.funding?.ETH ?? -1);
      if (fmax > cfg.fundingMax) set(cfg.halfFactor, 'funding', `펀딩비 ${(fmax * 100).toFixed(3)}%`);
      if (dv.liq && dv.liq.usd >= cfg.liqMinUsd && dv.liq.longShare >= cfg.liqLongShareMax) set(cfg.halfFactor, 'liq', `강제청산 롱 ${Math.round(dv.liq.longShare * 100)}%`);
    }
    if (tr.length) damp = { factor, reason: why.join(', '), triggers: tr };
  }
  return { coins, altHold, damp, frozen, warnings };
}
export function guardKey(g) {
  return JSON.stringify([Object.entries(g.coins).map(([s, c]) => [s, c.level, c.why]).sort(), g.altHold, g.damp ? [g.damp.factor, g.damp.triggers] : null]);
}

/** Owner-only reachability probe targets (GET /probe). [label, url, POST body?] */
export const PROBE_TARGETS = [
  ['업비트 시장경보', 'https://api.upbit.com/v1/market/all?is_details=true'],
  ['업비트 시세', 'https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-USDT'],
  ['업비트 공지(텔레그램)', 'https://t.me/s/upbit_news'],
  ['빗썸 시세', 'https://api.bithumb.com/v1/ticker?markets=KRW-USDT,KRW-BTC'],
  ['빗썸 경보', 'https://api.bithumb.com/v1/market/virtual_asset_warning'],
  ['빗썸 입출금', 'https://api.bithumb.com/public/assetsstatus/ALL'],
  ['바이낸스 시세(미러, 막혀도 무방)', 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT'],
  ['바이낸스 상장폐지 공지(막혀도 무방)', 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=1'],
  ['코인베이스', 'https://api.exchange.coinbase.com/products/BTC-USD/ticker'],
  ['OKX 시세', `${OKX}/market/ticker?instId=BTC-USDT`],
  ['OKX 펀딩비', `${OKX}/public/funding-rate?instId=BTC-USDT-SWAP`],
  ['Hyperliquid', 'https://api.hyperliquid.xyz/info', '{"type":"metaAndAssetCtxs"}'],
  ['Hyperliquid BTC 가격', 'https://api.hyperliquid.xyz/info', '{"type":"allMids"}'],
  ['환율', 'https://open.er-api.com/v6/latest/USD'],
  ['공포·탐욕', 'https://api.alternative.me/fng/?limit=1&format=json'],
];
