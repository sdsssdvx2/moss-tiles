// Parameter ranges for the automated weekly variant search (sane, pre-declared).
// Only families listed here are searched. Changing a range = new trials, counted automatically.
// 2026-11-16 (ChatGPT deep research + DSR results): only the family that passed (etf_trend) is searched, on a small
// grid (MA 150/200/250, vol window 20/40/60, target vol 8-15%). Families that failed the DSR gate (etf_dip,
// crypto_trend, alt rotation/breakout) are NOT mined further — more random variants there mostly buy luck.
export const SEARCH_SPACES = {
  etf_trend: { base: 'etf_trend_v1', space: { sma: [150, 200, 250], band: [0, 0.005, 0.01], volTarget: [0.08, 0.10, 0.12, 0.15], volN: [20, 40, 60] } },
  // 2026-11-23: etf_voltarget 탐색을 넣었다가 뺌 — 가족 시도 수가 기본판(etf_voltarget_v1)의 실력 확률에도 더해져
  //   0.99 → 0.807(시도 8)·0.755(12)로 관문(0.90) 아래가 됨. 이미 통과한 장부의 증거를 결과를 보고 바꾸지 않는다(P6).
};
export const VARIANTS_PER_FAMILY_PER_RUN = 12;
