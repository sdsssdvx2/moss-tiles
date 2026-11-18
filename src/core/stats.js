// Statistics for honest backtest evaluation.
// Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014): probability that the observed Sharpe
// is above the best Sharpe expected from `nTrials` unskilled attempts.

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
export function normInv(p) {
  // Acklam's approximation
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function moments(r) {
  const n = r.length;
  const m = r.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of r) { const d = x - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { n, mean: m, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3 };
}

/** Probabilistic Sharpe Ratio of per-period returns against per-period benchmark SR*. */
export function psr(returns, srStar = 0) {
  if (returns.length < 3) return 0;
  const { n, mean, sd, skew, kurt } = moments(returns);
  if (sd === 0) return 0;
  const sr = mean / sd;
  const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - srStar) * Math.sqrt(n - 1)) / den);
}

/**
 * @param returns per-period returns of the selected strategy (out-of-sample preferred)
 * @param nTrials number of variants tried (trial counter)
 * @param trialSrStd std-dev of per-period Sharpe across the trials (0 -> uses 1/sqrt(n) as proxy)
 */
export function deflatedSharpe(returns, nTrials, trialSrStd = 0) {
  const n = returns.length;
  if (n < 3) return 0;
  const N = Math.max(1, nTrials | 0);
  if (N === 1) return psr(returns, 0);
  const g = 0.5772156649;
  const sd = trialSrStd > 0 ? trialSrStd : 1 / Math.sqrt(n);
  const srStar = sd * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
  return psr(returns, srStar);
}

export function periodReturns(points) {
  const r = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1].equity > 0) r.push(points[i].equity / points[i - 1].equity - 1);
  return r;
}

/**
 * 운만으로 기대되는 "최고" 연환산 샤프: 실력 없는 전략 nTrials개를 nObs개 기간 동안 돌렸을 때 그중 최고값의 기댓값
 * (Bailey & Lopez de Prado의 기대 최대값 근사, 전략 간 샤프 표준편차 = 1/sqrt(nObs) 가정). 연구실 전체 시도 수 보정 표시에 사용.
 */
export function expectedMaxSharpe(nTrials, nObs, periodsPerYear) {
  const N = Math.max(1, nTrials | 0);
  if (N === 1 || !(nObs > 1)) return 0;
  const g = 0.5772156649;
  const perPeriod = (1 / Math.sqrt(nObs)) * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
  return perPeriod * Math.sqrt(periodsPerYear);
}
