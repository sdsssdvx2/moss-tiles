// KRX large-cap trend following: Donchian breakout entry, Donchian exit, market regime filter.
import { highestPrior, lowestPrior, sma, roc } from '../core/indicators.js';
import { symName, KRX_STOCKS } from '../config.js';

export const krxTrendV1 = {
  id: 'krx_trend_v1', family: 'krx_trend', version: 1, cadence: 'slow', researchOnly: true, priorTrials: 0,
  name: '대형주 추세추종 (돈치안)', market: 'krx', timeframe: '1d',
  universe: Object.keys(KRX_STOCKS), benchSym: '069500',
  params: { entry: 20, exit: 10, maxPositions: 5, marketFilter: 1, marketSma: 120 },
  grid: { entry: [20, 40, 55], exit: [10, 20], maxPositions: [4, 6], marketFilter: [0, 1], marketSma: [120] },
  get lookback() { return 130; },
  risk: { maxPositionWeight: 0.25 },
  description: '대형주 20종목 중 최근 N일 최고가를 뚫고 올라간 종목을 사고, 최근 M일 최저가 아래로 내려가면 판다. 코스피200이 장기 평균 아래면 새로 사지 않는다.',
  decide(ctx) {
    const p = ctx.params;
    const need = Math.max(p.entry, p.exit, p.marketFilter ? p.marketSma : 0) + 1;
    let marketOk = true;
    if (p.marketFilter) {
      const mc = ctx.closes(ctx.benchSym, p.marketSma + 1);
      const m = sma(mc, p.marketSma);
      marketOk = !(mc.length >= p.marketSma && mc[mc.length - 1] < m);
    }
    const targets = {};
    const reasons = {};
    const w = 1 / p.maxPositions;
    let held = 0;
    for (const sym of ctx.universe) {
      if (!(ctx.positions[sym] > 0)) continue;
      const bars = ctx.history(sym, need);
      if (bars.length < p.exit + 1) { targets[sym] = ctx.weights[sym] || w; continue; }
      const low = lowestPrior(bars.map((b) => b.l), p.exit);
      const c = bars[bars.length - 1].c;
      if (c < low) { targets[sym] = 0; reasons[sym] = `${symName(sym)}: 최근 ${p.exit}일 최저가 아래로 내려가서 매도 (추세 끝)`; }
      else { targets[sym] = ctx.weights[sym] || w; held++; } // keep winners untrimmed
    }
    const cands = [];
    if (marketOk) {
      for (const sym of ctx.universe) {
        if (ctx.positions[sym] > 0) continue;
        const bars = ctx.history(sym, need);
        if (bars.length < need) continue;
        const hi = highestPrior(bars.map((b) => b.h), p.entry);
        const c = bars[bars.length - 1].c;
        if (c > hi) cands.push({ sym, score: roc(bars.map((b) => b.c), p.entry) });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, Math.max(0, p.maxPositions - held))) {
      targets[c.sym] = w;
      reasons[c.sym] = `${symName(c.sym)}: 최근 ${p.entry}일 최고가를 넘어 올라가서 매수 (상승 추세 시작 신호)`;
    }
    if (!marketOk && Object.keys(reasons).length === 0 && held === 0) return null;
    return { targets, reasons };
  },
};
