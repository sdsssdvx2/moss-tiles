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
