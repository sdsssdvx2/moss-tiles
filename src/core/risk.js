// Risk layer applied on top of EVERY strategy's target weights.
// Pure functions; the engine calls applyRisk() after strategy.decide().

export const RISK_DEFAULTS = {
  maxPositionWeight: 0.30, // 한 종목 최대 비중
  minCash: 0.40,           // 항상 남겨둘 현금 비율 (조사 보고서 4장: 40% 이상)
  dailyLossLimit: 0.02,    // 하루(직전 마감 대비) 손실이 이만큼이면 그날 신규 매수 중단
  weeklyLossLimit: 0.04,   // 이번 주(월요일 시작) 손실이 이만큼이면 그 주 신규 매수 중단
  maxDrawdownHalt: 0.20,   // 모의 장부: 고점 대비 손실폭이 이만큼이면 전량 매도 후 멈춤 (실거래 킬스위치는 별도·더 엄격)
  haltCooldownBars: 5,     // 멈춘 뒤 다시 모의 검증을 시작하기까지 대기 봉 수
  rebalanceBand: 0.03,     // 목표 비중과 3%p 이상 차이날 때만 조정
};

export function mergeRisk(...layers) {
  return Object.assign({}, RISK_DEFAULTS, ...layers.filter(Boolean));
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/**
 * @param {Record<string,number>} targets desired weights (0..1)
 * @param {{weights:Record<string,number>, blockBuys:boolean, dailyRet:number}} ctx
 * @param {object} risk merged risk config
 * @returns {{targets:Record<string,number>, notes:Record<string,string>}}
 */
export function applyRisk(targets, ctx, risk) {
  const out = {};
  const notes = {};
  for (const [sym, w0] of Object.entries(targets || {})) {
    let w = Number(w0);
    if (!Number.isFinite(w) || w < 0) w = 0; // long-only, no leverage
    if (w > risk.maxPositionWeight) {
      w = risk.maxPositionWeight;
      notes[sym] = `위험 관리: 한 종목은 최대 ${pct(risk.maxPositionWeight)}까지만`;
    }
    out[sym] = w;
  }
  const cap = Math.max(0, 1 - risk.minCash);
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total > cap + 1e-12) {
    const k = cap / total;
    for (const s of Object.keys(out)) {
      out[s] *= k;
      notes[s] = notes[s] || `위험 관리: 현금 ${pct(risk.minCash)} 이상 남기도록 비중 축소`;
    }
  }
  if (ctx.blockBuys) {
    for (const s of Object.keys(out)) {
      const cur = ctx.weights[s] || 0;
      if (out[s] > cur + 1e-9) {
        out[s] = cur;
        notes[s] = ctx.blockWeekly && !(ctx.dailyRet <= -risk.dailyLossLimit)
          ? `위험 관리: 주간 손실 한도(${pct(risk.weeklyLossLimit)}) 도달로 새로 사지 않음`
          : `위험 관리: 하루 손실 한도(${pct(risk.dailyLossLimit)}) 도달로 새로 사지 않음`;
      }
    }
  }
  return { targets: out, notes };
}

export function drawdown(equity, peak) {
  return peak > 0 ? 1 - equity / peak : 0;
}
