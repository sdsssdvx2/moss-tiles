// Market-signal guard (pure). Applied by the engine AFTER the normal risk layer, PAPER ledgers only
// (the jobs layer passes opts.guard; backtests never do). It can only REDUCE buying, never add a trade:
//   coin level 'close' (투자유의·거래지원 종료·유의 촉구): no new buys; aggressive sleeve -> target 0 (exit)
//   coin level 'block' (주의 펌프형·입출금 중단·신규 상장 14일·상장폐지 공지·동결): no new buys
//                      (aggressive sleeve: excluded -> target 0)
//   coin level 'half'  (주의: 입금량 급증·해외 가격 차이): new buys ×0.5
//   altHold            (경보/공지 데이터 없음): alts (not BTC/ETH) no new buys
//   damp.factor        (김프·가격 괴리·테더 김프·코인베이스 프리미엄): new buys ×factor (0 = hold)
const EPS = 1e-9;
const MAJORS = new Set(['KRW-BTC', 'KRW-ETH']);

/**
 * @param {Record<string,number>} targets mutated in place
 * @param {Record<string,string>} notes mutated in place
 * @param {Record<string,number>} weights current weights
 * @param {{coins?:Record<string,{level:string,why:string}>, altHold?:string|null, damp?:{factor:number, reason:string}|null}|null} g
 * @param {{sleeve?:string}} strategy
 */
export function applyMarketGuard(targets, notes, weights, g, strategy) {
  if (!g) return targets;
  const aggressive = strategy?.sleeve === 'aggressive';
  const syms = new Set([...Object.keys(targets), ...(aggressive ? Object.keys(weights) : [])]);
  for (const sym of syms) {
    const cur = weights[sym] || 0;
    const w = targets[sym] || 0;
    const c = g.coins?.[sym];
    if (c && (c.level === 'close' || c.level === 'block')) {
      if (aggressive) {
        if (w > 0 || cur > 0) { targets[sym] = 0; notes[sym] = `시장 신호: ${c.why} → 공격형 슬롯에서 제외`; }
      } else if (w > cur + EPS) { targets[sym] = cur; notes[sym] = `시장 신호: ${c.why} → ${c.level === 'close' ? '청산 전용(새로 사지 않음)' : '새로 사지 않음'}`; }
      continue;
    }
    if (!(sym in targets) || w <= cur + EPS) continue; // only increases are touched
    if (g.altHold && !MAJORS.has(sym)) { targets[sym] = cur; notes[sym] = `시장 신호: ${g.altHold} → 알트코인 새로 사지 않음`; continue; }
    let f = 1;
    const why = [];
    if (c && c.level === 'half') { f = Math.min(f, 0.5); why.push(c.why); }
    if (g.damp && g.damp.factor < 1) { f = Math.min(f, g.damp.factor); why.push(g.damp.reason); }
    if (f < 1) {
      targets[sym] = cur + (w - cur) * f;
      notes[sym] = f === 0 ? `시장 신호(${why.join(', ')}) → 새 매수 보류` : `시장 신호(${why.join(', ')}) → 새로 사는 양 ×${f}`;
    }
  }
  return targets;
}
