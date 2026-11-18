// Strategy registry. A strategy is a plain object with a PURE decide(ctx) function:
//   decide(ctx) -> null (no change) | { targets: {sym: weight 0..1}, reasons: {sym: '쉬운 한국어 이유'}, mem? }
// ctx = { t, params, universe, benchSym, history(sym,n), closes(sym,n), last(sym), positions, weights,
//         entries, equity, cash, barIndex, mem, signals }  (signals: optional news/sentiment map)
// targets describe the FULL desired portfolio; symbols left out are sold.
// The risk layer (src/core/risk.js) is applied after decide() for every strategy.
// Each strategy also declares cadence ('slow'|'fast'), priorTrials (trial counter) and researchOnly.
// New versions: add e.g. krx_trend_v2 with the same `family` and a higher `version`.
import { makeBuyHold } from './buyhold.js';
import { krxTrendV1 } from './krx-trend.js';
import { krxEtfMaV1 } from './krx-etf-ma.js';
import { cryptoMomV1 } from './crypto-momentum.js';
import { cryptoTrend1hV1 } from './crypto-trend-1h.js';
import { EXTRA_STRATEGIES } from './research.js';
import { btcPerpSimV1 } from './futures-sim.js';
import { EXTERNAL_STRATEGIES } from './external.js';
import { AGGRESSIVE } from './aggressive.js';
import { FAMILY_STRATEGIES } from './family.js';

export const krxBenchmark = makeBuyHold({ id: 'krx_bh_v1', name: '기준선: KODEX 200TR 보유', market: 'krx', sym: '278530' });
export const cryptoBenchmark = makeBuyHold({ id: 'crypto_bh_v1', name: '기준선: 비트코인 보유', market: 'crypto', sym: 'KRW-BTC' });

// Order = dashboard order: research first paper set (A, B, C, D) first, then research-only experiments.
export const STRATEGIES = [...EXTRA_STRATEGIES, krxBenchmark, cryptoBenchmark, krxTrendV1, krxEtfMaV1, cryptoMomV1, cryptoTrend1hV1, ...AGGRESSIVE, btcPerpSimV1, ...FAMILY_STRATEGIES, ...EXTERNAL_STRATEGIES];
export const byId = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

export function validateStrategy(s) {
  const errs = [];
  for (const k of ['id', 'family', 'version', 'name', 'market', 'timeframe', 'universe']) if (s[k] == null) errs.push(`missing ${k}`);
  if (!s.decide && !s.decideFutures && !s.external) errs.push('missing decide');
  if (!['krx', 'crypto'].includes(s.market)) errs.push('market');
  if (!['1d', '1h'].includes(s.timeframe)) errs.push('timeframe');
  if (!/^[a-z0-9_]+_v\d+$/.test(s.id || '')) errs.push('id format <family>_v<N>');
  if (!['slow', 'fast'].includes(s.cadence)) errs.push('cadence');
  return errs;
}

/**
 * Trial counter per family (multiple-testing penalty): prior rejected attempts + every
 * registered version + every parameter variant tried. More trials -> the deflated Sharpe
 * gate demands stronger evidence automatically.
 */
export function trialsFor(strategy, registry = STRATEGIES) {
  if (strategy.generated) return Math.max(1, strategy.priorTrials || 0); // research job records the family total
  const fam = registry.filter((x) => x.family === strategy.family && !x.generated);
  const grid = (g) => (g ? Object.values(g).reduce((a, v) => a * v.length, 1) : 1);
  return (strategy.priorTrials || 0) + fam.reduce((a, x) => a + grid(x.grid), 0);
}

/**
 * Automatically generated variants (from the weekly research job) are stored in kv 'variants'
 * as [{id, base, version, params, trials, registeredAt, note}] and become first-class strategies:
 * same code as their base, new pre-registered params, new version id -> full pipeline from stage 1.
 */
export const MAX_ACTIVE_VARIANTS = 8;
export function variantStrategies(variants = []) {
  const out = [];
  for (const v of (Array.isArray(variants) ? variants : []).slice(-MAX_ACTIVE_VARIANTS)) {
    const b = byId[v.base];
    if (!b || b.benchmarkOnly || !/^[a-z0-9_]+_v\d+$/.test(v.id) || byId[v.id]) continue;
    if (v.id !== `${b.family}_v${v.version}`) continue;
    out.push({ ...b, id: v.id, version: v.version, params: { ...b.params, ...(v.params || {}) }, grid: null,
      priorTrials: v.trials || 0, variantOf: v.base, generated: true, registeredAt: v.registeredAt || null,
      name: `${b.name.replace(/ v\d+$/, '')} v${v.version}`, description: `${b.description} (자동 연구로 찾은 변형: ${JSON.stringify(v.params)})` });
  }
  return out;
}
export function allStrategies(kv) {
  return [...STRATEGIES, ...variantStrategies(kv?.variants)];
}
export function strategyById(kv, id) {
  return byId[id] || variantStrategies(kv?.variants).find((s) => s.id === id) || null;
}
