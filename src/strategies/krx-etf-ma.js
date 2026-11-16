// KODEX 200 vs short-term bond ETF switch on a moving-average filter.
import { sma } from '../core/indicators.js';

export const krxEtfMaV1 = {
  id: 'krx_etf_ma_v1', family: 'krx_etf_ma', version: 1, cadence: 'slow', researchOnly: true, priorTrials: 0,
  name: 'KODEX 200 이동평균 갈아타기', market: 'krx', timeframe: '1d',
  universe: ['069500', '153130'], benchSym: '069500',
  params: { sma: 120 }, grid: { sma: [20, 60, 120, 200] },
  get lookback() { return 210; },
  risk: { maxPositionWeight: 1 },
  description: '코스피200 ETF 가격이 N일 이동평균 위에 있으면 KODEX 200을, 아래면 단기채권 ETF를 들고 있는다.',
  decide(ctx) {
    const n = ctx.params.sma;
    const c = ctx.closes('069500', n + 1);
    if (c.length < n) return null;
    const m = sma(c, n);
    const up = c[c.length - 1] > m;
    const want = up ? '069500' : '153130';
    if ((ctx.weights[want] || 0) > 0.5) return null;
    const reason = up ? `KODEX 200: 가격이 ${n}일 이동평균 위로 올라가서 매수` : `KODEX 200이 ${n}일 이동평균 아래로 내려가서 단기채권 ETF로 피신`;
    const other = up ? '153130' : '069500';
    return { targets: { [want]: 1 }, reasons: { [want]: reason, [other]: up ? '주식 쪽으로 갈아타기 위해 매도' : `KODEX 200: ${n}일 이동평균 아래로 내려가서 매도` } };
  },
};
