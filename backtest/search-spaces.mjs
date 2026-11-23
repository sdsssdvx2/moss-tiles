// Parameter ranges for the automated weekly variant search (sane, pre-declared).
// Only families listed here are searched. Changing a range = new trials, counted automatically.
// 2026-11-16 (ChatGPT deep research + DSR results): only the family that passed (etf_trend) is searched, on a small
// grid (MA 150/200/250, vol window 20/40/60, target vol 8-15%). Families that failed the DSR gate (etf_dip,
// crypto_trend, alt rotation/breakout) are NOT mined further — more random variants there mostly buy luck.
export const SEARCH_SPACES = {
  etf_trend: { base: 'etf_trend_v1', space: { sma: [150, 200, 250], band: [0, 0.005, 0.01], volTarget: [0.08, 0.10, 0.12, 0.15], volN: [20, 40, 60] } },
  // 2026-11-23 (#F-002 ②): 과거 검증을 통과한 E(etf_voltarget_v1)도 Claude 없이 숫자 탐색. 범위는 결과 보기 전에 고정.
  //   volN은 전략의 lookback(70)을 넘지 않게 60까지. 격자 4×3 = 12개.
  etf_voltarget: { base: 'etf_voltarget_v1', space: { target: [0.06, 0.08, 0.10, 0.12], volN: [20, 40, 60] } },
};
export const VARIANTS_PER_FAMILY_PER_RUN = 12;
