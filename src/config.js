// Universe and global defaults. Edit here (or override via the CONFIG_JSON var).

export const KRX_ETFS = {
  '069500': 'KODEX 200',
  '102110': 'TIGER 200',
  '278530': 'KODEX 200TR',
  '379800': 'KODEX 미국S&P500TR',
  '153130': 'KODEX 단기채권',
};

/**
 * Cash substitutes (parking places for idle money). Overlay books (AI 판단 / 뉴스 거부권) must not
 * shrink or block moves INTO these: that would turn the A/B twin into "less bond, more raw cash"
 * instead of "fewer risky buys". Effective from the 2026-11-20 bar so already stored paper fills
 * (bars before it) still replay 1:1 under the old rule.
 */
export const CASH_LIKE = new Set(['153130']);
export const CASH_LIKE_EXEMPT_FROM = Date.UTC(2026, 10, 20) / 1000; // 2026-11-20 bar label (UTC midnight)
export const cashLikeExempt = (sym, t) => CASH_LIKE.has(sym) && t >= CASH_LIKE_EXEMPT_FROM;

export const KRX_STOCKS = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '373220': 'LG에너지솔루션',
  '207940': '삼성바이오로직스',
  '005380': '현대차',
  '000270': '기아',
  '068270': '셀트리온',
  '105560': 'KB금융',
  '055550': '신한지주',
  '035420': 'NAVER',
  '005490': 'POSCO홀딩스',
  '012330': '현대모비스',
  '028260': '삼성물산',
  '006400': '삼성SDI',
  '051910': 'LG화학',
  '086790': '하나금융지주',
  '012450': '한화에어로스페이스',
  '034020': '두산에너빌리티',
  '032830': '삼성생명',
  '015760': '한국전력',
};

// ETF 괴리율(NAV) 연구용 수집 대상: 국내 주식형 1배 20종 + 위 ETF. 가격 봉은 수집하지 않고 NAV·종가만 signals(kind 'etf_nav')에 저장.
// 근거: 류호영·김은총(2024) ETF 가격괴리 연구 — 종가 괴리는 T+2 안에 대체로 소멸. t일 NAV 신호 → t+1 시가 체결만 허용.
export const ETF_NAV_UNIVERSE = [...new Set([
  '069500', '069660', '105190', '148020', '152100', '229200', '091160', '091230', '091170', '117700',
  '102780', '161510', '210780', '211900', '104530', '279540', '251590', '227570', '100910', '278540',
  ...Object.keys(KRX_ETFS),
])];

export const KRX_ALL = { ...KRX_ETFS, ...KRX_STOCKS };
export const krxMeta = Object.fromEntries(Object.keys(KRX_ALL).map((s) => [s, { etf: s in KRX_ETFS, name: KRX_ALL[s] }]));

// Core long-lived Upbit KRW markets. The live collector adds the current top-volume
// markets (up to CRYPTO_MAX) on top of BTC/ETH; stablecoins and 유의종목 are excluded.
export const CRYPTO_CORE = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA', 'KRW-TRX', 'KRW-LINK', 'KRW-BCH', 'KRW-XLM'];
export const CRYPTO_NAMES = {
  'KRW-BTC': '비트코인', 'KRW-ETH': '이더리움', 'KRW-XRP': '리플', 'KRW-SOL': '솔라나', 'KRW-DOGE': '도지코인',
  'KRW-ADA': '에이다', 'KRW-TRX': '트론', 'KRW-LINK': '체인링크', 'KRW-BCH': '비트코인캐시', 'KRW-XLM': '스텔라루멘',
};
export const CRYPTO_MAX = 12;
export const CRYPTO_HOURLY = ['KRW-BTC', 'KRW-ETH'];
export const STABLECOINS = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-USDS', 'KRW-DAI', 'KRW-USD1']);

export const INITIAL_CASH = 10_000_000;

export const RETENTION = { hourlyDays: 120 };

export function symName(sym) {
  return KRX_ALL[sym] || CRYPTO_NAMES[sym] || sym.replace(/^KRW-/, '');
}
