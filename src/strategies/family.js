// 가족 장부 (PC 프로그램 FamilyInvest 1.1의 규칙을 그대로 옮긴 것, 2026-11-18 통합).
// 본인 10만 원 / 어머니 100만 원 두 장부. 가상 돈만, 주문 기능 없음.
// 원본: FamilyInvest app/autopilot.py signal_for(), update_profile(), PROFILES.
//   매수 후보: 종가 > 60일선, 20일선 > 60일선, 60일 수익률 > 2.5%, 20일 변동성(일간 로그수익 표준편차) ≤ 3.5%
//   그 외에는 보유분 매도. 전일 대비 ±6% 급변이면 그날은 새로 사지 않음(보유는 유지).
//   하루 한 종목만 새로 산다(점수 = 100×(60일 수익률 − 3×변동성) 높은 순), 이미 가진 종목은 더 사지 않음,
//   매도 후 10거래일 안에는 같은 종목을 다시 사지 않음.
//   투자 상한(현금 제외 비율)과 종목당 상한, 고점 대비 손실 한도는 장부마다 다르다.
// 차이(연구실 엔진에 맞춘 부분): 위험중단 뒤 원본은 사람이 풀 때까지 멈추지만, 여기서는 20거래일 대기 후
// 모의 검증을 처음부터 다시 시작한다. 체결 가정(다음 거래일 시가 + 미끄러짐 0.05% + 수수료 0.015%)은 같다.
import { sma } from '../core/indicators.js';
import { createState } from '../core/engine.js';
import { symName } from '../config.js';

const SYMS = ['379800', '278530'];

/** FamilyInvest signal_for() 이식: closes = 최근 종가(마지막이 오늘). */
export function familySignal(closes) {
  if (closes.length < 65) return ['WAIT', 0, '과거 데이터 65거래일 미만'];
  const n = closes.length;
  const sma20 = sma(closes.slice(-20), 20), sma60 = sma(closes.slice(-60), 60);
  const ch = [];
  for (let i = n - 19; i < n; i++) ch.push(Math.log(closes[i] / closes[i - 1]));
  const mean = ch.reduce((a, b) => a + b, 0) / ch.length;
  const vol = Math.sqrt(ch.reduce((a, b) => a + (b - mean) ** 2, 0) / ch.length); // population stdev (원본과 같음)
  const p = (x) => `${(x * 100).toFixed(1)}%`;
  if (!Number.isFinite(vol) || vol > 0.035) return ['SELL', -100, `20일 변동성 ${(vol * 100).toFixed(2)}%가 보수적 한도(3.5%) 초과`];
  if (Math.abs(closes[n - 1] / closes[n - 2] - 1) > 0.06) return ['WAIT', 0, '전일 급등락(±6% 초과): 신규 매수 판단 보류'];
  const mom = closes[n - 1] / closes[n - 61] - 1;
  const score = Math.round(100 * (mom - 3 * vol) * 1000) / 1000;
  if (closes[n - 1] > sma60 && sma20 > sma60 && mom > 0.025) return ['BUY', score, `종가가 60일선 위, 20일선 상승 추세; 60일 수익률 ${p(mom)} / 일간 변동성 ${p(vol)}`];
  return ['SELL', score, `상승 추세 조건 미달(매수하지 않음), 60일 수익률 ${p(mom)}`];
}

function makeFamily({ id, who, cash, maxTotal, maxAsset, drawdown }) {
  return {
    id, family: id.replace(/_v\d+$/, ''), version: 1, cadence: 'slow', priorTrials: 0, researchOnly: true,
    profile: who, initialCash: cash,
    name: `가족 장부(${who}): ${Math.round(cash / 10000)}만 원 ETF 추세`,
    market: 'krx', timeframe: '1d', universe: SYMS, benchSym: '278530',
    params: {}, grid: null, lookback: 75,
    // minCash = 1 - 투자 상한. 하루·주간 손실 차단은 원본에 없어서 끔. 위험중단 = 고점 대비 손실 한도.
    risk: { maxPositionWeight: maxAsset, minCash: 1 - maxTotal, dailyLossLimit: 0, weeklyLossLimit: 0, maxDrawdownHalt: drawdown, haltCooldownBars: 20, rebalanceBand: 0.5 },
    createState: () => createState(cash),
    description: `PC 프로그램(FamilyInvest)에서 옮긴 ${who} 장부. 가상 ${cash.toLocaleString('ko-KR')}원, 투자 상한 ${Math.round(maxTotal * 100)}%(나머지 현금), 한 종목 최대 ${Math.round(maxAsset * 100)}%, 고점 대비 ${Math.round(drawdown * 100)}% 잃으면 전부 팔고 멈춤. 종가가 60일선 위·20일선>60일선·60일 수익률 2.5% 초과·변동성 낮을 때만 하루 한 종목 산다. 연구용 비교 장부.`,
    decide(ctx) {
      const mem = { exitBar: { ...(ctx.mem.exitBar || {}) } };
      const sig = {};
      for (const s of SYMS) sig[s] = familySignal(ctx.closes(s, 70));
      const held = SYMS.filter((s) => (ctx.positions[s] || 0) > 0);
      const targets = {}, reasons = {};
      let change = false;
      for (const s of held) {
        if (sig[s][0] === 'SELL') { reasons[s] = `${symName(s)}: ${sig[s][2]}`; mem.exitBar[s] = ctx.barIndex; change = true; }
        else targets[s] = ctx.weights[s] || 0; // 보유 유지, 추가 매수 없음
      }
      const invested = Object.values(targets).reduce((a, b) => a + b, 0);
      const room = Math.min(maxAsset, maxTotal - invested);
      const cands = SYMS.filter((s) => !held.includes(s) && sig[s][0] === 'BUY' && !(mem.exitBar[s] != null && ctx.barIndex - mem.exitBar[s] < 10))
        .sort((a, b) => sig[b][1] - sig[a][1]);
      if (cands.length && room > 0.02) {
        const s = cands[0];
        targets[s] = room / 1.025; // 원본처럼 다음 날 시가 상승·수수료 여유 2.5%
        reasons[s] = `${symName(s)}: ${sig[s][2]}`;
        change = true;
      }
      if (!change) return { mem };
      return { targets, reasons, mem };
    },
  };
}

export const familySelfV1 = makeFamily({ id: 'family_self_v1', who: '본인', cash: 100_000, maxTotal: 0.35, maxAsset: 0.35, drawdown: 0.06 });
export const familyMotherV1 = makeFamily({ id: 'family_mother_v1', who: '어머니', cash: 1_000_000, maxTotal: 0.25, maxAsset: 0.20, drawdown: 0.04 });
export const FAMILY_STRATEGIES = [familySelfV1, familyMotherV1];
