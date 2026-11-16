// Crypto cross-sectional momentum with a BTC regime filter.
import { sma, roc } from '../core/indicators.js';
import { symName, CRYPTO_CORE } from '../config.js';

const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 1000) / 10}%`;

export const cryptoMomV1 = {
  id: 'crypto_mom_v1', family: 'crypto_mom', version: 1, cadence: 'fast', researchOnly: true, priorTrials: 0,
  name: '코인 모멘텀 + 비트코인 장세 필터', market: 'crypto', timeframe: '1d',
  universe: CRYPTO_CORE, dynamicUniverse: true, benchSym: 'KRW-BTC',
  params: { lookback: 30, topK: 2, regimeSma: 50, rebalanceEvery: 7 },
  grid: { lookback: [14, 30, 60], topK: [1, 2, 3], regimeSma: [50, 100], rebalanceEvery: [7] },
  get lookback() { return 110; },
  risk: { maxPositionWeight: 0.5, maxDrawdownHalt: 0.35, dailyLossLimit: 0.08 },
  description: '비트코인이 N일 평균 위(상승장)일 때만, 최근 상승률이 가장 높은 코인 몇 개를 산다. 비트코인이 평균 아래로 내려가면 전부 현금으로 바꾼다.',
  decide(ctx) {
    const p = ctx.params;
    const btc = ctx.closes('KRW-BTC', p.regimeSma + 1);
    if (btc.length < p.regimeSma) return null;
    const regime = btc[btc.length - 1] > sma(btc, p.regimeSma) ? 'up' : 'down';
    const prev = ctx.mem.regime;
    const mem = { regime, lastRebal: ctx.mem.lastRebal ?? -1e9 };
    const due = ctx.barIndex - mem.lastRebal >= p.rebalanceEvery;
    if (regime === 'down') {
      const held = Object.keys(ctx.positions).filter((s) => ctx.positions[s] > 0);
      if (!held.length) return { mem };
      const reasons = Object.fromEntries(held.map((s) => [s, `비트코인이 ${p.regimeSma}일 평균 아래로 내려가 하락장으로 판단 → ${symName(s)} 매도, 현금 보유`]));
      return { targets: {}, reasons, mem };
    }
    if (!due && prev === 'up') return { mem };
    mem.lastRebal = ctx.barIndex;
    const ranked = [];
    for (const sym of ctx.universe) {
      const c = ctx.closes(sym, p.lookback + 1);
      if (c.length < p.lookback + 1) continue;
      const r = roc(c, p.lookback);
      if (Number.isFinite(r) && r > 0) ranked.push({ sym, r });
    }
    ranked.sort((a, b) => b.r - a.r);
    const top = ranked.slice(0, p.topK);
    const targets = {};
    const reasons = {};
    for (const [i, x] of top.entries()) {
      targets[x.sym] = 1 / p.topK;
      reasons[x.sym] = `${symName(x.sym)}: 최근 ${p.lookback}일 상승률 ${i + 1}위 (${pct(x.r)}) + 비트코인 상승장이라 매수/유지`;
    }
    for (const s of Object.keys(ctx.positions)) if (!(s in targets)) reasons[s] = `${symName(s)}: 상승률 순위에서 밀려나 매도`;
    return { targets, reasons, mem };
  },
};
