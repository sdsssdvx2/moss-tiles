// Universe and global defaults. Edit here (or override via the CONFIG_JSON var).

export const KRX_ETFS = {
  '069500': 'KODEX 200',
  '102110': 'TIGER 200',
  '278530': 'KODEX 200TR',
  '379800': 'KODEX 미국S&P500TR',
  '153130': 'KODEX 단기채권',
};

/**
 * 사전 등록 후보(backtest/CANDIDATES-PREREG.md, 2026-11-23 고정)가 쓸 새 ETF. 공개 날짜 전에 자료만 미리 쌓는다.
 * 기존 장부는 이 종목을 쓰지 않고, 수집 진행 조건(ready:krx:1d)에도 넣지 않는다(collect.js coreKrxCodes) —
 * 새 종목 수집이 실패해도 기존 장부가 멈추지 않게.
 */
export const CANDIDATE_ETFS = {
  '174350': 'TIGER 로우볼',
  '161510': 'PLUS 고배당주',
  '279530': 'KODEX 고배당주',
  '148070': 'KIWOOM 국고채10년',
  '132030': 'KODEX 골드선물(H)',
  '251350': 'KODEX MSCI선진국',
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

/**
 * 2026-11-18 평가 정직화 묶음(세금·새 규칙)이 모의 장부에 적용되는 첫 봉(UTC 자정 = KST 날짜 라벨).
 * 이 봉 이전에 이미 저장된 모의 체결은 옛 규칙 그대로 재생되어 1:1 일치가 유지된다.
 * 백테스트(과거 검증)는 처음부터 새 규칙을 쓴다. → 2026-11-24(화) 08:00 KST 전에 배포해야 함.
 */
export const RULES_20261118_FROM = Date.UTC(2026, 10, 23) / 1000; // 2026-11-23 (월) 봉

/**
 * 매매차익 과세 ETF(국내 상장 '기타 ETF': 해외주식형·채권형). 매도 차익(비용 차감 후)에 배당소득세 15.4% 원천징수.
 * 정확한 과세표준은 min(매매차익, 과표기준가 증가분)이라 실제 세금은 이 근사보다 같거나 적다(보수적 근사).
 * 국내주식형 ETF(069500·102110·278530)는 매매차익 비과세, ETF 매도는 증권거래세 면제(분배금 15.4%는 TR이라 미반영).
 */
export const ETF_GAIN_TAXED = new Set(['379800', '153130', '148070', '132030', '251350']); // 뒤 셋: 후보용(채권·금 선물·해외주식형)

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

export const KRX_ALL = { ...KRX_ETFS, ...KRX_STOCKS, ...CANDIDATE_ETFS };
export const krxMeta = Object.fromEntries(Object.keys(KRX_ALL).map((s) => [s, { etf: s in KRX_ETFS || s in CANDIDATE_ETFS, name: KRX_ALL[s], gainTax: ETF_GAIN_TAXED.has(s) }]));

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
