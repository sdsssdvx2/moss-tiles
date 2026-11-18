// Strategy lifecycle / promotion gate.
//   백테스트 → 모의 검증 → 운영 점검 통과(실력 증명 아님) → (중단 → 모의 복귀)
// 'live_candidate' 키 이름은 저장된 기록과의 호환 때문에 그대로 두고 화면 문구만 바꿨다(2026-11-18).
// IMPORTANT: "live_candidate" only produces a dashboard badge + notification.
// This code base contains no order-placing code path of any kind.

export const STAGES = {
  benchmark: { label: '기준선', order: -1 },
  backtest: { label: '백테스트 중', order: 0 },
  bt_failed: { label: '백테스트 미통과', order: 0 },
  paper: { label: '모의 검증 중', order: 1 },
  live_candidate: { label: '운영 점검 통과(실력 증명 아님)', order: 2 },
  halted: { label: '중단 → 모의 복귀 대기', order: 1 },
  retired: { label: '새 버전으로 대체됨', order: -2 },
};

// Defaults follow RESEARCH-STRATEGY-KO.md section 5 (G1 백테스트 / G2 짧은 모의 / 킬스위치).
// All values are fixed BEFORE looking at results and are configurable via GATES_JSON.
export const GATE_DEFAULTS = {
  backtest: {
    // G1: judged on the untouched hold-out (last 25%), with walk-forward OOS as fallback.
    minTrades: 100, slowMinTrades: 30, slowMinYears: 10,
    mustBeProfitable: true,          // 비용 차감 후 수익 > 0
    mustBeProfitable2x: true,        // 비용 2배에서도 > 0
    maxMddVsBench: 0.70,             // MDD <= 기준선 MDD x 0.7 (손실 최소 목표)
    minSharpe: 0.5, sharpeVsBench: -0.1, // 샤프 >= 0.5 그리고 >= 기준선 샤프 - 0.1
    mustBeatBenchmarkReturn: false,  // true 로 바꾸면 "기준선보다 총수익이 높아야 함"도 요구
    minDeflatedSharpe: 0.9,          // 시도 횟수 보정 샤프 확률
    // 위험 맞춤 기준선: 전략의 평균 투자 비율만큼만 지수, 나머지는 단기채권(코인은 현금)인 고정 비율(매월 조정).
    // "낙폭이 작다"가 단지 "덜 투자해서"인지 가려낸다. 전략 샤프가 이 기준선 샤프 + margin 이상이어야 통과.
    mustBeatRiskMatched: true, riskMatchedSharpeMargin: 0,
  },
  paper: {
    // G2: proves EXECUTION, not skill.
    // minRebalances = 실제로 포트폴리오를 바꾼(체결이 난) 서로 다른 봉 수. 예전 '모의 판단 N회'는 일봉 개수라서
    // 주 1회 전략이 실제 판단 4번 만에 통과할 수 있었다(2026-11-18 점검 #4).
    fast: { crypto: { minDays: 14, minTrades: 20, minRebalances: 12 }, krx: { minBars: 20, minTrades: 10, maxBars: 40, minRebalances: 12 } },
    slow: { crypto: { minDays: 14, minRebalances: 12 }, krx: { minBars: 20, minRebalances: 12 } },
    requireSignalAgreement: true,    // 같은 기간 백테스트 재생과 체결 100% 일치
    maxMdd: { krx: 0.10, crypto: 0.15 },
  },
  live: {
    // FUTURE live module (data model only; no order code exists).
    budgetKrw: { crypto: 20000, krx: 30000 }, accountMaxKrw: 50000,
    // 공격형 슬롯: separate hard cap; never refilled automatically after losses.
    sleeves: { aggressive: { budgetKrw: 200000, maxTotalLoss: 0.30, refill: false } },
    stepUp: { afterWeeks: { crypto: 4, krx: 8 }, factor: 2, maxDriftPerMonth: 0.01, requireNewHigh: true },
    kill: {
      maxDrawdown: { krx: 0.10, crypto: 0.15 }, maxDrawdownVsBacktest: 1.5,
      maxConsecutiveLosses: 7, maxDrift: 0.02, driftWindowDays: 20, maxSlippageVsAssumed: 3,
      account: { daily: 0.02, weekly: 0.04, total: 0.08 },
    },
  },
};

export function mergeGates(over = {}) {
  const g = JSON.parse(JSON.stringify(GATE_DEFAULTS));
  for (const k of Object.keys(over || {})) g[k] = deepMerge(g[k] || {}, over[k]);
  return g;
}
function deepMerge(a, b) {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b;
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = typeof v === 'object' && v && !Array.isArray(v) ? deepMerge(a?.[k] || {}, v) : v;
  return o;
}

export const pct = (x) => `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const pctAbs = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

const n1 = (x) => (Math.round(x * 100) / 100).toFixed(2);

/**
 * @param a.strategy {id, market, cadence:'slow'|'fast', benchmarkOnly?, researchOnly?}
 * @param a.bt  {holdout, holdout2x, wf, years, dsr, trials} (see backtest/run.mjs summary) or null
 * @param a.paper {days, bars, trades, decisions, mdd, totalReturn, bench, halted, agreement:{matched,total}|null}
 * @param a.kill  shadow kill-switch result for strategies that already reached live_candidate
 */
export function evaluateStage({ strategy, bt, paper, kill, gates = GATE_DEFAULTS }) {
  const m = strategy.market;
  const slow = strategy.cadence === 'slow';
  const checks = [];
  if (strategy.benchmarkOnly) return { stage: 'benchmark', label: STAGES.benchmark.label, checks, summary: '다른 전략과 비교하는 기준(그냥 사서 보유/적립)' };

  const g = gates.backtest;
  const ho = bt?.holdout || bt?.wf || bt?.oos || null;
  if (bt) {
    // B04: missing evidence must FAIL, not silently skip the check ("no failed check" is not "passed")
    const need = [ho?.totalReturn, ho?.mdd, ho?.sharpe, ho?.bench?.mdd, ho?.bench?.sharpe];
    if (g.mustBeProfitable2x) need.push(bt.holdout2x?.totalReturn);
    if (g.minDeflatedSharpe > 0) need.push(bt.dsr);
    if (g.mustBeatRiskMatched && !strategy.noRiskMatched) need.push(ho?.riskMatched?.sharpe);
    checks.push({ group: '백테스트', ok: !!ho && need.every(Number.isFinite), text: '필수 검증 자료(미사용 구간·기준선·위험 맞춤 기준선·비용 2배·DSR) 모두 있음' });
  }
  if (bt && ho) {
    const b = ho.bench || {};
    const minT = slow ? g.slowMinTrades : g.minTrades;
    const trades = bt.totalTrades ?? ho.trades;
    checks.push({ group: '백테스트', ok: trades >= minT, text: `과거 전체 거래 ${trades}회 (최소 ${minT}회${slow ? ', 느린 전략 기준' : ''})` });
    if (slow) checks.push({ group: '백테스트', ok: (bt.years || 0) >= g.slowMinYears, text: `검증 기간 ${n1(bt.years || 0)}년 (느린 전략은 ${g.slowMinYears}년 이상)` });
    if (g.mustBeProfitable) checks.push({ group: '백테스트', ok: ho.totalReturn > 0, text: `미사용 구간 수익 ${pct(ho.totalReturn)} (비용 차감 후 > 0)` });
    if (g.mustBeProfitable2x && bt.holdout2x) checks.push({ group: '백테스트', ok: bt.holdout2x.totalReturn > 0, text: `비용 2배일 때 ${pct(bt.holdout2x.totalReturn)} (> 0)` });
    if (b.mdd != null) checks.push({ group: '백테스트', ok: ho.mdd <= b.mdd * g.maxMddVsBench + 1e-9, text: `최대 낙폭 ${pctAbs(ho.mdd)} ≤ 기준선 ${pctAbs(b.mdd)}의 ${Math.round(g.maxMddVsBench * 100)}%` });
    checks.push({ group: '백테스트', ok: ho.sharpe >= g.minSharpe && ho.sharpe >= (b.sharpe ?? 0) + g.sharpeVsBench, text: `샤프 ${n1(ho.sharpe)} (≥ ${g.minSharpe}, 기준선 ${n1(b.sharpe ?? 0)} - 0.1 이상)` });
    if (g.mustBeatBenchmarkReturn) checks.push({ group: '백테스트', ok: ho.totalReturn > (b.totalReturn ?? 0), text: `수익 ${pct(ho.totalReturn)} vs 기준선 ${pct(b.totalReturn ?? 0)}` });
    const rm = ho.riskMatched;
    if (g.mustBeatRiskMatched && rm && !strategy.noRiskMatched) checks.push({ group: '백테스트', ok: ho.sharpe >= rm.sharpe + g.riskMatchedSharpeMargin - 1e-9, text: `위험 맞춤 기준선(${rm.n > 1 ? `같은 종목 ${rm.n}개를 똑같이 나눠 ` : '지수 '}${Math.round(rm.weight * 100)}% + 나머지 ${rm.cash === 'bond' ? '단기채권' : '현금'}, 매월 조정)보다 샤프가 같거나 높음: ${n1(ho.sharpe)} vs ${n1(rm.sharpe)} (수익 ${pct(ho.totalReturn)} vs ${pct(rm.totalReturn)}, 낙폭 ${pctAbs(ho.mdd)} vs ${pctAbs(rm.mdd)})` });
    if (bt.dsr != null) checks.push({ group: '백테스트', ok: bt.dsr >= g.minDeflatedSharpe, text: `시도 ${bt.trials || 1}번을 감안한 실력 확률 ${Math.round(bt.dsr * 100)}% (≥ ${Math.round(g.minDeflatedSharpe * 100)}%)` });
  }
  const pg = gates.paper;
  if (paper) {
    const rule = (slow ? pg.slow : pg.fast)[m];
    if (rule.minDays) checks.push({ group: '모의', ok: paper.days >= rule.minDays, text: `모의 기간 ${paper.days}일 (최소 ${rule.minDays}일)` });
    if (rule.minBars) checks.push({ group: '모의', ok: paper.bars >= rule.minBars, text: `모의 거래일 ${paper.bars}일 (최소 ${rule.minBars}일)` });
    if (rule.minTrades) checks.push({ group: '모의', ok: paper.trades >= rule.minTrades, text: `모의 체결 ${paper.trades}회 (최소 ${rule.minTrades}회)` });
    if (rule.minDecisions) checks.push({ group: '모의', ok: (paper.decisions ?? paper.bars) >= rule.minDecisions, text: `모의 판단 ${paper.decisions ?? paper.bars}회 (최소 ${rule.minDecisions}회)` });
    if (rule.minRebalances) checks.push({ group: '모의', ok: (paper.rebalances ?? 0) >= rule.minRebalances, text: `실제 조정(체결이 난 날) ${paper.rebalances ?? 0}회 (최소 ${rule.minRebalances}회 — 일봉 개수가 아니라 실제로 포트폴리오를 바꾼 횟수)` });
    if (pg.requireSignalAgreement) {
      const a = paper.agreement;
      checks.push({ group: '모의', ok: !!a && a.total >= 0 && a.matched === a.total, text: a ? `백테스트 재생과 체결 일치 ${a.matched}/${a.total}` : '백테스트 재생 일치 검사 대기' });
    }
    checks.push({ group: '모의', ok: paper.mdd <= pg.maxMdd[m], text: `모의 최대 낙폭 ${pctAbs(paper.mdd)} (한도 ${pctAbs(pg.maxMdd[m])})` });
  }

  let stage;
  let summary;
  if (paper?.sleeveStopped) { stage = 'halted'; summary = paper.sleeveStopped; }
  else if (paper?.halted) { stage = 'halted'; summary = paper.haltReason || '위험 한도에 걸려 멈춤. 대기 후 모의 검증을 처음부터 다시 시작'; }
  else if (kill?.kill) { stage = 'halted'; summary = `자동 중단 규칙 발동: ${kill.reason} → 모의로 복귀`; }
  else if (!bt && strategy.noBacktest) {
    // 과거 자료로 검증할 수 없는 장부(예: AI 단독 — 과거 시점의 AI 판단이 없음): 모의 기록으로만 비교, 운영 점검 대상 아님
    stage = 'paper'; summary = '과거 검증 불가(과거 시점의 AI 판단 기록이 없음) → 처음 보는 자료의 모의 기록으로만 비교하는 연구용 장부';
  }
  else if (!bt) { stage = 'backtest'; summary = '과거 데이터로 먼저 검증하는 중'; }
  else if (checks.filter((c) => c.group === '백테스트').some((c) => !c.ok)) { stage = 'bt_failed'; summary = '과거 검증 기준 미달. 모의 기록은 계속 쌓되 실거래 후보가 될 수 없음'; }
  else if (!paper || checks.filter((c) => c.group === '모의').some((c) => !c.ok)) { stage = 'paper'; summary = '과거 검증 통과. 지금은 가상 돈으로 실제 시장에서 "백테스트대로 돌아가는지" 확인 중'; }
  else if (strategy.researchOnly) { stage = 'paper'; summary = '연구용 전략(조사 보고서 4장: 개별주·알트코인·단타 금지, 또는 비교·시뮬레이션 장부)이라 운영 점검 대상에서 제외. 모의로만 계속 기록'; }
  else if (strategy.sleeve === 'aggressive') { stage = 'live_candidate'; summary = '운영 점검 통과(실력 증명 아님): 모의 장부가 백테스트대로 돌아가는 것만 확인됨. 고위험 슬롯 한도 안에서만 사람이 검토할 수 있음 (자동 주문 없음)'; }
  else { stage = 'live_candidate'; summary = '운영 점검 통과(실력 증명 아님): 과거 검증 기준 + 모의 장부가 백테스트와 똑같이 움직이는 것까지 확인. 수익 능력은 몇 달~몇 년의 처음 보는 자료로만 판단 가능 (이 프로그램은 자동 주문을 하지 않음)'; }
  return { stage, label: STAGES[stage].label, checks, summary };
}

/** Mark older versions of a family as retired when a newer version is at least as far along and not worse. */
export function applySupersession(rows) {
  const byFamily = new Map();
  for (const r of rows) {
    if (r.stage === 'benchmark') continue;
    if (!byFamily.has(r.family)) byFamily.set(r.family, []);
    byFamily.get(r.family).push(r);
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) => b.version - a.version);
    const newest = list[0];
    for (const older of list.slice(1)) {
      const newerOrder = STAGES[newest.stage].order, olderOrder = STAGES[older.stage].order;
      const better = (newest.btSharpe ?? -Infinity) >= (older.btSharpe ?? -Infinity);
      if (newest.stage !== 'bt_failed' && newest.stage !== 'backtest' && newerOrder >= olderOrder && better) {
        older.stage = 'retired';
        older.label = STAGES.retired.label;
        older.summary = `${newest.id} 이(가) 같은 단계 이상이면서 성과가 같거나 좋아 대체됨 (기록은 계속 유지)`;
      }
    }
  }
  return rows;
}
