// Trading cost models. All amounts in KRW.
// KRX: 위탁수수료 0.015% (온라인 기준, 증권사마다 다름) 양방향,
//      매도 시 증권거래세+농특세 (2026년 코스피 합계 0.20% 가정; 2024년 0.18%),
//      국내 ETF 매도세는 출처마다 설명이 달라 설정값(sellTaxEtf, 기본 0 = 면제 가정)으로 둠.
//      슬리피지는 시가 대비 불리한 방향으로 가정. 수수료(commission)는 증권사(KIS 등)에 맞게 조정.
// Upbit: KRW 마켓 수수료 0.05% 양방향, 최소 주문 5,000원.

export const DEFAULT_COSTS = {
  krx: {
    commission: 0.00015,
    sellTaxStock: 0.0020,
    sellTaxEtf: 0,
    slippage: 0.0005,
    integerQty: true,
    tickRound: 'krx',
    minOrderKrw: 1,
  },
  crypto: {
    commission: 0.0005,
    sellTaxStock: 0,
    sellTaxEtf: 0,
    slippage: 0.0012,
    integerQty: false,
    tickRound: 'upbit',
    minOrderKrw: 5000,
    qtyDecimals: 8,
  },
};

/** KRX 호가단위 (2023-01 개편 기준, 주식). ETF/ETN 은 5원 단위. */
export function krxTick(price, isEtf) {
  if (isEtf) return 5;
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

// Upbit KRW 마켓 호가단위 (공개 문서 기준 사실 정보; upbit-strategy-toolkit market_rules.json 과 동일 값).
const UPBIT_KRW_TICKS = [[1000000, 1000], [500000, 500], [100000, 100], [50000, 50], [10000, 10], [5000, 5], [100, 1],
  [10, 0.1], [1, 0.01], [0.1, 0.001], [0.01, 0.0001], [0.001, 0.00001], [0.0001, 0.000001], [0.00001, 0.0000001], [0, 0.00000001]];
export function upbitTick(price) {
  for (const [min, tick] of UPBIT_KRW_TICKS) if (price >= min) return tick;
  return 0.00000001;
}

/** Fill price after slippage, rounded to a valid tick against the trader. */
export function fillPrice(side, refPrice, cost, meta = {}) {
  const raw = side === 'BUY' ? refPrice * (1 + cost.slippage) : refPrice * (1 - cost.slippage);
  if (!cost.tickRound) return raw;
  const tick = cost.tickRound === 'upbit' ? upbitTick(raw) : krxTick(raw, !!meta.etf);
  const p = side === 'BUY' ? Math.ceil(raw / tick - 1e-9) * tick : Math.floor(raw / tick + 1e-9) * tick;
  return Math.max(Number(p.toPrecision(12)), tick);
}

export function roundQty(qty, cost) {
  if (qty <= 0) return 0;
  if (cost.integerQty) return Math.floor(qty + 1e-9);
  const f = 10 ** (cost.qtyDecimals ?? 8);
  return Math.floor(qty * f) / f;
}

/** Fee and tax for a fill. Commission rounded to won; tax truncated (won). */
export function feesFor(side, gross, cost, meta = {}) {
  const fee = Math.round(gross * cost.commission);
  let tax = 0;
  if (side === 'SELL') tax = Math.floor(gross * (meta.etf ? cost.sellTaxEtf : cost.sellTaxStock));
  return { fee, tax };
}

/** Max quantity purchasable with `cash` at `price` including commission. */
export function affordableQty(cash, price, cost) {
  if (price <= 0 || cash <= 0) return 0;
  return roundQty(cash / (price * (1 + cost.commission)), cost);
}

export function mergeCosts(market, overrides = {}) {
  return { ...DEFAULT_COSTS[market], ...(overrides[market] || {}) };
}

/** Cost stress (research G1: costs x2). */
export function stressCosts(cost, k = 2) {
  return { ...cost, commission: cost.commission * k, slippage: cost.slippage * k, sellTaxStock: cost.sellTaxStock, sellTaxEtf: cost.sellTaxEtf };
}
