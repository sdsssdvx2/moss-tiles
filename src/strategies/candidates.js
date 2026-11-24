// 사전 등록 후보 대기열 (backtest/CANDIDATES-PREREG.md, 규칙·숫자·종목·위험 한도·공개 날짜 2026-11-23 17:58 고정).
// 여기 있는 전략은 STRATEGIES 에 넣지 않는다: 주간 연구(Actions)가 공개 날짜가 지난 뒤 처음 도는 날 한 번 과거 검증하고,
// 통과한 것만 import.json 의 candidates 로 Worker 에 넘긴다 → kv 'candidates:released' → allStrategies(kv) 가 그것만 더한다.
// 공개 전에는 연구실 시도 수에도, 모의 장부에도 없다. Worker 는 현재 시각으로 후보를 열지 않는다(받은 것을 거르기만).
// 전부 가상 돈(모의)만. 실제 주문 기능 없음.
import { sma, roc } from '../core/indicators.js';
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

// ---------------- 2차 사전 등록 (2026-11-24 12:3x, 결과 보기 전 — 요구사항 대조 '넉넉히' 반영) ----------------
// 전부 매월 첫 거래일 조정(모의 검증의 실제 조정 12회가 1년 안에 차게), 12년 자료가 있는 종목만, 널리 알려진 규칙.
const monthly = (ctx) => !(monthOf(ctx.t) === ctx.mem.month && ctx.barIndex > 0);
/** 200일 평균 위면 weight, 아래·자료 부족이면 **그 몫만** 단기채권(사전 등록 표 그대로 — 위일 때 채권을 더 들지 않음, 채권 30% 상한). */
function trendBook(ctx, syms, p) {
  const targets = {}, reasons = {};
  let toBond = 0;
  for (const sym of syms) {
    const c = ctx.closes(sym, p.sma + 1);
    if (c.length < p.sma) { toBond += p.weight; reasons[sym] = `${symName(sym)}: 200일 평균을 낼 자료가 아직 모자라 이 몫은 단기채권으로`; continue; }
    if (c[c.length - 1] > sma(c, p.sma)) { targets[sym] = p.weight; reasons[sym] = `${symName(sym)}: 200일 평균 위 → ${Math.round(p.weight * 100)}% (월간 조정)`; }
    else { toBond += p.weight; reasons[sym] = `${symName(sym)}: 200일 평균 아래 → 이 몫은 단기채권으로`; }
  }
  const bond = Math.min(0.30, toBond);
  if (bond > 0.02) { targets[BOND] = bond; reasons[BOND] = '200일 평균 아래인 종목의 몫은 단기채권 ETF에 보관 (현금 대용)'; }
  return { targets, reasons, mem: { month: monthOf(ctx.t) } };
}

// 4) 금 추세 (공개 2026-12-05 — 12-10 무인운영 점검 전에 대기열이 운영에서 한 번 끝까지 돌게)
export const etfGoldTrendV1 = {
  id: 'etf_gold_trend_v1', family: 'etf_gold_trend', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2026-12-05', candidate: true,
  name: '후보: 금 200일선 추세 (매월)', market: 'krx', timeframe: '1d',
  universe: ['132030', BOND], benchSym: '132030',
  params: { sma: 200, weight: 0.30 }, grid: null,
  get lookback() { return 230; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 KODEX 골드선물(H) 가격이 200일 평균 위면 30%, 아래면 그 몫을 단기채권 ETF로. (2026-11-24 사전 등록)',
  decide(ctx) { return monthly(ctx) ? trendBook(ctx, ['132030'], ctx.params) : null; },
};

// 5) 주식·채권 각각 추세 (공개 2027-01-23)
export const etfStockBondTrendV1 = {
  id: 'etf_stockbond_trend_v1', family: 'etf_stockbond_trend', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2027-01-23', candidate: true,
  name: '후보: 국내주식·국고채 각각 200일선 추세 (매월)', market: 'krx', timeframe: '1d',
  universe: ['069500', '148070', BOND], benchSym: '069500',
  params: { sma: 200, weight: 0.30 }, grid: null,
  get lookback() { return 230; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 KODEX 200·KIWOOM 국고채10년 각각 가격이 200일 평균 위면 30%, 아래면 그 몫을 단기채권 ETF로. (2026-11-24 사전 등록)',
  decide(ctx) { return monthly(ctx) ? trendBook(ctx, ['069500', '148070'], ctx.params) : null; },
};

// 6) 주식·채권·금 변동성 역수 비중 (공개 2027-02-06)
export const etfInvVol3V1 = {
  id: 'etf_invvol3_v1', family: 'etf_invvol3', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2027-02-06', candidate: true,
  name: '후보: 주식·채권·금 변동성 역수 비중 (매월)', market: 'krx', timeframe: '1d',
  universe: ['069500', '148070', '132030', BOND], benchSym: '069500',
  params: { volN: 60, total: 0.60, cap: 0.30 }, grid: null,
  get lookback() { return 70; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 KODEX 200·국고채10년·골드선물(H)의 최근 60거래일 변동성을 재서, 덜 흔들리는 것일수록 많이(변동성의 역수 비율) 합계 60%를 나눠 든다. 한 종목 30% 상한, 넘친 몫과 자료 없는 몫은 단기채권 ETF로. (2026-11-24 사전 등록)',
  decide(ctx) {
    if (!monthly(ctx)) return null;
    const p = ctx.params;
    const vols = [];
    for (const sym of ['069500', '148070', '132030']) {
      const v = realizedVol(ctx.closes(sym, p.volN + 2), p.volN, 252);
      if (Number.isFinite(v) && v > 0) vols.push({ sym, v });
    }
    const targets = {}, reasons = {};
    const inv = vols.reduce((a, x) => a + 1 / x.v, 0);
    const avail = p.total * (vols.length / 3); // 자료 없는 종목의 몫(1/3)은 다른 종목에 나누지 않고 단기채권으로
    let eq = 0;
    for (const x of vols) {
      const w = Math.min(p.cap, (avail * (1 / x.v)) / inv);
      targets[x.sym] = w; eq += w;
      reasons[x.sym] = `${symName(x.sym)}: 최근 변동성 연 ${Math.round(x.v * 100)}% → 비중 ${Math.round(w * 100)}% (변동성 역수, 월간 조정)`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

// 7) 영구 포트폴리오 (공개 2027-02-20)
const PP = { '069500': 0.25, '148070': 0.25, '132030': 0.25, [BOND]: 0.25 };
export const etfPermanentV1 = {
  id: 'etf_permanent_v1', family: 'etf_permanent', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2027-02-20', candidate: true,
  name: '후보: 영구 포트폴리오 4분할 (매월)', market: 'krx', timeframe: '1d',
  universe: ['069500', '148070', '132030', BOND], benchSym: '069500',
  params: { weights: PP }, grid: null,
  get lookback() { return 20; },
  risk: { maxPositionWeight: 0.30, minCash: 0, dailyLossLimit: 0.03, weeklyLossLimit: 0.06, maxDrawdownHalt: 0.20 },
  description: '타이밍 없이 국내주식(KODEX 200)·장기채(국고채10년)·금(골드선물)·단기채권을 25%씩 들고 매월 첫 거래일에 비율을 다시 맞춘다. 자료가 없는 종목의 몫은 단기채권으로(위험 한도 30%를 넘는 몫은 현금). (2026-11-24 사전 등록)',
  decide(ctx) {
    if (!monthly(ctx)) return null;
    const w = ctx.params.weights;
    const targets = {}, reasons = {};
    let toBond = 0;
    for (const [sym, x] of Object.entries(w)) {
      if (sym === BOND) continue;
      if (ctx.closes(sym, 1).length) { targets[sym] = x; reasons[sym] = `${symName(sym)}: 고정 비율 ${Math.round(x * 100)}% (월간 조정)`; }
      else { toBond += x; reasons[sym] = `${symName(sym)}: 아직 시세 자료가 없어 이 몫은 단기채권으로`; }
    }
    targets[BOND] = w[BOND] + toBond;
    reasons[BOND] = `단기채권: 고정 비율 ${Math.round(w[BOND] * 100)}%${toBond ? ` + 자료 없는 종목 몫 ${Math.round(toBond * 100)}%` : ''}`;
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

// 8) 주식·채권·금 절대 모멘텀 (공개 2027-03-06)
export const etfAbsMom3V1 = {
  id: 'etf_absmom3_v1', family: 'etf_absmom3', version: 1, cadence: 'slow', priorTrials: 0,
  releaseDate: '2027-03-06', candidate: true,
  name: '후보: 주식·채권·금 12개월 절대 모멘텀 (매월)', market: 'krx', timeframe: '1d',
  universe: ['069500', '148070', '132030', BOND], benchSym: '069500',
  params: { lookback: 252, weight: 0.20 }, grid: null,
  get lookback() { return 262; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 KODEX 200·국고채10년·골드선물(H) 각각의 최근 12개월 수익을 단기채권 ETF의 12개월 수익과 비교해, 더 높은 것만 20%씩 든다. 나머지 몫은 단기채권 ETF로. (2026-11-24 사전 등록)',
  decide(ctx) {
    if (!monthly(ctx)) return null;
    const n = ctx.params.lookback;
    const bc = ctx.closes(BOND, n + 1);
    const rb = bc.length > n ? roc(bc, n) : 0;
    const targets = {}, reasons = {};
    let eq = 0;
    for (const sym of ['069500', '148070', '132030']) {
      const c = ctx.closes(sym, n + 1);
      if (c.length <= n) { reasons[sym] = `${symName(sym)}: 12개월 수익을 낼 자료가 아직 모자라 쉼`; continue; }
      const r = roc(c, n);
      if (r > rb) { targets[sym] = ctx.params.weight; eq += ctx.params.weight; reasons[sym] = `${symName(sym)}: 12개월 수익 ${Math.round(r * 100)}%가 단기채권(${Math.round(rb * 100)}%)보다 높음 → ${Math.round(ctx.params.weight * 100)}%`; }
      else reasons[sym] = `${symName(sym)}: 12개월 수익 ${Math.round(r * 100)}%가 단기채권보다 낮음 → 이 몫은 단기채권으로`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

export const CANDIDATES = [etfGoldTrendV1, etfQualityLowvolV1, etfAllweatherV1, etfDevTrendV1, etfStockBondTrendV1, etfInvVol3V1, etfPermanentV1, etfAbsMom3V1];

// ---------------- 3차 사전 등록: 규칙 문법 순서표 (2026-11-24 #F-009 ③, 결과 보기 전) ----------------
// 12-15 뒤 새 후보를 '코드를 새로 쓰지 않고' 공급하려고, 이미 쓰는 부품 4개(추세 거름·상대 모멘텀·변동성 역수·고정 비율)와
// 10년 넘는 자료가 있는 종목 묶음 6개의 조합을 순서표로 고정한다. 앞 8개 후보와 사실상 같은 조합 4개는 뺐다(20개).
// 공개는 2027-03-20부터 2주 간격(앞 대기열 끝 03-06 다음). 판정은 앞 후보와 똑같이 한 번, 판정마다 연구실 시도 수 +1.
// 숫자(200일 평균·126일 모멘텀·60일 변동성·합계 60%·종목 30%)는 모두 앞 후보·기존 전략에서 쓰는 값 그대로 — 새로 고른 숫자가 없다.
// 이 표는 결과를 보기 전에 고정했다: 바꾸려면 새 이름(v2)·새 시도. backtest/CANDIDATES-PREREG.md '3차'.
export const GRAMMAR_SETS = Object.freeze({
  stockbond: ['069500', '148070'],
  stockgold: ['069500', '132030'],
  sbg3: ['069500', '148070', '132030'],
  lowvoldiv: ['174350', '161510', '148070'],
  kdevgold: ['069500', '251350', '132030'],
  kdevbg4: ['069500', '251350', '148070', '132030'],
});
const SET_KO = { stockbond: '국내주식·국고채', stockgold: '국내주식·금', sbg3: '국내주식·국고채·금', lowvoldiv: '로우볼·고배당·국고채', kdevgold: '국내주식·선진국·금', kdevbg4: '국내주식·선진국·국고채·금' };
export const GRAMMAR_METHODS = Object.freeze(['trend', 'mom', 'ivol', 'fixq']);
const METHOD_KO = { trend: '각각 200일선 추세 (매월)', mom: '6개월 상대 모멘텀 상위 + 단기채권 비교 (매월)', ivol: '200일선 위 종목만 변동성 역수 비중 (매월)', fixq: '같은 비율 고정 (분기)' };
// 순서표(바꾸지 않음): [방법, 묶음] — 방법·묶음이 번갈아 나오게 미리 정한 순서
export const GRAMMAR_ORDER = Object.freeze([
  ['trend', 'stockgold'], ['mom', 'lowvoldiv'], ['ivol', 'kdevgold'], ['fixq', 'kdevbg4'], ['mom', 'stockbond'],
  ['ivol', 'stockgold'], ['trend', 'lowvoldiv'], ['fixq', 'kdevgold'], ['mom', 'kdevbg4'], ['trend', 'sbg3'],
  ['ivol', 'stockbond'], ['fixq', 'stockgold'], ['ivol', 'lowvoldiv'], ['trend', 'kdevgold'], ['ivol', 'kdevbg4'],
  ['fixq', 'stockbond'], ['mom', 'stockgold'], ['fixq', 'lowvoldiv'], ['mom', 'kdevgold'], ['trend', 'kdevbg4'],
]);
export const GRAMMAR_FIRST_RELEASE = '2027-03-20';
const GP = Object.freeze({ sma: 200, momN: 126, volN: 60, total: 0.60, cap: 0.30 });
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const quarterly = (ctx) => !(quarterOf(ctx.t) === ctx.mem.q && ctx.barIndex > 0);

/** 상대 모멘텀: 최근 momN일 수익 상위 k개(묶음 크기 2면 1개, 그 밖 2개), 그중 단기채권 수익보다 높은 것만 각 min(30%, 60%/k). 나머지 몫은 단기채권(30% 상한). */
function momBook(ctx, syms, p) {
  const k = syms.length <= 2 ? 1 : 2, w = Math.min(p.cap, p.total / k);
  const bc = ctx.closes(BOND, p.momN + 1);
  const rb = bc.length > p.momN ? roc(bc, p.momN) : 0;
  const ranked = [], targets = {}, reasons = {};
  for (const sym of syms) {
    const c = ctx.closes(sym, p.momN + 1);
    if (c.length <= p.momN) { reasons[sym] = `${symName(sym)}: 6개월 수익을 낼 자료가 아직 모자라 쉼`; continue; }
    ranked.push({ sym, r: roc(c, p.momN) });
  }
  ranked.sort((a, b) => b.r - a.r || (a.sym < b.sym ? -1 : 1));
  let eq = 0;
  for (const [i, x] of ranked.entries()) {
    if (i < k && x.r > rb) { targets[x.sym] = w; eq += w; reasons[x.sym] = `${symName(x.sym)}: 6개월 수익 ${Math.round(x.r * 100)}% (상위 ${i + 1}위, 단기채권 ${Math.round(rb * 100)}%보다 높음) → ${Math.round(w * 100)}%`; }
    else reasons[x.sym] = `${symName(x.sym)}: 6개월 수익 ${Math.round(x.r * 100)}% → ${i < k ? '단기채권보다 낮아 이 몫은 단기채권으로' : `상위 ${k}개 밖`}`;
  }
  const bond = Math.min(p.cap, k * w - eq);
  if (bond > 0.02) { targets[BOND] = bond; reasons[BOND] = '고르지 못한 몫은 단기채권 ETF에 보관 (현금 대용)'; }
  return { targets, reasons, mem: { month: monthOf(ctx.t) } };
}
/** 변동성 역수(200일 평균 위 종목만): 합계 60% 중 거른 종목 몫만큼만 나눠 든다(종목 30% 상한). 나머지는 단기채권(30% 상한). */
function ivolBook(ctx, syms, p) {
  const ok = [], targets = {}, reasons = {};
  for (const sym of syms) {
    const c = ctx.closes(sym, p.sma + 1);
    const v = realizedVol(ctx.closes(sym, p.volN + 2), p.volN, 252);
    if (c.length < p.sma || !(Number.isFinite(v) && v > 0)) { reasons[sym] = `${symName(sym)}: 200일 평균·변동성을 낼 자료가 아직 모자라 이 몫은 단기채권으로`; continue; }
    if (c[c.length - 1] > sma(c, p.sma)) ok.push({ sym, v });
    else reasons[sym] = `${symName(sym)}: 200일 평균 아래 → 이 몫은 단기채권으로`;
  }
  const inv = ok.reduce((a, x) => a + 1 / x.v, 0), avail = p.total * (ok.length / syms.length);
  let eq = 0;
  for (const x of ok) {
    const w = Math.min(p.cap, (avail * (1 / x.v)) / inv);
    targets[x.sym] = w; eq += w;
    reasons[x.sym] = `${symName(x.sym)}: 200일 평균 위, 최근 변동성 연 ${Math.round(x.v * 100)}% → 비중 ${Math.round(w * 100)}% (변동성 역수)`;
  }
  bondFill(targets, reasons, eq);
  return { targets, reasons, mem: { month: monthOf(ctx.t) } };
}
/** 같은 비율 고정(분기 첫 거래일): 종목마다 min(30%, 60%/n), 자료 없는 종목 몫은 단기채권(30% 상한). 타이밍 없음. */
function fixBook(ctx, syms, p) {
  const w = Math.min(p.cap, p.total / syms.length), targets = {}, reasons = {};
  let eq = 0;
  for (const sym of syms) {
    if (ctx.closes(sym, 1).length) { targets[sym] = w; eq += w; reasons[sym] = `${symName(sym)}: 고정 비율 ${Math.round(w * 100)}% (분기 조정)`; }
    else reasons[sym] = `${symName(sym)}: 아직 시세 자료가 없어 이 몫은 단기채권으로`;
  }
  bondFill(targets, reasons, eq);
  return { targets, reasons, mem: { q: quarterOf(ctx.t) } };
}
function grammarCandidate([method, set], i) {
  const syms = GRAMMAR_SETS[set];
  const id = `gen_${method}_${set}_v1`;
  const n = syms.length, wEach = Math.round(Math.min(GP.cap, GP.total / n) * 100);
  const desc = {
    trend: `매월 첫 거래일에 ${syms.map(symName).join('·')} 각각 가격이 200일 평균 위면 ${wEach}%, 아래면 그 몫을 단기채권 ETF로.`,
    mom: `매월 첫 거래일에 ${syms.map(symName).join('·')} 중 최근 6개월(126거래일) 수익이 높은 ${n <= 2 ? 1 : 2}개를 고르고, 그 수익이 단기채권보다 높을 때만 든다. 나머지 몫은 단기채권 ETF로.`,
    ivol: `매월 첫 거래일에 ${syms.map(symName).join('·')} 중 200일 평균 위인 것만 최근 60거래일 변동성의 역수 비율로 나눠 든다(합계 최대 60%, 한 종목 30%). 나머지 몫은 단기채권 ETF로.`,
    fixq: `타이밍 없이 ${syms.map(symName).join('·')}를 ${wEach}%씩 들고 분기 첫 거래일에 비율을 다시 맞춘다. 남는 몫은 단기채권 ETF로.`,
  }[method];
  const book = { trend: (ctx) => trendBook(ctx, syms, { sma: GP.sma, weight: Math.min(GP.cap, GP.total / n) }), mom: (ctx) => momBook(ctx, syms, GP), ivol: (ctx) => ivolBook(ctx, syms, GP), fixq: (ctx) => fixBook(ctx, syms, GP) }[method];
  return {
    id, family: id.replace(/_v1$/, ''), version: 1, cadence: 'slow', priorTrials: 0,
    releaseDate: addDays(GRAMMAR_FIRST_RELEASE, 14 * i), candidate: true, grammar: { method, set, order: i + 1 },
    name: `후보: ${SET_KO[set]} ${METHOD_KO[method]}`, market: 'krx', timeframe: '1d',
    universe: [...syms, BOND], benchSym: syms[0],
    params: { ...GP }, grid: null,
    lookback: { trend: 230, mom: 136, ivol: 230, fixq: 20 }[method],
    risk: ETF_RISK,
    description: `${desc} (2026-11-24 규칙 문법 순서표 ${i + 1}번 — 코드 새로 안 씀, 숫자는 앞 후보와 같음)`,
    decide(ctx) { return (method === 'fixq' ? quarterly(ctx) : monthly(ctx)) ? book(ctx) : null; },
  };
}
export const GRAMMAR_CANDIDATES = GRAMMAR_ORDER.map(grammarCandidate);
/** 대기열 전체(앞 8개 + 순서표 20개). 판정·공개·Worker 등록은 모두 이 목록으로. */
export const ALL_CANDIDATES = [...CANDIDATES, ...GRAMMAR_CANDIDATES];
export const candidateById = Object.fromEntries(ALL_CANDIDATES.map((s) => [s.id, s]));

/** KST 자정 기준 공개 시각(unix 초). releaseDate 'YYYY-MM-DD' 는 한국 날짜. */
export const releaseAt = (s) => Date.parse(`${s.releaseDate}T00:00:00+09:00`) / 1000;

/** Worker 쪽: kv 'candidates:released' = [{id, releasedAt}] 중 코드에 있는 후보만 전략으로. 현재 시각을 보지 않는다. */
export function candidateStrategies(released, taken = new Set()) {
  const out = [];
  for (const r of Array.isArray(released) ? released : []) {
    const s = candidateById[r?.id];
    if (s && !taken.has(s.id) && !out.some((x) => x.id === s.id)) out.push({ ...s, releasedAt: Number(r.releasedAt) || null });
  }
  return out;
}
