// First paper set from RESEARCH-STRATEGY-KO.md section 7 (A, B, C, D).
import { sma, highestPrior, lowestPrior, roc, rsi, atr } from '../core/indicators.js';
import { symName } from '../config.js';
import { volTargetWeight, isLastKrxDayOfWeek, weekday, monthOf, pct } from './common.js';

const ETF_RISK = { maxPositionWeight: 0.30, minCash: 0.40, dailyLossLimit: 0.02, weeklyLossLimit: 0.04, maxDrawdownHalt: 0.20 };
const COIN_RISK = { maxPositionWeight: 0.60, minCash: 0.40, dailyLossLimit: 0.02, weeklyLossLimit: 0.04, maxDrawdownHalt: 0.30 };

// ---------------- A) S1 trend filter + S3 vol target (ETF) ----------------
export const etfTrendV1 = {
  id: 'etf_trend_v1', family: 'etf_trend', version: 1, cadence: 'slow', priorTrials: 0,
  name: 'A. ETF 200일선 추세 + 변동성 조절', market: 'krx', timeframe: '1d',
  universe: ['278530', '379800', '153130'], benchSym: '278530',
  params: { sma: 200, band: 0.01, volTarget: 0.10, volN: 20 }, grid: null,
  get lookback() { return 230; },
  risk: ETF_RISK,
  description: 'KODEX 200TR·미국S&P500TR 가격이 200일 평균보다 1% 넘게 위면 보유, 1% 넘게 아래면 팔고 단기채권 ETF로 피신. 흔들릴수록 적게 산다(목표 변동성 연 10%). 판단은 주 1회(그 주 마지막 거래일).',
  decide(ctx) {
    const p = ctx.params;
    if (!isLastKrxDayOfWeek(ctx.t) && ctx.barIndex > 0) return null;
    const mem = { inMkt: { ...(ctx.mem.inMkt || {}) } };
    const targets = {}, reasons = {};
    let eq = 0;
    for (const sym of ['278530', '379800']) {
      const c = ctx.closes(sym, p.sma + 1);
      if (c.length < p.sma) continue;
      const m = sma(c, p.sma), last = c[c.length - 1];
      let inM = !!mem.inMkt[sym];
      if (!inM && last > m * (1 + p.band)) { inM = true; reasons[sym] = `${symName(sym)}: 가격이 ${p.sma}일 평균보다 ${Math.round(p.band * 100)}% 넘게 위로 올라가서 매수`; }
      else if (inM && last < m * (1 - p.band)) { inM = false; reasons[sym] = `${symName(sym)}: 가격이 ${p.sma}일 평균보다 ${Math.round(p.band * 100)}% 넘게 아래로 내려가서 매도`; }
      mem.inMkt[sym] = inM;
      if (inM) {
        const w = volTargetWeight(ctx.closes(sym, p.volN + 2), { target: p.volTarget, n: p.volN, ppy: 252, cap: 0.30 });
        targets[sym] = w; eq += w;
        if (!reasons[sym]) reasons[sym] = `${symName(sym)}: 상승 추세 유지, 최근 흔들림에 맞춰 비중 ${Math.round(w * 100)}%로 조절`;
      }
    }
    const bond = Math.max(0, Math.min(0.30, 0.60 - eq));
    if (bond > 0.02) { targets['153130'] = bond; reasons['153130'] = '쉬는 돈은 단기채권 ETF에 보관 (현금 대용)'; }
    return { targets, reasons, mem };
  },
};

// ---------------- B) S4 buy-the-dip in an uptrend (ETF) ----------------
export const etfDipV1 = {
  id: 'etf_dip_v1', family: 'etf_dip', version: 1, cadence: 'fast', priorTrials: 0,
  name: 'B. ETF 상승장 눌림목 매수', market: 'krx', timeframe: '1d',
  universe: ['278530', '379800'], benchSym: '278530',
  params: { sma: 200, exitSma: 5, maxHold: 10, stop: 0.08, rsiMax: 10, size: 0.5 }, grid: null,
  get lookback() { return 215; },
  risk: { ...ETF_RISK, maxPositionWeight: 0.50 },
  description: '200일 평균 위(상승장)에서 2~3일 짧게 떨어졌을 때(RSI(2)<10, 3일 연속 하락, 또는 그날 저가 근처 마감) 사고, 5일 평균 위로 회복하거나 10거래일이 지나거나 -8%면 판다. 한 번에 한 종목, 50%.',
  decide(ctx) {
    const p = ctx.params;
    const mem = { entryBar: { ...(ctx.mem.entryBar || {}) } };
    const held = Object.keys(ctx.positions).filter((s) => ctx.positions[s] > 0);
    if (held.length) {
      const sym = held[0];
      const bars = ctx.history(sym, p.exitSma + 1);
      const c = bars[bars.length - 1].c;
      const age = ctx.barIndex - (mem.entryBar[sym] ?? ctx.barIndex);
      let why = null;
      if (c > sma(bars.map((b) => b.c), p.exitSma)) why = `${symName(sym)}: ${p.exitSma}일 평균 위로 회복해서 매도 (반등 완료)`;
      else if (age >= p.maxHold) why = `${symName(sym)}: ${p.maxHold}거래일이 지나도 회복하지 않아 매도`;
      else if (ctx.avgCost[sym] && c <= ctx.avgCost[sym] * (1 - p.stop)) why = `${symName(sym)}: 산 가격보다 ${Math.round(p.stop * 100)}% 떨어져 손절`;
      if (why) { delete mem.entryBar[sym]; return { targets: {}, reasons: { [sym]: why }, mem }; }
      return { mem };
    }
    let best = null;
    for (const sym of ctx.universe) {
      const bars = ctx.history(sym, p.sma + 1);
      if (bars.length < p.sma) continue;
      const cl = bars.map((b) => b.c);
      const last = bars[bars.length - 1];
      if (!(last.c > sma(cl, p.sma))) continue;
      const r2 = rsi(cl.slice(-30), 2);
      const down3 = cl.length > 3 && cl[cl.length - 1] < cl[cl.length - 2] && cl[cl.length - 2] < cl[cl.length - 3] && cl[cl.length - 3] < cl[cl.length - 4];
      const lowClose = last.h > last.l && (last.c - last.l) / (last.h - last.l) < 0.2;
      if (r2 < p.rsiMax || down3 || lowClose) {
        const why = r2 < p.rsiMax ? `단기 과매도(RSI2 ${Math.round(r2)})` : down3 ? '3일 연속 하락' : '그날 저가 근처에서 마감';
        if (!best || r2 < best.r2) best = { sym, r2, why };
      }
    }
    if (!best) return { mem };
    mem.entryBar[best.sym] = ctx.barIndex;
    return { targets: { [best.sym]: p.size }, reasons: { [best.sym]: `${symName(best.sym)}: 200일 평균 위 상승장에서 ${best.why} → 눌림목 매수` }, mem };
  },
};

// ---------------- C) S5 crypto daily trend + BTC 200d filter + S3 ----------------
export const cryptoTrendV1 = {
  id: 'crypto_trend_v1', family: 'crypto_trend', version: 1, cadence: 'slow',
  priorTrials: 20, // 2026-11-14 30분·4시간 20/10 돌파 20개 조합이 이미 탈락 (조사 보고서 1-3절)
  name: 'C. 비트·이더 일봉 추세 (BTC 200일 필터)', market: 'crypto', timeframe: '1d',
  universe: ['KRW-BTC', 'KRW-ETH'], benchSym: 'KRW-BTC',
  params: { filterSma: 200, entry: 55, exit: 20, fast: 50, slow: 200, momDays: 28, atrN: 20, atrK: 2, volTarget: 0.25, volN: 20 }, grid: null,
  get lookback() { return 215; },
  risk: COIN_RISK,
  description: '비트코인이 200일 평균 위일 때만 새로 산다. 55일 최고가를 넘거나(돌파) 50일선이 200일선 위이고 4주 수익이 플러스면 매수. 20일 최저가 이탈·비트코인 필터 해제·진입가-2ATR 손절 중 하나면 매도. 크기는 목표 변동성 연 25%.',
  decide(ctx) {
    const p = ctx.params;
    const btc = ctx.closes('KRW-BTC', p.filterSma + 1);
    if (btc.length < p.filterSma) return null;
    const filterOn = btc[btc.length - 1] > sma(btc, p.filterSma);
    const mem = { stop: { ...(ctx.mem.stop || {}) } };
    const targets = {}, reasons = {};
    let changed = false;
    const resize = weekday(ctx.t) === 1; // 주 1회(월요일)만 크기 재조정
    for (const sym of ctx.universe) {
      const bars = ctx.history(sym, p.filterSma + 2);
      if (bars.length < p.slow) continue;
      const c = bars.map((b) => b.c), last = bars[bars.length - 1];
      const w = volTargetWeight(c, { target: p.volTarget, n: p.volN, ppy: 365, cap: 0.6 });
      const held = ctx.positions[sym] > 0;
      if (held) {
        const low = lowestPrior(bars.map((b) => b.l), p.exit);
        let why = null;
        if (last.c < low) why = `${symName(sym)}: 최근 ${p.exit}일 최저가 아래로 내려가서 매도`;
        else if (!filterOn) why = `${symName(sym)}: 비트코인이 200일 평균 아래로 내려가 시장 필터 해제 → 매도`;
        else if (mem.stop[sym] && last.c < mem.stop[sym]) why = `${symName(sym)}: 진입가에서 2ATR 손절선 아래로 내려가 손절`;
        if (why) { targets[sym] = 0; reasons[sym] = why; delete mem.stop[sym]; changed = true; }
        else { targets[sym] = resize ? w : ctx.weights[sym]; if (resize) { reasons[sym] = `${symName(sym)}: 주간 크기 조정 (변동성 기준 ${Math.round(w * 100)}%)`; changed = true; } }
      } else if (filterOn) {
        const brk = last.c > highestPrior(bars.map((b) => b.h), p.entry);
        const trend = sma(c, p.fast) > sma(c, p.slow) && roc(c, p.momDays) > 0;
        if (brk || trend) {
          targets[sym] = w; changed = true;
          mem.stop[sym] = last.c - p.atrK * atr(bars.slice(-(p.atrN + 1)), p.atrN);
          reasons[sym] = `${symName(sym)}: ${brk ? `최근 ${p.entry}일 최고가를 넘어 올라가서` : `${p.fast}일선이 ${p.slow}일선 위 + 4주 수익 ${pct(roc(c, p.momDays))}라서`} 매수 (비트코인 200일 필터 통과)`;
        }
      }
    }
    return changed ? { targets, reasons, mem } : { mem };
  },
};

// ---------------- D) S0 DCA baselines ----------------
export function makeDca({ id, name, market, sym, every, slices }) {
  return {
    id, family: id.replace(/_v\d+$/, ''), version: 1, cadence: 'slow', benchmarkOnly: true,
    name, market, timeframe: '1d', universe: [sym], benchSym: sym, lookback: 2, params: { slices }, grid: null,
    risk: { maxPositionWeight: 1, minCash: 0, dailyLossLimit: 0, weeklyLossLimit: 0, maxDrawdownHalt: 0, rebalanceBand: 0.001 },
    description: `${symName(sym)}을(를) ${every === 'month' ? '매월 첫 거래일' : '매주 월요일'} 같은 금액(전체의 1/${slices})씩 사서 모으는 적립식 기준선. 팔지 않음.`,
    decide(ctx) {
      const k = every === 'month' ? monthOf(ctx.t) : Math.floor(ctx.t / 86400 / 7);
      if (ctx.mem.lastK === k) return null;
      if (every === 'week' && weekday(ctx.t) !== 1 && ctx.barIndex > 0) return null;
      const n = (ctx.mem.n || 0) + 1;
      const mem = { lastK: k, n };
      if (n > ctx.params.slices) return { mem };
      const cur = ctx.weights[sym] || 0;
      const add = (10_000_000 / ctx.params.slices) / ctx.equity;
      return { targets: { [sym]: Math.min(1, cur + add) }, reasons: { [sym]: `적립식 기준선: ${n}/${ctx.params.slices}번째 정액 매수` }, mem };
    },
  };
}
export const krxDca = makeDca({ id: 'krx_dca_v1', name: '기준선: KODEX 200TR 매월 적립', market: 'krx', sym: '278530', every: 'month', slices: 12 });
export const cryptoDca = makeDca({ id: 'crypto_dca_v1', name: '기준선: 비트코인 매주 적립', market: 'crypto', sym: 'KRW-BTC', every: 'week', slices: 52 });

// ---------------- D) S7 LLM news VETO overlay (A/B twin books) ----------------
// The veto can only BLOCK or HALVE new buys. It can never create a trade or force a sale.
// Signal source: signals table (kind='news_veto', value 0=NO_VETO, 0.5=REDUCE_HALF, 1=VETO_NEW_BUYS),
// sym='*' for the whole market. Provider 'none' (default) = stub that never vetoes.
// If a provider is configured but no fresh signal exists -> fail-closed (treat as VETO_NEW_BUYS).
export function vetoState(signals) {
  const v = signals?.veto;
  if (!v) return signals?.vetoRequired ? { value: 1, note: '뉴스 판단 결과 없음 → 안전하게 보류(fail-closed)' } : { value: 0 };
  return v;
}
export function withNewsVeto(base) {
  return {
    ...base,
    id: `${base.family}_veto_v${base.version}`, family: `${base.family}_veto`, overlayOf: base.id,
    name: `${base.name} + 뉴스 거부권`, researchOnly: true,
    description: `${base.description} (비교용 쌍둥이 장부: 뉴스 판단이 "신규 매수 보류/절반"이라고 하면 새로 사는 것만 막거나 줄임. 매수를 만들거나 매도를 강제하지 않음.)`,
    decide(ctx) {
      const d = base.decide(ctx);
      if (!d?.targets) return d;
      const v = vetoState(ctx.signals);
      if (!v.value) return d;
      const targets = { ...d.targets }, reasons = { ...(d.reasons || {}) };
      for (const [s, w] of Object.entries(targets)) {
        const cur = ctx.weights[s] || 0;
        if (w > cur) {
          targets[s] = v.value >= 1 ? cur : cur + (w - cur) / 2;
          reasons[s] = `${reasons[s] || ''} · 뉴스 거부권: ${v.value >= 1 ? '신규 매수 보류' : '매수 크기 절반'}${v.note ? ` (${v.note})` : ''}`;
        }
      }
      return { ...d, targets, reasons };
    },
  };
}
// ---------------- AI 판단 전략 (paper candidate, A/B vs the same rule strategy) ----------------
// Uses a once-a-day LLM score per symbol (-1..+1) ONLY to scale the size of NEW buys/adds of the
// underlying rule strategy: multiplier 0.5x..1.0x (never > 1x, never opens a position by itself,
// never forces a sale). No endpoint configured -> exact no-op (dashboard says so).
// Endpoint configured but no fresh score -> conservative 0.5x (fail-closed).
export const aiMultiplier = (score) => 0.75 + 0.25 * Math.max(-1, Math.min(1, score));
export function withAiScale(base) {
  return {
    ...base,
    id: `${base.family}_ai_v${base.version}`, family: `${base.family}_ai`, overlayOf: base.id, aiOverlay: true,
    name: `${base.name} + AI 판단(비중 조절)`, researchOnly: true,
    description: `${base.description} (AI 비교 장부: 하루 한 번 AI가 뉴스·지표를 읽고 매긴 점수(-1~+1)로 새로 사는 양만 0.5~1배로 줄임. AI가 혼자 매수·매도를 만들지 않음.)`,
    decide(ctx) {
      const d = base.decide(ctx);
      if (!d?.targets || !ctx.signals?.aiRequired) return d;
      const targets = { ...d.targets }, reasons = { ...(d.reasons || {}) };
      for (const [s, w] of Object.entries(targets)) {
        const cur = ctx.weights[s] || 0;
        if (!(w > cur)) continue;
        const a = ctx.signals.ai?.[s];
        const mult = a ? aiMultiplier(a.score) : 0.5;
        targets[s] = cur + (w - cur) * mult;
        reasons[s] = `${reasons[s] || ''} · AI 판단 ${a ? `점수 ${a.score.toFixed(2)} → ${mult.toFixed(2)}배${a.reason ? ` (${a.reason})` : ''}` : '결과 없음 → 안전하게 0.5배'}`;
      }
      return { ...d, targets, reasons };
    },
  };
}

export const etfTrendVetoV1 = withNewsVeto(etfTrendV1);
export const cryptoTrendVetoV1 = withNewsVeto(cryptoTrendV1);

export const etfTrendAiV1 = withAiScale(etfTrendV1);
export const cryptoTrendAiV1 = withAiScale(cryptoTrendV1);

export const EXTRA_STRATEGIES = [etfTrendV1, etfDipV1, cryptoTrendV1, krxDca, cryptoDca, etfTrendVetoV1, cryptoTrendVetoV1, etfTrendAiV1, cryptoTrendAiV1];
