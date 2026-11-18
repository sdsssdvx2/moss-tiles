// "모의 전용(선물 시뮬레이션)": BTC perpetual-like simulation on Upbit SPOT candles.
// Isolated margin, leverage <= 3x (sim cap), exchange-side stop, liquidation and funding approximation.
// 2026-11-18: optional realism knobs (all off by default so already stored books replay 1:1):
//   qtyStep/minQty  : exchange lot size (e.g. Binance BTCUSDT 0.001 BTC) -> tiny accounts cannot open at all
//   rollEveryDays/rollCost : dated futures roll-over (close+reopen cost as a fraction of notional)
// Paper-only comparison book; there is no futures exchange connectivity anywhere in this repo.
import { DAY, HOUR } from './calendar.js';

export const FUT_DEFAULTS = {
  leverage: 2, maxLeverage: 3, mmr: 0.005, fee: 0.0005, slippage: 0.0005,
  fundingPer8h: 0.0001, // +0.01% / 8h: longs pay shorts. Binance BTCUSDT 2019-09~2026-11 평균 +0.0104%/8h (2021년 +0.028%)
  qtyStep: 0, minQty: 0, rollEveryDays: 0, rollCost: 0,
};
export const FUT_HARD_MAX_LEVERAGE = 3;

export function createFutState(initialCash) {
  return { v: 1, kind: 'futures', initialCash, cash: initialCash, pos: null, pending: null, equity: initialCash, peak: initialCash,
    bench: initialCash, benchStart: null, lastPx: {}, fills: 0, sells: 0, wins: 0, fees: 0, funding: 0, liquidations: 0, skippedMin: 0, rolls: 0,
    halted: false, haltReason: null, lastT: null, startT: null, epochT: null, bars: 0, mem: {} };
}

/** Isolated-margin liquidation price. side: +1 long, -1 short. */
export function liqPrice(entry, side, lev, mmr) {
  return side > 0 ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}

function closePos(state, t, price, reason, kind, fills, fee) {
  const p = state.pos;
  const pnl = p.side * (price - p.entry) * p.qty;
  const f = Math.round(price * p.qty * fee);
  let ret = p.margin + pnl - f;
  if (kind === 'liquidation') ret = 0; // isolated margin lost
  state.cash += Math.max(0, ret);
  state.fees += f; state.fills++; state.sells++;
  const realized = Math.max(0, ret) - p.margin;
  if (realized > 0) state.wins++;
  fills.push({ t, sym: p.sym, side: p.side > 0 ? 'SELL' : 'BUY', qty: p.qty, price: Math.round(price), gross: Math.round(price * p.qty), fee: f, tax: 0, pnl: Math.round(realized), reason, cash: Math.round(state.cash), phase: 'exit' });
  state.pos = null;
}

/** Same contract as engine.stepBar: returns {state, fills, events, point}. */
export function stepFutures(state, t, feed, opts) {
  const fills = [], events = [];
  const cfg = { ...FUT_DEFAULTS, ...(opts.params || {}) };
  // B07: cost stress (e.g. 2x costs check) must reach the futures model too
  const k = opts.costs?.stress || 1;
  if (k !== 1) { cfg.fee *= k; cfg.slippage *= k; }
  const lev = Math.min(cfg.leverage, cfg.maxLeverage, opts.allowAnyLeverage ? Infinity : FUT_HARD_MAX_LEVERAGE);
  const sym = opts.universe[0];
  feed.advance(t);
  if (state.startT == null) { state.startT = t; state.epochT = t; }
  state.bars++;
  const bar = feed.bar(sym, t);
  if (bar) {
    // 1) pending entry/exit at this bar's open
    if (state.pending) {
      const o = state.pending; state.pending = null;
      if (state.pos && (o.action === 'close' || o.side !== state.pos.side)) closePos(state, t, bar.o * (1 - state.pos.side * cfg.slippage), o.reason, 'signal', fills, cfg.fee);
      if (o.action === 'open' && !state.pos && state.cash > 0) {
        const px = bar.o * (1 + o.side * cfg.slippage);
        // 주문이 배수를 직접 정할 수 있다(변동성 목표 장부). 없으면 장부의 고정 배수. 어느 쪽이든 상한(3배)을 넘지 못한다.
        const useLev = Number.isFinite(o.lev) && o.lev > 0 ? Math.min(o.lev, cfg.maxLeverage, opts.allowAnyLeverage ? Infinity : FUT_HARD_MAX_LEVERAGE) : lev;
        let margin = state.cash * o.size;
        let qty = (margin * useLev) / px;
        if (cfg.qtyStep > 0) { qty = Math.floor(qty / cfg.qtyStep + 1e-9) * cfg.qtyStep; margin = (qty * px) / useLev; }
        if (qty <= 0 || (cfg.minQty > 0 && qty < cfg.minQty - 1e-12)) {
          state.skippedMin = (state.skippedMin || 0) + 1;
          events.push({ t, kind: 'order_cancel', sym, message: `선물 시뮬레이션: 최소 주문 수량(${cfg.minQty || cfg.qtyStep}) 미만이라 진입 못 함 (증거금 ${Math.round(state.cash * o.size)}원)` });
        } else {
        const f = Math.round(px * qty * cfg.fee);
        state.cash -= margin + f; state.fees += f; state.fills++;
        const stop = o.stopDist ? px - o.side * o.stopDist : null;
        state.pos = { sym, side: o.side, qty, entry: px, margin, lev: useLev, stop, liq: liqPrice(px, o.side, useLev, cfg.mmr), t };
        fills.push({ t, sym, side: o.side > 0 ? 'BUY' : 'SELL', qty, price: Math.round(px), gross: Math.round(px * qty), fee: f, tax: 0, pnl: 0, reason: o.reason, cash: Math.round(state.cash), phase: 'entry' });
        }
      }
    }
    // 2) funding, stop and liquidation inside the bar
    const p = state.pos;
    if (p) {
      const hours = opts.strategy?.timeframe === '1h' ? 1 : 24;
      const fund = p.side * cfg.fundingPer8h * (hours / 8) * p.qty * bar.o;
      p.margin -= fund; state.funding += fund;
      if (cfg.rollEveryDays > 0 && t - (p.rollT ?? p.t) >= cfg.rollEveryDays * DAY) {
        const rc = cfg.rollCost * p.qty * bar.o; // 만기 선물 갈아타기(청산+재진입) 비용
        p.margin -= rc; state.fees += rc; state.rolls = (state.rolls || 0) + 1; p.rollT = t;
      }
      const adverse = p.side > 0 ? bar.l : bar.h;
      const gapLiq = p.side > 0 ? bar.o <= p.liq : bar.o >= p.liq;
      const hitStop = p.stop != null && (p.side > 0 ? adverse <= p.stop : adverse >= p.stop);
      const hitLiq = p.side > 0 ? adverse <= p.liq : adverse >= p.liq;
      if (gapLiq || (hitLiq && (!hitStop || (p.side > 0 ? p.stop < p.liq : p.stop > p.liq)))) {
        closePos(state, t, p.liq, '강제 청산(증거금 소진) — 시뮬레이션', 'liquidation', fills, cfg.fee);
        state.liquidations++;
        events.push({ t, kind: 'liquidation', message: '선물 시뮬레이션: 강제 청산 발생 (증거금 전액 손실)' });
      } else if (hitStop) {
        const px = p.side > 0 ? Math.min(bar.o, p.stop) : Math.max(bar.o, p.stop);
        closePos(state, t, px * (1 - p.side * cfg.slippage), '거래소 손절 주문 체결(시뮬레이션)', 'stop', fills, cfg.fee);
      } else if (p.margin + p.side * (bar.c - p.entry) * p.qty <= 0) {
        closePos(state, t, bar.c, '강제 청산(펀딩비 누적) — 시뮬레이션', 'liquidation', fills, cfg.fee);
        state.liquidations++;
      }
    }
    state.lastPx[sym] = bar.c;
  }
  const px = state.lastPx[sym];
  const upnl = state.pos && px ? state.pos.side * (px - state.pos.entry) * state.pos.qty : 0;
  state.equity = state.cash + (state.pos ? state.pos.margin + upnl : 0);
  state.peak = Math.max(state.peak, state.equity);
  if (px) { if (state.benchStart == null) state.benchStart = px; state.bench = state.initialCash * px / state.benchStart; }
  const point = { t, equity: Math.round(state.equity * 100) / 100, cash: Math.round(state.cash), invested: state.pos ? Math.round(state.pos.qty * (px || 0)) : 0, bench: Math.round(state.bench * 100) / 100 };
  // 3) decision for next bar open
  if (bar && !state.halted) {
    const ctx = { t, params: opts.params, universe: opts.universe, history: (s, n) => feed.history(s, n), closes: (s, n) => feed.closes(s, n), position: state.pos ? { side: state.pos.side, entry: state.pos.entry } : null, mem: state.mem, barIndex: state.bars - 1, equity: state.equity, peak: state.peak };
    const d = opts.strategy.decideFutures(ctx);
    if (d?.mem) state.mem = d.mem;
    if (d?.order) state.pending = d.order;
  }
  state.lastT = t;
  return { state, fills, events, point };
}
