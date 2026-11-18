// Non-price data feeds as plugins with one common item schema:
//   { source, t (epoch s), sym ('*' = market-wide), type, payload (object), fetched_at }
// Health is tracked per source in data_health ('feed:<id>'). All feeds are optional and cheap.
import { DAY, HOUR } from '../core/calendar.js';

const decodeXml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

export function parseRssTitles(xml, max = 15) {
  const out = [];
  const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && out.length < max) {
    const t = Date.parse(m[2] || '') / 1000;
    out.push({ title: decodeXml(m[1]).slice(0, 200), t: Number.isFinite(t) ? Math.floor(t) : null });
  }
  return out;
}

// ---- 세계 지표(2026-11-18 밤) ----
export const MACRO_SERIES = [
  { id: 'vix', y: '^VIX', ko: '미국 변동성 지수(VIX)', en: 'VIX', unit: '' },
  { id: 'us10y', y: '^TNX', ko: '미국 10년 국채 금리', en: 'US 10y yield', unit: '%' },
  { id: 'dxy', y: 'DX-Y.NYB', ko: '달러 지수', en: 'US dollar index', unit: '' },
  { id: 'usdkrw', y: 'KRW=X', ko: '원/달러 환율', en: 'USD/KRW', unit: '원' },
  { id: 'spx', y: '^GSPC', ko: 'S&P500', en: 'S&P 500', unit: '' },
  { id: 'ndx', y: '^IXIC', ko: '나스닥', en: 'Nasdaq Composite', unit: '' },
  { id: 'gold', y: 'GC=F', ko: '금', en: 'Gold', unit: '달러' },
  { id: 'oil', y: 'CL=F', ko: '유가(WTI)', en: 'WTI crude oil', unit: '달러' },
];
/** Yahoo chart JSON → [{t, c}] (빈 값 제거). 형식이 다르면 빈 배열. */
export function parseYahooChart(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(cl)) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(cl[i]) && cl[i] > 0) out.push({ t: ts[i], c: cl[i] });
  return out;
}
/** 최신 값 + 약 한 달(20거래일) 변화 → 공통 항목. 금리·변동성 지수는 포인트 차이, 나머지는 % 변화. */
export function macroItem(m, bars) {
  if (!bars || bars.length < 2) return null;
  const last = bars[bars.length - 1], ref = bars[Math.max(0, bars.length - 21)];
  const isLevel = m.id === 'us10y' || m.id === 'vix';
  const chg = isLevel ? last.c - ref.c : last.c / ref.c - 1;
  const chgKo = isLevel ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}${m.id === 'us10y' ? '%p' : ''}` : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(1)}%`;
  const val = last.c >= 1000 ? Math.round(last.c).toLocaleString('ko-KR') : last.c.toFixed(2);
  const valEn = last.c >= 1000 ? Math.round(last.c).toLocaleString('en-US') : last.c.toFixed(2);
  return { sym: '*world', t: Math.floor(last.t / DAY) * DAY, type: 'macro', payload: { id: m.id, title: `${m.ko} ${val}${m.unit} (한 달 ${chgKo})`, en: `${m.en} ${valEn}${m.unit === '%' ? '%' : ''} (1-month change ${chgKo.replace('%p', ' pts')})`, value: Math.round(last.c * 10000) / 10000, chg: Math.round(chg * 10000) / 10000 } };
}

export const FEEDS = [
  {
    id: 'news_kr', name: '뉴스 제목(언론사 RSS + 구글 뉴스, 한국어)', every: 6 * HOUR, needs: null,
    // Google News blocks Cloudflare egress (503), so publisher RSS feeds are the main source; each source is optional
    // and the feed only fails when ALL of them fail. Only the newest part of each feed is parsed (CPU budget).
    sources: [
      ['*krx', 'https://www.yna.co.kr/rss/economy.xml'],
      ['*krx', 'https://www.hankyung.com/feed/finance'],
      ['*crypto', 'https://www.blockmedia.co.kr/feed'],
      ['*crypto', 'https://www.tokenpost.kr/rss'],
    ],
    queries: [['*crypto', '비트코인 OR 이더리움'], ['*krx', '코스피 OR 증시'], ['379800', 'S&P500 미국증시']],
    async fetch(fetcher, env, now) {
      const items = [], errors = [];
      const take = (sym, xml, n) => { for (const it of parseRssTitles(String(xml).slice(0, 60000), n)) if (!it.t || it.t > now - 2 * DAY) items.push({ sym, t: it.t || now, type: 'headline', payload: { title: it.title } }); };
      for (const [sym, url] of this.sources) {
        try { const res = await fetcher(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; family-invest-paper/2; read-only headlines)' } }); if (!res.ok) throw new Error(String(res.status)); take(sym, await res.text(), 12); }
        catch (e) { errors.push(`${url.split('/')[2]}:${String(e?.message || e).slice(0, 20)}`); }
      }
      for (const [sym, q] of this.queries) {
        try { const res = await fetcher(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`); if (!res.ok) throw new Error(String(res.status)); take(sym, await res.text(), 10); }
        catch (e) { errors.push(`google:${String(e?.message || e).slice(0, 20)}`); }
      }
      if (errors.length === this.sources.length + this.queries.length) throw new Error(`NEWS_ALL_FAILED ${errors.join(',')}`.slice(0, 120));
      return items;
    },
  },
  {
    id: 'fear_greed', name: '코인 공포·탐욕 지수(alternative.me)', every: 12 * HOUR, needs: null,
    async fetch(fetcher) {
      const res = await fetcher('https://api.alternative.me/fng/?limit=1&format=json');
      if (!res.ok) throw new Error(`FNG_HTTP_${res.status}`);
      const d = (await res.json())?.data?.[0];
      if (!d) throw new Error('FNG_EMPTY');
      return [{ sym: '*crypto', t: Number(d.timestamp), type: 'sentiment', payload: { value: Number(d.value), label: d.value_classification } }];
    },
  },
  {
    // 세계 지표(무료·키 없음). 실시간일 필요 없음: 하루 2번. 출처마다 따로 실패를 허용하고, 전부 실패할 때만 오류로 기록.
    // Yahoo 차트(비공식)는 막힐 수 있어 환율은 Frankfurter(ECB 기준, 공개)로 한 번 더 받는다. AI 프롬프트의 '세계 지표' 줄로만 쓰인다(매매 규칙에 직접 쓰지 않음).
    id: 'macro', name: '세계 지표(미국 금리·변동성 지수·달러·환율·S&P500·나스닥·금·유가)', every: 12 * HOUR, needs: null,
    series: MACRO_SERIES,
    async fetch(fetcher, env, now) {
      const items = [], errors = [];
      for (const m of this.series) {
        try {
          const res = await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.y)}?range=3mo&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; family-invest-paper/2; read-only daily macro)' } });
          if (!res.ok) throw new Error(String(res.status));
          const it = macroItem(m, parseYahooChart(await res.json()));
          if (!it) throw new Error('EMPTY');
          items.push(it);
        } catch (e) { errors.push(`${m.id}:${String(e?.message || e).slice(0, 12)}`); }
      }
      if (!items.some((i) => i.payload.id === 'usdkrw')) {
        try {
          const res = await fetcher('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW');
          if (!res.ok) throw new Error(String(res.status));
          const j = await res.json();
          const v = Number(j?.rates?.KRW), t = Date.parse(`${j?.date}T00:00:00Z`) / 1000;
          if (v > 0) items.push({ sym: '*world', t: Number.isFinite(t) ? t : now, type: 'macro', payload: { id: 'usdkrw', title: `원/달러 환율 ${Math.round(v).toLocaleString('ko-KR')}원`, en: `USD/KRW ${v.toFixed(0)}`, value: v } });
        } catch (e) { errors.push(`fx:${String(e?.message || e).slice(0, 12)}`); }
      }
      if (!items.length) throw new Error(`MACRO_ALL_FAILED ${errors.join(',')}`.slice(0, 120));
      return items;
    },
  },
  {
    // 코인 시장 전체·온체인(무료·키 없음): 코인게코 전체 시가총액·비트코인 점유율, blockchain.info 활성 주소 수.
    id: 'crypto_global', name: '코인 시장 전체·온체인(시가총액·비트코인 점유율·활성 주소)', every: 12 * HOUR, needs: null,
    async fetch(fetcher, env, now) {
      const items = [], errors = [];
      const day = Math.floor(now / DAY) * DAY;
      try {
        const res = await fetcher('https://api.coingecko.com/api/v3/global', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json())?.data;
        const cap = Number(d?.total_market_cap?.usd), dom = Number(d?.market_cap_percentage?.btc), chg = Number(d?.market_cap_change_percentage_24h_usd);
        if (!(cap > 0)) throw new Error('EMPTY');
        items.push({ sym: '*crypto', t: day, type: 'onchain', payload: { id: 'cg_global', title: `코인 전체 시가총액 ${(cap / 1e12).toFixed(2)}조 달러 (24시간 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%), 비트코인 점유율 ${dom.toFixed(1)}%`, en: `Total crypto market cap $${(cap / 1e12).toFixed(2)}T (24h ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%), BTC dominance ${dom.toFixed(1)}%`, value: cap, dominance: dom } });
      } catch (e) { errors.push(`coingecko:${String(e?.message || e).slice(0, 12)}`); }
      try {
        const res = await fetcher('https://api.blockchain.info/charts/n-unique-addresses?timespan=40days&format=json');
        if (!res.ok) throw new Error(String(res.status));
        const v = ((await res.json())?.values || []).filter((x) => x.y > 0);
        if (v.length < 8) throw new Error('EMPTY');
        const avg = (a) => a.reduce((x, y) => x + y.y, 0) / a.length;
        const last7 = avg(v.slice(-7)), prev = avg(v.slice(0, Math.max(1, v.length - 7)));
        const chg = prev > 0 ? last7 / prev - 1 : 0;
        items.push({ sym: 'KRW-BTC', t: day, type: 'onchain', payload: { id: 'btc_active_addr', title: `비트코인 하루 활성 주소 ${Math.round(last7 / 1000)}천 개(7일 평균, 이전 한 달 대비 ${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(0)}%)`, en: `Bitcoin daily active addresses ${Math.round(last7 / 1000)}k (7d avg, ${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(0)}% vs prior month)`, value: last7, chg } });
      } catch (e) { errors.push(`blockchain:${String(e?.message || e).slice(0, 12)}`); }
      if (!items.length) throw new Error(`CRYPTO_GLOBAL_FAILED ${errors.join(',')}`.slice(0, 120));
      return items;
    },
  },
  // Upbit 유의·경고 종목 moved to data/market-signals.js (group 'upbit_flags', every 30 min, used as a risk guard).
  {
    id: 'dart', name: 'DART 공시(전자공시, 키 필요)', every: 12 * HOUR, needs: 'DART_API_KEY',
    async fetch(fetcher, env, now) {
      const d = new Date((now + 9 * HOUR) * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      const res = await fetcher(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${encodeURIComponent(env.DART_API_KEY)}&bgn_de=${d}&end_de=${d}&page_count=50&corp_cls=Y`);
      if (!res.ok) throw new Error(`DART_HTTP_${res.status}`);
      const j = await res.json();
      if (j.status && j.status !== '000' && j.status !== '013') throw new Error(`DART_${j.status}`);
      return (j.list || []).slice(0, 50).map((x) => ({ sym: x.stock_code || '*krx', t: now, type: 'disclosure', payload: { corp: x.corp_name, title: String(x.report_nm).slice(0, 150) } }));
    },
  },
];
