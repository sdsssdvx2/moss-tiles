// 사전 등록 후보 대기열 (backtest/CANDIDATES-PREREG.md, 규칙·숫자·종목·위험 한도·공개 날짜 2026-11-23 17:58 고정).
// 여기 있는 전략은 STRATEGIES 에 넣지 않는다: 주간 연구(Actions)가 공개 날짜가 지난 뒤 처음 도는 날 한 번 과거 검증하고,
// 통과한 것만 import.json 의 candidates 로 Worker 에 넘긴다 → kv 'candidates:released' → allStrategies(kv) 가 그것만 더한다.
// 공개 전에는 연구실 시도 수에도, 모의 장부에도 없다. Worker 는 현재 시각으로 후보를 열지 않는다(받은 것을 거르기만).
// 전부 가상 돈(모의)만. 실제 주문 기능 없음.
import { sma } from '../core/indicators.js';
import { symName } from '../config.js';
import { realizedVol, monthOf } from './common.js';

const ETF_RISK = { maxPositionWeight: 0.30, minCash: 0.40, dailyLossLimit: 0.02, weeklyLossLimit: 0.04, maxDrawdownHalt: 0.20 };
const BOND = '153130';
/** 쉬는 몫은 단기채권(위험 한도 종목 30% 상한 때문에 실제로는 최대 30% — 기존 bondFill 과 같음). */
const bondFill = (targets, reasons, eq, why = '쉬는 돈은 단기채권 ETF에 보관 (현금 대용)') => {
  const bond = Math.max(0, Math.min(0.30, 0.60 - eq));
  if (bond > 0.02) { targets[BOND] = bond; reasons[BOND] = why; }
};
const quarterOf = (t) => Math.floor(monthOf(t) / 3);

// ---------------- 1) 품질·저변동 (공개 2026-12-12) ----------------
export const etfQualityLowvolV1 = {
  id: 'etf_quality_lowvol_v1', family: 'etf_quality_lowvol', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2026-12-12', candidate: true,
  name: '후보: ETF 저변동·고배당 (매월)', market: 'krx', timeframe: '1d',
  universe: ['174350', '161510', '279530', BOND], benchSym: '174350',
  params: { minBars: 250, volN: 60, pick: 2, weight: 0.30, sma: 200 }, grid: null,
  get lookback() { return 260; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 TIGER 로우볼·PLUS 고배당주·KODEX 고배당주 중 자료가 250거래일 이상 쌓인 것만 놓고, 최근 60거래일 흔들림(변동성)이 가장 작은 2개를 30%씩 든다. 그중 200일 평균 아래인 종목의 몫은 단기채권 ETF로. (2026-11-23 사전 등록)',
  decide(ctx) {
    if (monthOf(ctx.t) === ctx.mem.month && ctx.barIndex > 0) return null;
    const p = ctx.params;
    const ranked = [];
    for (const sym of ['174350', '161510', '279530']) {
      const c = ctx.closes(sym, p.minBars + 1);
      if (c.length < p.minBars) continue;
      const v = realizedVol(ctx.closes(sym, p.volN + 2), p.volN, 252);
      if (Number.isFinite(v) && v > 0) ranked.push({ sym, v, above: c[c.length - 1] > sma(c, p.sma) });
    }
    ranked.sort((a, b) => a.v - b.v || a.sym.localeCompare(b.sym));
    const targets = {}, reasons = {};
    let eq = 0;
    for (const r of ranked.slice(0, p.pick)) {
      if (r.above) { targets[r.sym] = p.weight; eq += p.weight; reasons[r.sym] = `${symName(r.sym)}: 최근 변동성 연 ${Math.round(r.v * 100)}%로 낮은 편 → ${Math.round(p.weight * 100)}% (월간 조정)`; }
      else reasons[r.sym] = `${symName(r.sym)}: 변동성은 낮지만 200일 평균 아래 → 이 몫은 단기채권으로`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

// ---------------- 2) 올웨더(고정 비율) (공개 2026-12-26) ----------------
const AW = { '069500': 0.15, '379800': 0.15, '148070': 0.40, '132030': 0.15, [BOND]: 0.15 };
export const etfAllweatherV1 = {
  id: 'etf_allweather_v1', family: 'etf_allweather', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2026-12-26', candidate: true,
  name: '후보: ETF 올웨더 고정 비율 (분기)', market: 'krx', timeframe: '1d',
  universe: ['069500', '379800', '148070', '132030', BOND], benchSym: '069500',
  params: { weights: AW }, grid: null,
  get lookback() { return 20; },
  risk: { maxPositionWeight: 0.40, minCash: 0, dailyLossLimit: 0.03, weeklyLossLimit: 0.06, maxDrawdownHalt: 0.20 },
  description: '타이밍 없이 국내주식(KODEX 200) 15% · 미국주식(KODEX 미국S&P500TR) 15% · 장기채(국고채10년) 40% · 금(골드선물) 15% · 단기채권 15%를 들고, 분기 첫 거래일에만 비율을 다시 맞춘다. 자료가 아직 없는 종목(미국S&P500TR은 2021-04 상장)의 몫은 단기채권으로. (2026-11-23 사전 등록)',
  decide(ctx) {
    if (quarterOf(ctx.t) === ctx.mem.q && ctx.barIndex > 0) return null;
    const w = ctx.params.weights;
    const targets = {}, reasons = {};
    let toBond = 0;
    for (const [sym, x] of Object.entries(w)) {
      if (sym === BOND) continue;
      if (ctx.closes(sym, 1).length) { targets[sym] = x; reasons[sym] = `${symName(sym)}: 고정 비율 ${Math.round(x * 100)}% (분기 조정)`; }
      else { toBond += x; reasons[sym] = `${symName(sym)}: 아직 시세 자료가 없어 이 몫 ${Math.round(x * 100)}%는 단기채권으로`; }
    }
    targets[BOND] = w[BOND] + toBond;
    reasons[BOND] = `단기채권: 고정 비율 ${Math.round(w[BOND] * 100)}%${toBond ? ` + 자료 없는 종목 몫 ${Math.round(toBond * 100)}%` : ''}`;
    return { targets, reasons, mem: { q: quarterOf(ctx.t) } };
  },
};

// ---------------- 3) 선진국 추세 (공개 2027-01-09) ----------------
export const etfDevTrendV1 = {
  id: 'etf_dev_trend_v1', family: 'etf_dev_trend', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2027-01-09', candidate: true,
  name: '후보: 선진국·미국 200일선 추세 (매월)', market: 'krx', timeframe: '1d',
  universe: ['251350', '379800', BOND], benchSym: '251350',
  params: { sma: 200, weight: 0.30 }, grid: null,
  get lookback() { return 230; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 KODEX MSCI선진국·KODEX 미국S&P500TR 각각 가격이 200일 평균 위면 30%, 아래면 그 몫을 단기채권 ETF로. (2026-11-23 사전 등록)',
  decide(ctx) {
    if (monthOf(ctx.t) === ctx.mem.month && ctx.barIndex > 0) return null;
    const p = ctx.params;
    const targets = {}, reasons = {};
    let eq = 0;
    for (const sym of ['251350', '379800']) {
      const c = ctx.closes(sym, p.sma + 1);
      if (c.length < p.sma) { reasons[sym] = `${symName(sym)}: 200일 평균을 낼 자료가 아직 모자라 쉼`; continue; }
      if (c[c.length - 1] > sma(c, p.sma)) { targets[sym] = p.weight; eq += p.weight; reasons[sym] = `${symName(sym)}: 200일 평균 위 → ${Math.round(p.weight * 100)}% (월간 조정)`; }
      else reasons[sym] = `${symName(sym)}: 200일 평균 아래 → 이 몫은 단기채권으로`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

export const CANDIDATES = [etfQualityLowvolV1, etfAllweatherV1, etfDevTrendV1];
export const candidateById = Object.fromEntries(CANDIDATES.map((s) => [s.id, s]));

/** KST 자정 기준 공개 시각(unix 초). releaseDate 'YYYY-MM-DD' 는 한국 날짜. */
export const releaseAt = (s) => Date.parse(`${s.releaseDate}T00:00:00+09:00`) / 1000;

/** Worker 쪽: kv 'candidates:released' = [{id, releasedAt}] 중 코드에 있는 후보만 전략으로. 현재 시각을 보지 않는다. */
export function candidateStrategies(released) {
  const out = [];
  for (const r of Array.isArray(released) ? released : []) {
    const s = candidateById[r?.id];
    if (s && !out.some((x) => x.id === s.id)) out.push({ ...s, releasedAt: Number(r.releasedAt) || null });
  }
  return out;
}
