// KRX daily candle sources (read-only market data; no brokerage access).
//  1) krx   : KRX 정보데이터시스템 Open API (official). Secret KRX_AUTH_KEY (same binding name as the old worker).
//             One request returns ALL listed ETFs (or KOSPI stocks) for one day.
//  2) datagokr : 공공데이터포털 금융위원회 주식/증권상품 시세 (official, T+1). Secret DATA_GO_KR_KEY.
//  3) naver : 네이버 금융 공개 차트 (unofficial, no key). Per-symbol history; used as fallback / backfill.
import { dayT, ymdCompact } from '../core/calendar.js';

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

function validBar(b) {
  return [b.t, b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) && b.c > 0 && b.o > 0 && b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9;
}

// ---------- KRX Open API ----------
export const KRX_ENDPOINTS = {
  etf: 'https://data-dbg.krx.co.kr/svc/apis/etp/etf_bydd_trd',
  stock: 'https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd',
};

/**
 * Pick the wanted codes from a KRX day document (all ETFs or all KOSPI stocks for one day).
 * A single JSON.parse + Set lookup measured fastest in V8 (~1 ms for ~300 KB; see scripts/cpu-bench.mjs).
 * Returns {bars:{code:bar}, empty:boolean}.
 */
export function extractKrxRows(text, codes, dayLabelT) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('KRX_INVALID_JSON'); }
  const rc = doc?.respCode;
  if (rc != null && !['0', '000', '200'].includes(String(rc))) throw new Error(String(rc) === '401' || String(rc) === '403' ? 'KRX_AUTH' : `KRX_APP_${rc}`);
  const items = doc?.OutBlock_1;
  if (!Array.isArray(items)) throw new Error('KRX_FORMAT');
  if (!items.length) return { bars: {}, empty: true };
  const want = new Set(codes);
  const day = ymdCompact(dayLabelT);
  const bars = {};
  for (const row of items) {
    let code = String(row.ISU_SRT_CD || row.ISU_CD || '');
    if (code.length === 12 && code.startsWith('KR')) code = code.slice(3, 9);
    if (!want.has(code) || String(row.BAS_DD) !== day) continue;
    const b = { t: dayLabelT, o: num(row.TDD_OPNPRC), h: num(row.TDD_HGPRC), l: num(row.TDD_LWPRC), c: num(row.TDD_CLSPRC), v: num(row.ACC_TRDVOL) };
    if (validBar(b)) bars[code] = b; // halted symbols report 0 open -> skipped
  }
  return { bars, empty: false };
}

export async function fetchKrxDay(fetcher, key, kind, dayLabelT, codes) {
  if (!key) throw new Error('KRX_NO_KEY');
  const res = await fetcher(`${KRX_ENDPOINTS[kind]}?basDd=${ymdCompact(dayLabelT)}`, { headers: { AUTH_KEY: key, Accept: 'application/json' }, redirect: 'manual' });
  if (res.status === 401 || res.status === 403) throw new Error('KRX_AUTH');
  if (res.status === 429) throw new Error('KRX_RATE_LIMIT');
  if (!res.ok) throw new Error(`KRX_HTTP_${res.status}`);
  return extractKrxRows(await res.text(), codes, dayLabelT);
}

// ---------- 공공데이터포털 ----------
export const DATAGOKR = {
  stock: 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo',
  etf: 'https://apis.data.go.kr/1160100/service/GetSecuritiesProductInfoService/getETFPriceInfo',
};
export function parseDataGoKr(doc) {
  const header = doc?.response?.header;
  if (header && header.resultCode !== '00') throw new Error(`DATAGOKR_${header.resultCode}`);
  let items = doc?.response?.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items];
  return items.map((r) => ({ code: String(r.srtnCd), bar: { t: dayT(String(r.basDt)), o: num(r.mkp), h: num(r.hipr), l: num(r.lopr), c: num(r.clpr), v: num(r.trqu) } }))
    .filter((x) => validBar(x.bar));
}
export async function fetchDataGoKrHistory(fetcher, key, code, isEtf, fromT, toT) {
  if (!key) throw new Error('DATAGOKR_NO_KEY');
  const u = new URL(isEtf ? DATAGOKR.etf : DATAGOKR.stock);
  u.searchParams.set('serviceKey', key);
  u.searchParams.set('resultType', 'json');
  u.searchParams.set('likeSrtnCd', code);
  u.searchParams.set('beginBasDt', ymdCompact(fromT));
  u.searchParams.set('endBasDt', ymdCompact(toT));
  u.searchParams.set('numOfRows', '1000');
  const res = await fetcher(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`DATAGOKR_HTTP_${res.status}`);
  return parseDataGoKr(await res.json()).filter((x) => x.code === code).map((x) => x.bar).sort((a, b) => a.t - b.t);
}

// ---------- Naver public chart (unofficial) ----------
export function parseNaverChart(xml) {
  const out = [];
  const re = /data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)"/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = { t: dayT(m[1]), o: +m[2], h: +m[3], l: +m[4], c: +m[5], v: +m[6] };
    if (validBar(b)) out.push(b);
  }
  return out.sort((a, b) => a.t - b.t);
}
export async function fetchNaverDaily(fetcher, code, count = 30) {
  const res = await fetcher(`https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${count}&requestType=0`);
  if (!res.ok) throw new Error(`NAVER_HTTP_${res.status}`);
  const bars = parseNaverChart(await res.text());
  if (!bars.length) throw new Error('NAVER_EMPTY');
  return bars;
}
