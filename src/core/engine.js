// Paper-trading engine shared by the live (Worker) paper ledger and the backtester.
// Pure: no I/O. Orders are VIRTUAL; there is no code path that reaches a broker.
//
// Bar processing order for bar t (identical in backtest and live paper):
//   1) fill orders decided at the previous bar's close at THIS bar's open (+slippage, fees, tax)
//   2) mark to market at this bar's close
//   3) risk checks (max-drawdown halt, daily loss limit)
//   4) strategy.decide() on data up to and including bar t -> risk layer -> new pending orders
import { DAY } from './calendar.js';
import { fillPrice, feesFor, affordableQty, roundQty } from './costs.js';
import { applyRisk, drawdown } from './risk.js';
import { applyMarketGuard } from './market-guard.js';

export class Feed {
  /** @param {Record<string, Array<{t:number,o:number,h:number,l:number,c:number,v:number}>>} series ascending by t */
  constructor(series) {
    this.s = series;
    this.cur = {};
    for (const k of Object.keys(series)) this.cur[k] = -1;
  }
  advance(t) {
    for (const [k, bars] of Object.entries(this.s)) {
      let i = this.cur[k];
      while (i + 1 < bars.length && bars[i + 1].t <= t) i++;
      this.cur[k] = i;
    }
  }
  last(sym) { const i = this.cur[sym]; return i >= 0 ? this.s[sym][i] : null; }
  bar(sym, t) { const b = this.last(sym); return b && b.t === t ? b : null; }
  history(sym, n) {
    const i = this.cur[sym];
    if (i === undefined || i < 0) return [];
    return this.s[sym].slice(Math.max(0, i - n + 1), i + 1);
  }
  closes(sym, n) { return this.history(sym, n).map((b) => b.c); }
}

export function timelineOf(series, syms) {
  const set = new Set();
  for (const s of syms || Object.keys(series)) for (const b of series[s] || []) set.add(b.t);
  return [...set].sort((a, b) => a - b);
}

export function createState(initialCash) {
  return {
    v: 1, initialCash, cash: initialCash, pos: {}, pending: [], lastPx: {},
    equity: initialCash, peak: initialCash, dayKey: null, dayStartEquity: initialCash,
    halted: false, haltReason: null, haltedT: null, haltBars: 0, epochT: null, halts: 0,
    fills: 0, sells: 0, wins: 0, fees: 0, taxes: 0,
    benchStart: null, bench: initialCash, lastT: null, startT: null, bars: 0, mem: {},
  };
}

const r2 = (x) => Math.round(x * 100) / 100;

function fillOrders(state, t, feed, opts, fills, events) {
  const { costs, meta = {} } = opts;
  const keep = [];
  const orders = [...state.pending].sort((a, b) => (a.side === b.side ? 0 : a.side === 'SELL' ? -1 : 1));
  for (const o of orders) {
    const bar = feed.bar(o.sym, t);
    if (!bar) {
      o.age = (o.age || 0) + 1;
      if (o.age < 3) keep.push(o);
      else events.push({ t, kind: 'order_cancel', sym: o.sym, message: `${o.sym} 시세가 없어 주문 취소` });
      continue;
    }
    const m = meta[o.sym] || {};
    const pos = state.pos[o.sym];
    if (o.side === 'SELL') {
      if (!pos || pos.qty <= 0) continue;
      const qty = Math.min(o.all ? pos.qty : o.qty, pos.qty);
      if (qty <= 0) continue;
      const price = fillPrice('SELL', bar.o, costs, m);
      const gross = qty * price;
      const { fee, tax } = feesFor('SELL', gross, costs, m);
      const basis = pos.cost * (qty / pos.qty);
      const net = gross - fee - tax;
      const pnl = net - basis;
      state.cash += net;
      pos.qty = roundQty(pos.qty - qty, costs);
      pos.cost -= basis;
      if (pos.qty <= 0) delete state.pos[o.sym];
      state.fills++; state.sells++; if (pnl > 0) state.wins++;
      state.fees += fee; state.taxes += tax;
      fills.push({ t, sym: o.sym, side: 'SELL', qty, price: r2(price), gross: r2(gross), fee, tax, pnl: r2(pnl), reason: o.reason, cash: r2(state.cash) });
    } else {
      const price = fillPrice('BUY', bar.o, costs, m);
      const qty = Math.min(o.qty, affordableQty(state.cash, price, costs));
      const gross = qty * price;
      if (qty <= 0 || gross < costs.minOrderKrw) continue;
      const { fee } = feesFor('BUY', gross, costs, m);
      if (gross + fee > state.cash + 1e-6) continue;
      state.cash -= gross + fee;
      const p = state.pos[o.sym] || (state.pos[o.sym] = { qty: 0, cost: 0, entryT: t });
      p.qty = roundQty(p.qty + qty, costs) || p.qty + qty;
      p.cost += gross + fee;
      state.fills++; state.fees += fee;
      fills.push({ t, sym: o.sym, side: 'BUY', qty, price: r2(price), gross: r2(gross), fee, tax: 0, pnl: 0, reason: o.reason, cash: r2(state.cash) });
    }
  }
  state.pending = keep;
}

function mark(state, t, feed, opts) {
  for (const sym of opts.universe) { const b = feed.last(sym); if (b) state.lastPx[sym] = b.c; }
  if (opts.benchSym) { const b = feed.last(opts.benchSym); if (b) state.lastPx[opts.benchSym] = b.c; }
  let inv = 0;
  for (const [sym, p] of Object.entries(state.pos)) inv += p.qty * (state.lastPx[sym] || 0);
  state.equity = state.cash + inv;
  state.peak = Math.max(state.peak, state.equity);
  if (opts.benchSym && state.lastPx[opts.benchSym]) {
    if (state.benchStart == null) state.benchStart = state.lastPx[opts.benchSym];
    state.bench = state.initialCash * (state.lastPx[opts.benchSym] / state.benchStart);
  }
  return inv;
}

export function currentWeights(state) {
  const w = {};
  if (state.equity <= 0) return w;
  for (const [sym, p] of Object.entries(state.pos)) w[sym] = (p.qty * (state.lastPx[sym] || 0)) / state.equity;
  return w;
}

/**
 * Process one bar. Mutates and returns state.
 * @param opts {strategy, params, universe, benchSym, costs, risk, meta, signals, guard}
 */
export function stepBar(state, t, feed, opts) {
  const fills = [];
  const events = [];
  feed.advance(t);
  if (state.startT == null) { state.startT = t; state.epochT = t; }
  state.bars++;
  const dk = Math.floor(t / DAY);
  if (dk !== state.dayKey) { state.dayKey = dk; state.dayStartEquity = state.equity; }
  const wk = Math.floor((t / DAY + 3) / 7); // weeks starting Monday
  if (wk !== state.weekKey) { state.weekKey = wk; state.weekStartEquity = state.equity; }

  fillOrders(state, t, feed, opts, fills, events);
  const invested = mark(state, t, feed, opts);
  const risk = opts.risk;

  // Halt handling and automatic return to paper after cooldown.
  if (state.halted) {
    state.haltBars++;
    if (Object.keys(state.pos).length === 0 && state.pending.length === 0 && state.haltBars >= risk.haltCooldownBars) {
      state.halted = false; state.haltReason = null; state.haltBars = 0;
      state.peak = state.equity; state.epochT = t;
      events.push({ t, kind: 'resume', message: '대기 기간이 끝나 모의 검증을 처음부터 다시 시작' });
    }
  } else if (risk.maxDrawdownHalt && drawdown(state.equity, state.peak) >= risk.maxDrawdownHalt) {
    state.halted = true; state.haltedT = t; state.haltBars = 0; state.halts++;
    state.haltReason = `고점 대비 ${Math.round(drawdown(state.equity, state.peak) * 1000) / 10}% 손실 → 한도 ${Math.round(risk.maxDrawdownHalt * 100)}% 넘어 전부 팔고 멈춤`;
    state.pending = Object.keys(state.pos).map((sym) => ({ sym, side: 'SELL', all: true, qty: state.pos[sym].qty, reason: '위험 관리: 최대 손실폭 한도 도달로 전량 매도' }));
    events.push({ t, kind: 'halt', message: state.haltReason });
  }

  const point = { t, equity: r2(state.equity), cash: r2(state.cash), invested: r2(invested), bench: r2(state.bench) };
  if (state.halted) { state.lastT = t; return { state, fills, events, point }; }

  const dailyRet = state.dayStartEquity > 0 ? state.equity / state.dayStartEquity - 1 : 0;
  const weeklyRet = state.weekStartEquity > 0 ? state.equity / state.weekStartEquity - 1 : 0;
  const blockDaily = !!risk.dailyLossLimit && dailyRet <= -risk.dailyLossLimit;
  const blockWeekly = !!risk.weeklyLossLimit && weeklyRet <= -risk.weeklyLossLimit;
  const blockBuys = blockDaily || blockWeekly;
  const weights = currentWeights(state);
  const positions = Object.fromEntries(Object.entries(state.pos).map(([s, p]) => [s, p.qty]));
  const ctx = {
    t, params: opts.params, universe: opts.universe, benchSym: opts.benchSym,
    history: (sym, n) => feed.history(sym, n), closes: (sym, n) => feed.closes(sym, n), last: (sym) => feed.last(sym),
    positions, weights, avgCost: Object.fromEntries(Object.entries(state.pos).map(([s, p]) => [s, p.qty > 0 ? p.cost / p.qty : 0])), entries: Object.fromEntries(Object.entries(state.pos).map(([s, p]) => [s, p.entryT])),
    equity: state.equity, cash: state.cash, barIndex: state.bars - 1, mem: state.mem, signals: typeof opts.signals === 'function' ? opts.signals(t) : opts.signals || {},
  };
  const decision = opts.strategy.decide(ctx);
  if (decision && decision.mem) state.mem = decision.mem;
  if (decision && decision.targets) {
    const { targets, notes } = applyRisk(decision.targets, { weights, blockBuys, blockWeekly, dailyRet }, risk);
    const guard = typeof opts.guard === 'function' ? opts.guard(t) : opts.guard; // paper only: market risk signals
    if (guard) applyMarketGuard(targets, notes, weights, guard, opts.strategy);
    if (blockDaily) events.push({ t, kind: 'daily_loss', message: `하루 손실 ${Math.round(dailyRet * 1000) / 10}% → 오늘은 새로 사지 않음` });
    else if (blockWeekly) events.push({ t, kind: 'weekly_loss', message: `이번 주 손실 ${Math.round(weeklyRet * 1000) / 10}% → 이번 주는 새로 사지 않음` });
    state.lastTargets = { t, targets: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, Math.round(v * 10000) / 10000])) };
    const syms = new Set([...Object.keys(targets), ...Object.keys(state.pos)]);
    const orders = [];
    for (const sym of syms) {
      const px = state.lastPx[sym];
      if (!px) continue;
      const tgt = targets[sym] || 0;
      const cur = weights[sym] || 0;
      const held = state.pos[sym]?.qty || 0;
      const reason = [decision.reasons?.[sym], notes[sym]].filter(Boolean).join(' · ') || '목표 비중 조정';
      if (tgt <= 0) {
        if (held > 0) orders.push({ sym, side: 'SELL', all: true, qty: held, reason });
        continue;
      }
      const needsTrade = cur === 0 || Math.abs(tgt - cur) > risk.rebalanceBand;
      if (!needsTrade) continue;
      const deltaQty = roundQty(Math.abs((tgt * state.equity) / px - held), opts.costs);
      if (deltaQty <= 0 || deltaQty * px < opts.costs.minOrderKrw) continue;
      orders.push({ sym, side: tgt > cur ? 'BUY' : 'SELL', qty: deltaQty, reason });
    }
    state.pending = orders;
  }
  state.lastT = t;
  return { state, fills, events, point };
}
