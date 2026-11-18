// 2026-11-18 연구실 발전 묶음: 새 후보 전략 3개 + 레버리지 비교 장부 2개 + AI 단독 비교 장부 2개.
// 전부 가상 돈(모의)만. 실제 주문·선물 거래 기능 없음. 모의 장부는 등록 뒤 첫 봉부터 앞으로만 기록(처음 보는 자료).
import { sma, roc } from '../core/indicators.js';
import { symName } from '../config.js';
import { realizedVol, isLastKrxDayOfWeek, monthOf, pct } from './common.js';
import { btcPerpSimV1 } from './futures-sim.js';

const ETF_RISK = { maxPositionWeight: 0.30, minCash: 0.40, dailyLossLimit: 0.02, weeklyLossLimit: 0.04, maxDrawdownHalt: 0.20 };
const COIN_RISK = { maxPositionWeight: 0.60, minCash: 0.40, dailyLossLimit: 0.02, weeklyLossLimit: 0.04, maxDrawdownHalt: 0.30 };
const EQ = ['278530', '379800'];
const BOND = '153130';
const bondFill = (targets, reasons, eq) => {
  const bond = Math.max(0, Math.min(0.30, 0.60 - eq));
  if (bond > 0.02) { targets[BOND] = bond; reasons[BOND] = '쉬는 돈은 단기채권 ETF에 보관 (현금 대용)'; }
};
/** First bar of a new month (decision day for monthly strategies). */
const newMonth = (ctx) => monthOf(ctx.t) !== ctx.mem.month;

// ---------------- E) 변동성 목표 조절 (추세 필터 없음) ----------------
// 널리 알려진 규칙: 위험(변동성)이 커지면 덜 들고, 작아지면 더 든다(Moreira & Muir 2017, "volatility-managed portfolios").
export const etfVolTargetV1 = {
  id: 'etf_voltarget_v1', family: 'etf_voltarget', version: 1, cadence: 'slow', priorTrials: 0,
  name: 'E. ETF 변동성 목표 조절 (매월)', market: 'krx', timeframe: '1d',
  universe: ['278530', '379800', BOND], benchSym: '278530',
  params: { target: 0.08, volN: 60 }, grid: null,
  get lookback() { return 70; },
  risk: ETF_RISK,
  description: '추세는 보지 않고, 최근 60거래일 흔들림(변동성)만 본다. 두 지수 ETF(KODEX 200TR·미국S&P500TR)를 각각 목표 변동성 연 8%의 절반씩 맞춰 들고(흔들릴수록 적게), 남는 돈은 단기채권 ETF. 매월 첫 거래일에만 조정.',
  decide(ctx) {
    if (!newMonth(ctx) && ctx.barIndex > 0) return null;
    const p = ctx.params;
    const targets = {}, reasons = {};
    let eq = 0;
    for (const sym of EQ) {
      const v = realizedVol(ctx.closes(sym, p.volN + 2), p.volN, 252);
      if (!Number.isFinite(v) || v <= 0) continue;
      const w = Math.min(0.30, (p.target / 2) / v);
      targets[sym] = w; eq += w;
      reasons[sym] = `${symName(sym)}: 최근 변동성 연 ${Math.round(v * 100)}% → 비중 ${Math.round(w * 100)}% (목표 변동성 맞춤, 월간 조정)`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

// ---------------- F) 추세 + 현금 전환: 듀얼 모멘텀 ----------------
// 널리 알려진 규칙(Antonacci, Global Equities Momentum): 12개월 수익이 단기채권보다 높은 지수만 들고, 아니면 채권으로.
export const etfDualMomV1 = {
  id: 'etf_dualmom_v1', family: 'etf_dualmom', version: 1, cadence: 'slow', priorTrials: 0,
  name: 'F. ETF 듀얼 모멘텀 (12개월, 매월)', market: 'krx', timeframe: '1d',
  universe: ['278530', '379800', BOND], benchSym: '278530',
  params: { lookback: 252 }, grid: null,
  get lookback() { return 262; },
  risk: ETF_RISK,
  description: '매월 첫 거래일에 두 지수 ETF의 최근 12개월 수익을 단기채권 ETF의 12개월 수익과 비교한다. 채권보다 높고 플러스인 지수만 30%씩 들고, 아니면 단기채권으로 피신(추세 + 현금 전환).',
  decide(ctx) {
    if (!newMonth(ctx) && ctx.barIndex > 0) return null;
    const n = ctx.params.lookback;
    const bc = ctx.closes(BOND, n + 1);
    const rb = bc.length > n ? roc(bc, n) : 0;
    const targets = {}, reasons = {};
    let eq = 0;
    for (const sym of EQ) {
      const c = ctx.closes(sym, n + 1);
      if (c.length <= n) continue;
      const r = roc(c, n);
      if (r > Math.max(0, rb)) { targets[sym] = 0.30; eq += 0.30; reasons[sym] = `${symName(sym)}: 12개월 수익 ${pct(r)} > 단기채권 ${pct(rb)} → 보유`; }
      else if ((ctx.weights[sym] || 0) > 0) reasons[sym] = `${symName(sym)}: 12개월 수익 ${pct(r)} ≤ 단기채권 ${pct(rb)} → 채권으로 전환`;
    }
    bondFill(targets, reasons, eq);
    return { targets, reasons, mem: { month: monthOf(ctx.t) } };
  },
};

// ---------------- G) 코인 일봉 변동성 돌파 ----------------
// 래리 윌리엄스 변동성 돌파를 일봉으로: 오늘 종가가 오늘 시가 + 어제 변동폭×k 위 + 비트코인 100일선 위 → 다음 날 시가 매수.
// 진입일 저가 아래로 마감하거나 5일이 지나면 정리. 크기는 목표 변동성(연 30%).
export const cryptoVolBrkDV1 = {
  id: 'crypto_volbrk_d_v1', family: 'crypto_volbrk_d', version: 1, cadence: 'fast',
  priorTrials: 1, // 같은 아이디어의 1시간봉판(vol_breakout_v1)이 이미 있음
  name: 'G. 비트·이더 일봉 변동성 돌파', market: 'crypto', timeframe: '1d',
  universe: ['KRW-BTC', 'KRW-ETH'], benchSym: 'KRW-BTC',
  params: { k: 0.5, filterSma: 100, maxHold: 5, volTarget: 0.30, volN: 20 }, grid: null,
  get lookback() { return 110; },
  risk: COIN_RISK,
  description: '하루 동안 크게 올라(종가 > 시가 + 어제 고가-저가 폭×0.5) 마감하고 비트코인이 100일 평균 위면 다음 날 아침 산다. 진입한 날의 저가 아래로 마감하거나 5일이 지나면 판다. 크기는 목표 변동성 연 30%(코인당 최대 30%).',
  decide(ctx) {
    const p = ctx.params;
    const btc = ctx.closes('KRW-BTC', p.filterSma + 1);
    if (btc.length < p.filterSma) return null;
    const up = btc[btc.length - 1] > sma(btc, p.filterSma);
    const mem = { e: { ...(ctx.mem.e || {}) } };
    const targets = {}, reasons = {};
    let changed = false;
    for (const sym of ctx.universe) {
      const bars = ctx.history(sym, p.volN + 3);
      if (bars.length < p.volN + 2) continue;
      const today = bars[bars.length - 1], prev = bars[bars.length - 2];
      const held = (ctx.positions[sym] || 0) > 0;
      if (held) {
        const e = mem.e[sym] || { bar: ctx.barIndex, low: today.l };
        const age = ctx.barIndex - e.bar;
        if (today.c < e.low || age >= p.maxHold) {
          targets[sym] = 0; delete mem.e[sym]; changed = true;
          reasons[sym] = `${symName(sym)}: ${today.c < e.low ? '돌파한 날의 저가 아래로 마감' : `${p.maxHold}일 경과`} → 정리`;
        } else targets[sym] = ctx.weights[sym];
        continue;
      }
      if (!up) continue;
      const trigger = today.o + p.k * (prev.h - prev.l);
      if (today.c > trigger) {
        const v = realizedVol(bars.map((b) => b.c), p.volN, 365);
        const w = Math.min(0.30, Number.isFinite(v) && v > 0 ? p.volTarget / v : 0.30);
        targets[sym] = w; mem.e[sym] = { bar: ctx.barIndex + 1, low: today.l }; changed = true;
        reasons[sym] = `${symName(sym)}: 종가가 시가+어제 변동폭×${p.k}(${Math.round(trigger).toLocaleString('ko-KR')}원) 돌파 + 비트코인 ${p.filterSma}일선 위 → 매수 ${Math.round(w * 100)}%`;
      }
    }
    if (!changed) return { mem };
    for (const s of Object.keys(ctx.positions)) if (!(s in targets) && ctx.positions[s] > 0) targets[s] = ctx.weights[s];
    return { targets, reasons, mem };
  },
};

// ---------------- 레버리지 비교 장부 (모의 전용·선물 시뮬레이션) ----------------
// 같은 규칙(btc_perp_sim_v1, 2배)을 1배·3배로. 공격형 슬롯 합계에는 넣지 않는다(비교용 장부의 청산이 슬롯 전체를 멈추지 않게).
function perpAt(lev) {
  return {
    ...btcPerpSimV1,
    id: `btc_perp_lev${lev}_v1`, family: `btc_perp_lev${lev}`, version: 1, priorTrials: 0,
    sleeve: null, leverageCompare: lev, researchOnly: true, simulationOnly: true,
    name: `레버리지 비교: BTC 선물 추세 ${lev}배 (모의 전용·선물 시뮬레이션)`,
    params: { ...btcPerpSimV1.params, leverage: lev },
    description: btcPerpSimV1.description.replace('최대 2배', `${lev}배`).replace(', 2배', `, ${lev}배`) + ` (레버리지 비교 장부: 같은 규칙을 ${lev}배로. 가격이 증거금 한도를 넘으면 강제 청산 = 그 증거금 전액 손실.)`,
  };
}
export const btcPerpLev1V1 = perpAt(1);
export const btcPerpLev3V1 = perpAt(3);

// ---------------- AI 단독 비교 장부 ----------------
// AI 점수(-1..+1)만 보고 비중을 정한다. 규칙 장부(A·C)와 같은 종목·같은 판단 주기·같은 위험 한도·같은 비용 → 공정 비교.
// 과거 시점의 AI 판단이 없어서 백테스트가 불가능 → noBacktest(모의 기록만으로 비교, 운영 점검 대상 아님).
// AI 결과가 없으면(실패·누락) 새로 사지 않고 지금 비중을 그대로 둔다(fail-closed, 강제 매도 없음).
export const aiSoloWeight = (score) => (score >= 0.3 ? 0.30 : score >= 0 ? 0.15 : 0);
function aiSolo({ id, name, market, universe, benchSym, risk, weekly, bond }) {
  return {
    id, family: id.replace(/_v\d+$/, ''), version: 1, cadence: 'slow', priorTrials: 0,
    researchOnly: true, noBacktest: true, usesSignals: true, aiSolo: true,
    name, market, timeframe: '1d', universe, benchSym, params: {}, grid: null, lookback: 5, risk,
    description: `AI 단독 비교 장부. 6시간마다 AI(무료 모델)가 가격 구조·변동성·시장 폭·뉴스 제목을 읽고 매긴 종목 점수만으로 비중을 정한다: 점수 0.3 이상이면 30%, 0~0.3이면 15%, 마이너스면 0%. ${weekly ? '판단은 주 1회(그 주 마지막 거래일), 규칙 장부 A와 같은 주기' : '판단은 매일, 규칙 장부 C와 같은 주기'}. AI 결과가 없으면 새로 사지 않음. 과거 AI 판단 기록이 없어 백테스트는 불가 → 처음 보는 자료로만 비교.`,
    decide(ctx) {
      if (!ctx.signals?.aiRequired) return null; // AI 미설정 = 아무것도 안 함
      if (weekly && !isLastKrxDayOfWeek(ctx.t) && ctx.barIndex > 0) return null;
      const targets = {}, reasons = {};
      let eq = 0;
      for (const sym of universe.filter((s) => s !== bond)) {
        const a = ctx.signals.ai?.[sym];
        const cur = ctx.weights[sym] || 0;
        if (!a) { targets[sym] = cur; eq += cur; reasons[sym] = `${symName(sym)}: AI 결과 없음 → 새로 사지 않고 그대로`; continue; }
        const w = aiSoloWeight(a.score);
        targets[sym] = w; eq += w;
        reasons[sym] = `${symName(sym)}: AI 점수 ${a.score.toFixed(2)} → 비중 ${Math.round(w * 100)}%${a.reason ? ` (${a.reason})` : ''}`;
      }
      if (bond) bondFill(targets, reasons, eq);
      return { targets, reasons };
    },
  };
}
export const aiSoloEtfV1 = aiSolo({ id: 'ai_solo_etf_v1', name: 'AI 단독: ETF (A와 같은 종목·주기)', market: 'krx', universe: ['278530', '379800', BOND], benchSym: '278530', risk: ETF_RISK, weekly: true, bond: BOND });
export const aiSoloCryptoV1 = aiSolo({ id: 'ai_solo_crypto_v1', name: 'AI 단독: 비트·이더 (C와 같은 종목·주기)', market: 'crypto', universe: ['KRW-BTC', 'KRW-ETH'], benchSym: 'KRW-BTC', risk: COIN_RISK, weekly: false, bond: null });

export const LAB_20261118 = [etfVolTargetV1, etfDualMomV1, cryptoVolBrkDV1, btcPerpLev1V1, btcPerpLev3V1, aiSoloEtfV1, aiSoloCryptoV1];
