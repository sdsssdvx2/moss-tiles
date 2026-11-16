// Benchmark: buy-and-hold (optionally ramped in over `dcaBars` bars = 분할매수).
import { symName } from '../config.js';

export function makeBuyHold({ id, name, market, sym, timeframe = '1d', dcaBars = 1, description }) {
  return {
    id, family: id.replace(/_v\d+$/, ''), version: 1, name, market, timeframe,
    benchmarkOnly: true, cadence: 'slow', universe: [sym], benchSym: sym, lookback: 2,
    params: { dcaBars }, grid: null,
    risk: { maxPositionWeight: 1, minCash: 0.02, maxDrawdownHalt: 0, dailyLossLimit: 0, weeklyLossLimit: 0 },
    description: description || `${symName(sym)}을(를) 처음에 사서 계속 들고 있는 기준선. 다른 전략은 이것보다 나아야 의미가 있음.`,
    decide(ctx) {
      const steps = Math.max(1, ctx.params.dcaBars | 0);
      const held = ctx.weights[sym] || 0;
      if (ctx.barIndex >= steps && held > 0) return null;
      const w = Math.min(1, (ctx.barIndex + 1) / steps);
      if (held >= w - 0.01) return null;
      const reason = steps > 1 ? `기준선: ${symName(sym)} ${steps}번에 나눠 사는 중 (${Math.min(steps, ctx.barIndex + 1)}/${steps})` : `기준선: ${symName(sym)}을(를) 사서 계속 보유`;
      return { targets: { [sym]: w }, reasons: { [sym]: reason } };
    },
  };
}
