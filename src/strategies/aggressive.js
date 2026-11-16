// 공격형 슬롯 "고위험(잃어도 되는 돈만)" — paper first. Separate sleeve with a hard total cap:
// sleeve total -30% -> every sleeve strategy stops; NO automatic refill/resume (owner reset only).
// Note: RESEARCH-STRATEGY-KO.md 4장 forbids altcoins for the main account. This sleeve exists at
// the user's explicit request with its own small budget (future live cap 20만원, configurable).
import { sma, roc } from '../core/indicators.js';
import { symName } from '../config.js';
import { weekday } from './common.js';
import { DAY } from '../core/calendar.js';

const SLEEVE_RISK = { maxPositionWeight: 0.25, minCash: 0.20, dailyLossLimit: 0.06, weeklyLossLimit: 0.12, maxDrawdownHalt: 0.35, haltCooldownBars: 1e9 };
const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 1000) / 10}%`;

// (a) altcoin momentum rotation
export const altMomV1 = {
  id: 'alt_mom_v1', family: 'alt_mom', version: 1, cadence: 'fast', priorTrials: 18, // crypto_mom_v1 grid already explored this idea
  sleeve: 'aggressive', name: '공격형: 알트코인 모멘텀 순환', market: 'crypto', timeframe: '1d',
  universe: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA', 'KRW-TRX', 'KRW-LINK', 'KRW-BCH', 'KRW-XLM'], dynamicUniverse: true, benchSym: 'KRW-BTC',
  params: { topN: 3, filterSma: 200, minValueKrw: 1e9, liqDays: 20 }, grid: null,
  get lookback() { return 210; },
  risk: SLEEVE_RISK,
  description: '고위험. 비트코인이 200일 평균 위일 때만, 하루 거래대금 10억 원 이상인 업비트 코인 중 최근 7일·30일 상승률이 모두 플러스이고 평균이 가장 높은 3개를 산다(코인당 최대 25%). 매주 월요일에만 바꾼다. 비트코인이 200일선 아래면 전부 현금.',
  decide(ctx) {
    const p = ctx.params;
    const btc = ctx.closes('KRW-BTC', p.filterSma + 1);
    if (btc.length < p.filterSma) return null;
    const up = btc[btc.length - 1] > sma(btc, p.filterSma);
    const held = Object.keys(ctx.positions).filter((s) => ctx.positions[s] > 0);
    if (!up) {
      if (!held.length) return null;
      return { targets: {}, reasons: Object.fromEntries(held.map((s) => [s, `${symName(s)}: 비트코인이 ${p.filterSma}일 평균 아래 → 고위험 슬롯 전부 현금으로`])) };
    }
    if (weekday(ctx.t) !== 1 && held.length) return null;
    const ranked = [];
    for (const sym of ctx.universe) {
      const bars = ctx.history(sym, 31);
      if (bars.length < 31) continue;
      const value = bars.slice(-p.liqDays).reduce((a, b) => a + b.c * b.v, 0) / p.liqDays;
      if (value < p.minValueKrw) continue;
      const c = bars.map((b) => b.c);
      const r7 = roc(c, 7), r30 = roc(c, 30);
      if (r7 > 0 && r30 > 0) ranked.push({ sym, s: (r7 + r30) / 2, r7, r30 });
    }
    ranked.sort((a, b) => b.s - a.s);
    const targets = {}, reasons = {};
    for (const x of ranked.slice(0, p.topN)) { targets[x.sym] = 0.25; reasons[x.sym] = `${symName(x.sym)}: 7일 ${pct(x.r7)}·30일 ${pct(x.r30)} 상승률 상위 → 매수/유지 (주간 교체)`; }
    for (const s of held) if (!(s in targets)) reasons[s] = `${symName(s)}: 이번 주 상승률 상위에서 빠져 매도`;
    return { targets, reasons };
  },
};

// (c) volatility breakout (Larry Williams style) on hourly bars; day = Upbit daily candle (09:00 KST).
export const volBreakoutV1 = {
  id: 'vol_breakout_v1', family: 'vol_breakout', version: 1, cadence: 'fast', priorTrials: 0,
  sleeve: 'aggressive', name: '공격형: 변동성 돌파 (래리 윌리엄스)', market: 'crypto', timeframe: '1h',
  universe: ['KRW-BTC', 'KRW-ETH'], benchSym: 'KRW-BTC',
  params: { k: 0.5, maDays: 5, weight: 0.4 }, grid: null,
  get lookback() { return 24 * 7; },
  risk: { ...SLEEVE_RISK, maxPositionWeight: 0.4 },
  description: '고위험. 한국 코인 봇에서 유명한 방법. 오늘 시가 + (어제 고가-저가)×0.5 를 넘으면 사고, 다음 날 오전 9시(업비트 일봉 시작) 첫 시간에 판다. 어제 종가가 5일 평균 위일 때만 산다.',
  decide(ctx) {
    const p = ctx.params;
    const day = Math.floor(ctx.t / DAY);
    const targets = {}, reasons = {};
    let changed = false;
    for (const sym of ctx.universe) {
      const bars = ctx.history(sym, 24 * (p.maDays + 2));
      if (bars.length < 24 * (p.maDays + 1)) continue;
      const byDay = new Map();
      for (const b of bars) { const d = Math.floor(b.t / DAY); const x = byDay.get(d) || { o: b.o, h: -Infinity, l: Infinity, c: b.c }; x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; byDay.set(d, x); }
      const today = byDay.get(day), prev = byDay.get(day - 1);
      if (!today || !prev) continue;
      const held = ctx.positions[sym] > 0;
      const entered = ctx.entries[sym];
      if (held && Math.floor(entered / DAY) < day) { targets[sym] = 0; reasons[sym] = `${symName(sym)}: 하루가 지나 다음 날 첫 시간에 정리 (변동성 돌파 규칙)`; changed = true; continue; }
      if (held) { targets[sym] = ctx.weights[sym]; continue; }
      const closes = [];
      for (let d = day - p.maDays; d < day; d++) if (byDay.get(d)) closes.push(byDay.get(d).c);
      const target = today.o + p.k * (prev.h - prev.l);
      const last = bars[bars.length - 1];
      if (closes.length === p.maDays && prev.c > sma(closes, p.maDays) && last.c > target && !ctx.mem[`d${sym}`]?.includes(day)) {
        targets[sym] = p.weight; changed = true;
        reasons[sym] = `${symName(sym)}: 오늘 시가 + 어제 변동폭×${p.k} (${Math.round(target).toLocaleString('ko-KR')}원) 돌파 → 매수, 내일 아침 정리`;
      }
    }
    return changed ? { targets, reasons } : null;
  },
};

export const AGGRESSIVE = [altMomV1, volBreakoutV1];
