// 모의 전용(선물 시뮬레이션): BTC 무기한 선물 흉내 — 업비트 현물 일봉으로 계산, 최대 2배, 격리 증거금.
import { sma, highestPrior, lowestPrior, atr } from '../core/indicators.js';
import { createFutState, stepFutures } from '../core/futures-sim.js';

export const btcPerpSimV1 = {
  id: 'btc_perp_sim_v1', family: 'btc_perp_sim', version: 1, cadence: 'slow', priorTrials: 0,
  researchOnly: true, simulationOnly: true, sleeve: 'aggressive',
  name: '공격형: BTC 선물 추세 (모의 전용·선물 시뮬레이션, 2배)', market: 'crypto', timeframe: '1d',
  universe: ['KRW-BTC'], benchSym: 'KRW-BTC',
  params: { leverage: 2, trendSma: 100, entry: 20, exit: 10, atrN: 20, stopAtr: 2, size: 0.5, fundingPer8h: 0.0001 }, grid: null,
  get lookback() { return 110; },
  risk: { maxDrawdownHalt: 0 },
  createState: createFutState, stepper: stepFutures,
  description: '모의 전용(선물 시뮬레이션). 실제 선물 거래 기능은 없음. 비트코인이 100일 평균 위에서 20일 최고가를 넘으면 롱, 아래에서 20일 최저가를 깨면 숏(최대 2배, 격리 증거금 50%). 10일 반대 채널 이탈 시 청산, 진입 시 2ATR 거래소 손절, 강제청산·펀딩비(8시간 0.01%) 반영.',
  decideFutures(ctx) {
    const p = ctx.params;
    const bars = ctx.history('KRW-BTC', p.trendSma + 2);
    if (bars.length < p.trendSma) return null;
    const c = bars.map((b) => b.c), hi = bars.map((b) => b.h), lo = bars.map((b) => b.l);
    const last = c[c.length - 1], trend = sma(c, p.trendSma);
    const a = atr(bars.slice(-(p.atrN + 1)), p.atrN);
    const pos = ctx.position;
    if (pos) {
      if (pos.side > 0 && last < lowestPrior(lo, p.exit)) return { order: { action: 'close', reason: `롱 청산: 최근 ${p.exit}일 최저가 이탈` } };
      if (pos.side < 0 && last > highestPrior(hi, p.exit)) return { order: { action: 'close', reason: `숏 청산: 최근 ${p.exit}일 최고가 돌파` } };
      return null;
    }
    if (last > trend && last > highestPrior(hi, p.entry)) return { order: { action: 'open', side: 1, size: p.size, stopDist: p.stopAtr * a, reason: `롱 진입(시뮬): 100일 평균 위 + ${p.entry}일 최고가 돌파, ${p.leverage}배` } };
    if (last < trend && last < lowestPrior(lo, p.entry)) return { order: { action: 'open', side: -1, size: p.size, stopDist: p.stopAtr * a, reason: `숏 진입(시뮬): 100일 평균 아래 + ${p.entry}일 최저가 이탈, ${p.leverage}배` } };
    return null;
  },
};
