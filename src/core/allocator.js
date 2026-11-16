// 전략 운용 매니저 (meta-allocator). Pure.
// Allocates the (paper now, live later) budget across strategies by LONG-window risk-adjusted
// performance instead of switching after a few losses.
//  - only strategies that passed the pipeline (stage in eligibleStages) and have >= minDays of paper data
//  - score = annualised Sharpe over the last windowDays (negative -> 0)
//  - cap per strategy, floor reserved for baselines (적립식 기준선)
//  - hysteresis: re-balance at most every minIntervalDays, each weight moves at most +-maxStep
export const ALLOC_DEFAULTS = {
  windowDays: 90, minDays: 60, maxPerStrategy: 0.40, baselineFloor: 0.20, maxStep: 0.10,
  minIntervalDays: 7, eligibleStages: ['live_candidate'], ppy: 252,
};

function sharpeOf(r, ppy) {
  if (r.length < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(ppy) : 0;
}

/**
 * @param candidates [{id, stage, benchmarkOnly, dailyReturns:number[]}]
 * @param prev {t, weights} | null
 */
export function allocate(candidates, prev, nowSec, cfg = ALLOC_DEFAULTS) {
  const c = { ...ALLOC_DEFAULTS, ...cfg };
  // B19: a strategy that lost eligibility (halted, failed...) drops to 0 immediately, bypassing interval/step limits
  const disq = new Set(candidates.filter((x) => !x.benchmarkOnly && !c.eligibleStages.includes(x.stage)).map((x) => x.id));
  const hasDisq = Object.keys(prev?.weights || {}).some((id) => disq.has(id));
  if (prev && nowSec - prev.t < c.minIntervalDays * 86400 && !hasDisq) return { ...prev, changed: false };
  const baselines = candidates.filter((x) => x.benchmarkOnly).map((x) => x.id);
  const notes = {};
  const scores = {};
  for (const x of candidates) {
    if (x.benchmarkOnly) continue;
    const r = (x.dailyReturns || []).slice(-c.windowDays);
    if (!c.eligibleStages.includes(x.stage)) { notes[x.id] = '파이프라인 미통과 → 0%'; continue; }
    if (r.length < c.minDays) { notes[x.id] = `기록 ${r.length}일 < ${c.minDays}일 → 0%`; continue; }
    const s = Math.max(0, sharpeOf(r, c.ppy));
    scores[x.id] = s;
    notes[x.id] = `최근 ${r.length}일 샤프 ${s.toFixed(2)}`;
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const target = {};
  const room = 1 - c.baselineFloor;
  if (total > 0) {
    for (const [id, s] of Object.entries(scores)) target[id] = Math.min(c.maxPerStrategy, (s / total) * room);
  }
  // hysteresis vs previous weights
  const out = {};
  const prevW = prev?.weights || {};
  const ids = new Set([...Object.keys(target), ...Object.keys(prevW).filter((k) => !baselines.includes(k))]);
  for (const id of ids) {
    if (disq.has(id)) continue;
    const p = prevW[id] || 0, tgt = target[id] || 0;
    const w = p + Math.max(-c.maxStep, Math.min(c.maxStep, tgt - p));
    if (w > 1e-4) out[id] = Math.round(w * 10000) / 10000;
  }
  const used = Object.values(out).reduce((a, b) => a + b, 0);
  const rest = Math.max(0, 1 - used);
  for (const b of baselines) out[b] = Math.round((rest / Math.max(1, baselines.length)) * 10000) / 10000;
  for (const b of baselines) notes[b] = '기준선 몫(최소 ' + Math.round(c.baselineFloor * 100) + '% + 남는 몫)';
  return { t: nowSec, weights: out, notes, changed: true };
}
