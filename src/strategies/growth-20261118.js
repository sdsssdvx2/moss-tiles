// 공격 장부 후보 (2026-11-18 밤). 사용자 요구: "손해 최소만으로 수익이 너무 낮으면 실망. 변동성 큰 자산을 넣은 이유가 있다."
// → 안전 장부(1배 고정)는 그대로 두고, 낙폭 한도 안에서 크기(배수)를 시스템이 자동 조절하는 장부를 따로 굴린다. 가상 돈만.
// 두 장부 모두 규칙·숫자는 결과를 보기 전에 정했고(문헌의 흔한 값), 연구실 전체 시도 수에 포함된다.
// 실제 주문·선물 거래 기능은 이 저장소 어디에도 없다.
import { sma, highestPrior, lowestPrior, atr } from '../core/indicators.js';
import { createFutState, stepFutures } from '../core/futures-sim.js';
import { realizedVol } from './common.js';
import { cryptoTrendV1 } from './research-set.js';
import { btcPerpSimV1 } from './futures-sim.js';

/** 변동성 목표 배수: 목표 변동성 ÷ 최근 변동성을 [min, max] 안에서 step 단위로 내림. 변동성을 모르면 가장 낮은 배수. */
export function volTargetLeverage(vol, { target, min = 1, max = 3, step = 0.5 }) {
  if (!Number.isFinite(vol) || vol <= 0) return min;
  const raw = target / vol;
  return Math.max(min, Math.min(max, Math.floor(raw / step + 1e-9) * step));
}
/** 낙폭 조절: 고점 대비 손실이 soft 이상이면 배수를 절반(최소 min), hard 이상이면 0(쉼). */
export function drawdownGovernor(lev, dd, { soft, hard, min = 1 }) {
  if (dd >= hard) return 0;
  if (dd >= soft) return Math.max(min, lev / 2);
  return lev;
}

// ---- 공격 1) 비트·이더 현물 추세, 더 크게 (레버리지 없음: 현금 10%만 남기고 최대 90%까지) ----
// 안전 쪽 C와 같은 신호. 다른 점은 크기뿐: 목표 변동성 연 25% → 50%, 한 종목 60% → 90%, 현금 최소 40% → 10%.
// 소액(10만 원)에서도 그대로 돌아간다(선물 최소 주문 단위 문제가 없음). 낙폭 30%면 전부 팔고 멈춘다.
export const cryptoTrendGrowthV1 = {
  ...cryptoTrendV1,
  id: 'crypto_trend_growth_v1', family: 'crypto_trend_growth', version: 1, priorTrials: 0,
  growthCandidate: true, book: 'growth',
  name: '공격 장부: 비트·이더 추세 크게(현물, 최대 90%)',
  params: { ...cryptoTrendV1.params, volTarget: 0.50, cap: 0.9 }, grid: null,
  risk: { maxPositionWeight: 0.90, minCash: 0.10, dailyLossLimit: 0.04, weeklyLossLimit: 0.08, maxDrawdownHalt: 0.30 },
  description: '공격 장부(모의). 안전 쪽 C와 같은 신호(비트코인 200일 평균 위에서만 매수, 20일 최저가 이탈·2ATR 손절)인데 크기만 키움: 목표 변동성 연 50%, 현금은 10%만 남김. 빌린 돈(레버리지)은 쓰지 않음. 고점 대비 30% 잃으면 전부 팔고 멈춤.',
};

// ---- 공격 2) BTC 선물 추세 + 배수 자동 조절 (모의 전용·선물 시뮬레이션) ----
// 고정 2배 장부(btc_perp_sim_v1)와 같은 진입·청산 규칙. 다른 점: 들어갈 때마다 배수를 다시 정한다.
//   배수 = 목표 변동성(연 40%) ÷ (최근 20일 변동성 × 증거금 비율 50%) 를 1~3배 사이에서 0.5 단위로 내림
//   장부가 기준 고점 대비 15% 잃은 상태면 배수 절반, 25% 잃은 상태면 20일 동안 새로 들어가지 않고(쉼) 그때 금액을 새 기준으로 삼음
export const btcPerpVolTargetV1 = {
  id: 'btc_perp_voltarget_v1', family: 'btc_perp_voltarget', version: 1, cadence: 'slow', priorTrials: 0,
  researchOnly: true, simulationOnly: true, sleeve: null, book: 'growth', dynamicLeverage: true,
  name: '공격 장부: BTC 선물 추세 · 배수 자동 조절 1~3배 (모의 전용·선물 시뮬레이션)', market: 'crypto', timeframe: '1d',
  universe: ['KRW-BTC'], benchSym: 'KRW-BTC',
  params: { ...btcPerpSimV1.params, leverage: 3, volTarget: 0.40, volN: 20, minLev: 1, maxLev: 3, levStep: 0.5, ddSoft: 0.15, ddHard: 0.25, restBars: 20 }, grid: null,
  get lookback() { return 110; },
  risk: { maxDrawdownHalt: 0 },
  createState: createFutState, stepper: stepFutures,
  description: '공격 장부(모의 전용·선물 시뮬레이션, 실제 선물 거래 기능 없음). 비트코인이 100일 평균 위에서 20일 최고가를 넘으면 롱, 아래에서 20일 최저가를 깨면 숏. 들어갈 때마다 배수를 시스템이 다시 정함: 최근 변동성이 낮으면 최대 3배, 높으면 1배까지 낮춤(목표 변동성 연 40%). 장부가 고점 대비 15% 잃으면 배수 절반, 25% 잃으면 20일 쉼. 강제 청산·펀딩비 반영.',
  decideFutures(ctx) {
    const p = ctx.params;
    const bars = ctx.history('KRW-BTC', p.trendSma + 2);
    if (bars.length < p.trendSma) return null;
    const c = bars.map((b) => b.c), hi = bars.map((b) => b.h), lo = bars.map((b) => b.l);
    const last = c[c.length - 1], trend = sma(c, p.trendSma);
    const a = atr(bars.slice(-(p.atrN + 1)), p.atrN);
    const pos = ctx.position;
    // 장부 스스로 기준 고점을 기억한다(쉬고 돌아오면 그 시점부터 다시 잼 → 한 번 크게 잃었다고 영영 멈추지 않음)
    const mem = { ...(ctx.mem || {}) };
    const before = mem.peak;
    mem.peak = Math.max(mem.peak || 0, ctx.equity || 0);
    const keep = mem.peak !== before ? { mem } : null;
    if (pos) {
      if (pos.side > 0 && last < lowestPrior(lo, p.exit)) return { order: { action: 'close', reason: `롱 청산: 최근 ${p.exit}일 최저가 이탈` }, mem };
      if (pos.side < 0 && last > highestPrior(hi, p.exit)) return { order: { action: 'close', reason: `숏 청산: 최근 ${p.exit}일 최고가 돌파` }, mem };
      return keep;
    }
    const side = last > trend && last > highestPrior(hi, p.entry) ? 1 : last < trend && last < lowestPrior(lo, p.entry) ? -1 : 0;
    if (!side) return keep;
    if (mem.restUntil != null && ctx.barIndex < mem.restUntil) return keep; // 낙폭 한도로 쉬는 중
    const dd = mem.peak > 0 ? Math.max(0, 1 - ctx.equity / mem.peak) : 0;
    const vol = realizedVol(c, p.volN, 365);
    const base = volTargetLeverage(vol * p.size, { target: p.volTarget, min: p.minLev, max: p.maxLev, step: p.levStep });
    const lev = drawdownGovernor(base, dd, { soft: p.ddSoft, hard: p.ddHard, min: p.minLev });
    if (lev <= 0) { mem.restUntil = ctx.barIndex + p.restBars; mem.peak = ctx.equity; return { mem }; } // 쉬고, 돌아올 때는 지금 금액을 새 기준으로
    const volTxt = Number.isFinite(vol) ? `${Math.round(vol * 100)}%` : '모름';
    const why = `${side > 0 ? '롱' : '숏'} 진입(시뮬): 100일 평균 ${side > 0 ? '위' : '아래'} + ${p.entry}일 ${side > 0 ? '최고가 돌파' : '최저가 이탈'} · 배수 ${lev}배 (최근 변동성 연 ${volTxt}${lev < base ? `, 고점 대비 ${Math.round(dd * 100)}% 손실 중이라 절반` : ''})`;
    return { order: { action: 'open', side, size: p.size, lev, stopDist: p.stopAtr * a, reason: why }, mem };
  },
};

export const GROWTH_20261118 = [cryptoTrendGrowthV1, btcPerpVolTargetV1];
