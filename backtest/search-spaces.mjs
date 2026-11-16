// Parameter ranges for the automated weekly variant search (sane, pre-declared).
// Only families listed here are searched. Changing a range = new trials, counted automatically.
export const SEARCH_SPACES = {
  etf_trend: { base: 'etf_trend_v1', space: { sma: [100, 120, 150, 180, 200, 220, 250], band: [0, 0.005, 0.01, 0.02], volTarget: [0.08, 0.10, 0.12, 0.15], volN: [20, 40] } },
  etf_dip: { base: 'etf_dip_v1', space: { sma: [100, 150, 200], exitSma: [3, 5, 7], maxHold: [5, 10, 15], stop: [0.05, 0.08, 0.12], rsiMax: [5, 10, 15], size: [0.3, 0.5] } },
  crypto_trend: { base: 'crypto_trend_v1', space: { filterSma: [100, 150, 200], entry: [20, 40, 55, 80], exit: [10, 20, 30], momDays: [14, 28, 56], atrK: [2, 3], volTarget: [0.2, 0.25, 0.35] } },
};
export const VARIANTS_PER_FAMILY_PER_RUN = 12;
