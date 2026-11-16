// Hourly EMA trend on BTC/ETH.
import { emaSeries } from '../core/indicators.js';
import { symName, CRYPTO_HOURLY } from '../config.js';

export const cryptoTrend1hV1 = {
  id: 'crypto_trend1h_v1', family: 'crypto_trend1h', version: 1, cadence: 'fast', researchOnly: true, priorTrials: 20,
  name: '비트·이더 1시간봉 추세', market: 'crypto', timeframe: '1h',
  universe: CRYPTO_HOURLY, benchSym: 'KRW-BTC',
  params: { fast: 24, slow: 72 }, grid: { fast: [12, 24], slow: [72, 120, 168] },
  get lookback() { return 400; },
  risk: { maxPositionWeight: 0.5, maxDrawdownHalt: 0.3, dailyLossLimit: 0.06 },
  description: '1시간봉 기준 짧은 평균(예: 24시간)이 긴 평균(예: 72시간) 위에 있으면 보유, 아래로 내려가면 판다.',
  decide(ctx) {
    const { fast, slow } = ctx.params;
    const targets = {};
    const reasons = {};
    let changed = false;
    for (const sym of ctx.universe) {
      const c = ctx.closes(sym, slow * 3);
      if (c.length < slow + 2) continue;
      const f = emaSeries(c, fast), s = emaSeries(c, slow);
      const up = f[f.length - 1] > s[s.length - 1];
      const held = ctx.positions[sym] > 0;
      if (up) {
        targets[sym] = held ? ctx.weights[sym] : 0.5;
        if (!held) { changed = true; reasons[sym] = `${symName(sym)}: 1시간봉 ${fast}시간 평균이 ${slow}시간 평균 위로 올라가서 매수`; }
      } else if (held) {
        changed = true; targets[sym] = 0; reasons[sym] = `${symName(sym)}: ${fast}시간 평균이 ${slow}시간 평균 아래로 내려가서 매도`;
      }
    }
    return changed ? { targets, reasons } : null;
  },
};
