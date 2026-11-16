// Upbit PUBLIC quotation REST (no API key, no private endpoints, no orders).
import { dayT, DAY, HOUR } from '../core/calendar.js';
import { STABLECOINS } from '../config.js';

export const UPBIT_BASE = 'https://api.upbit.com/v1';

async function getJson(fetcher, url) {
  const res = await fetcher(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) throw new Error('UPBIT_RATE_LIMIT');
  if (res.status === 418) throw new Error('UPBIT_BANNED_418'); // temporary IP ban: the collector backs off
  if (!res.ok) throw new Error(`UPBIT_HTTP_${res.status}`);
  return res.json();
}

export function parseUpbitCandles(rows, tf) {
  if (!Array.isArray(rows)) throw new Error('UPBIT_FORMAT');
  const out = [];
  for (const r of rows) {
    const utc = String(r.candle_date_time_utc || '');
    const t = tf === '1d' ? dayT(utc.slice(0, 10)) : Math.floor(Date.parse(utc + 'Z') / 1000);
    const b = { t, o: +r.opening_price, h: +r.high_price, l: +r.low_price, c: +r.trade_price, v: +r.candle_acc_trade_volume };
    if (![b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) || b.c <= 0) continue;
    out.push(b);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Up to 200 candles ending before `toSec` (exclusive). */
export async function fetchUpbitCandles(fetcher, market, tf, { count = 200, toSec } = {}) {
  const path = tf === '1d' ? 'candles/days' : 'candles/minutes/60';
  const u = new URL(`${UPBIT_BASE}/${path}`);
  u.searchParams.set('market', market);
  u.searchParams.set('count', String(Math.min(200, Math.max(1, count))));
  if (toSec) u.searchParams.set('to', new Date(toSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  return parseUpbitCandles(await getJson(fetcher, u.toString()), tf);
}

/** Only completed candles: drop the in-progress bar. */
export function finalOnly(bars, tf, nowSec) {
  const cut = tf === '1d' ? Math.floor(nowSec / DAY) * DAY : Math.floor(nowSec / HOUR) * HOUR;
  return bars.filter((b) => b.t < cut);
}

/** Top KRW markets by 24h traded value, excluding stablecoins and 투자유의/경고 종목. */
export async function fetchUpbitTop(fetcher, n = 10) {
  const [markets, tickers] = await Promise.all([
    getJson(fetcher, `${UPBIT_BASE}/market/all?is_details=true`),
    getJson(fetcher, `${UPBIT_BASE}/ticker/all?quote_currencies=KRW`),
  ]);
  // fail-closed: a market without market_event is treated as flagged; no market_event at all -> keep old universe
  if (Array.isArray(markets) && markets.length && !markets.some((m) => m.market_event)) throw new Error('UPBIT_NO_MARKET_EVENT');
  const bad = new Set(markets.filter((m) => !m.market_event || m.market_event.warning || m.market_warning === 'CAUTION').map((m) => m.market));
  return tickers
    .filter((t) => String(t.market).startsWith('KRW-') && !STABLECOINS.has(t.market) && !bad.has(t.market))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, n)
    .map((t) => t.market);
}
