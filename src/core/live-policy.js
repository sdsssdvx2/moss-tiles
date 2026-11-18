// FUTURE live-module policy (data model + pure rules only).
// Nothing in this repository sends orders. These rules are evaluated today against the
// PAPER ("shadow") results of strategies that reached 운영 점검 통과(실력 증명 아님), so the kill switch
// is exercised and tested long before any real money is involved.
// Defaults: RESEARCH-STRATEGY-KO.md 5-2 (G3/G4) and 5-3.
import { GATE_DEFAULTS } from './lifecycle.js';
import { DAY } from './calendar.js';

/** Initial live budget per strategy (KRW), respecting the account total cap. */
export function initialLiveBudget(market, alreadyAllocatedKrw = 0, rules = GATE_DEFAULTS.live) {
  const want = rules.budgetKrw[market];
  const krw = Math.max(0, Math.min(want, rules.accountMaxKrw - alreadyAllocatedKrw));
  return { krw, step: 0, status: krw > 0 ? 'eligible' : 'waiting_budget' };
}

/**
 * Step-up rule (x2) after N weeks with no kill, small live-vs-paper drift and a new equity high.
 * @param s {market, krw, step, liveWeeks, killed, driftPerMonth, atNewHigh}
 */
export function nextLiveBudget(s, rules = GATE_DEFAULTS.live) {
  if (s.killed) return { krw: 0, step: s.step, reason: '자동 중단 규칙 발동 → 실거래 예산 0, 모의로 복귀' };
  const u = rules.stepUp;
  const weeksNeeded = u.afterWeeks[s.market] * (s.step + 1);
  if (s.liveWeeks >= weeksNeeded && Math.abs(s.driftPerMonth ?? 0) <= u.maxDriftPerMonth && (!u.requireNewHigh || s.atNewHigh)) {
    return { krw: Math.floor(s.krw * u.factor), step: s.step + 1, reason: `${s.liveWeeks}주 무사고 + 모의와 차이 작음 + 새 고점 → 예산 ${u.factor}배` };
  }
  return { krw: s.krw, step: s.step, reason: '유지' };
}

/**
 * Strategy kill switch.
 * @param points equity points since promotion/live start (ascending)
 * @param fills fills in the same period (ascending)
 * @param o {market, backtestMdd?, driftPct?}
 */
export function liveKillSwitch(points, fills = [], o = {}, rules = GATE_DEFAULTS.live.kill) {
  const market = o.market || 'krx';
  let ddLimit = rules.maxDrawdown[market];
  if (o.backtestMdd > 0) ddLimit = Math.min(ddLimit, o.backtestMdd * rules.maxDrawdownVsBacktest);
  let peak = -Infinity, mdd = 0;
  for (const p of points || []) { peak = Math.max(peak, p.equity); if (peak > 0) mdd = Math.max(mdd, 1 - p.equity / peak); }
  if (mdd >= ddLimit) return { kill: true, reason: `고점 대비 ${Math.round(mdd * 1000) / 10}% 하락 (한도 ${Math.round(ddLimit * 1000) / 10}%)`, mdd };
  let streak = 0, maxStreak = 0;
  for (const f of fills) if (f.phase ? f.phase === 'exit' : f.side === 'SELL') { streak = f.pnl < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  if (maxStreak > rules.maxConsecutiveLosses) return { kill: true, reason: `${maxStreak}번 연속 손실 매도 (한도 ${rules.maxConsecutiveLosses}번)`, mdd };
  if (o.driftPct != null && Math.abs(o.driftPct) > rules.maxDrift) return { kill: true, reason: `실거래와 모의 수익 차이 ${Math.round(o.driftPct * 1000) / 10}%p (한도 ${rules.maxDrift * 100}%p)`, mdd };
  return { kill: false, mdd, streak: maxStreak };
}

/** Account-level guard (daily -2%, weekly -4%, total -8%). */
export function accountGuard(points, rules = GATE_DEFAULTS.live.kill.account) {
  if (!points?.length) return { blockBuys: false, stopAll: false };
  const last = points[points.length - 1];
  const day = Math.floor(last.t / DAY), wk = Math.floor((last.t / DAY + 3) / 7);
  const dayStart = [...points].reverse().find((p) => Math.floor(p.t / DAY) < day)?.equity ?? points[0].equity;
  const weekStart = [...points].reverse().find((p) => Math.floor((p.t / DAY + 3) / 7) < wk)?.equity ?? points[0].equity;
  const peak = Math.max(...points.map((p) => p.equity));
  const dr = last.equity / dayStart - 1, wr = last.equity / weekStart - 1, tr = 1 - last.equity / peak;
  if (tr >= rules.total) return { blockBuys: true, stopAll: true, reason: `계좌 고점 대비 -${Math.round(tr * 1000) / 10}% → 모든 전략 자동 중지(다시 시작은 기준을 처음부터 다시 통과해야 함)` };
  if (wr <= -rules.weekly) return { blockBuys: true, stopAll: false, reason: `이번 주 ${Math.round(wr * 1000) / 10}% → 이번 주 신규 매수 중지` };
  if (dr <= -rules.daily) return { blockBuys: true, stopAll: false, reason: `오늘 ${Math.round(dr * 1000) / 10}% → 오늘 신규 매수 중지` };
  return { blockBuys: false, stopAll: false };
}
