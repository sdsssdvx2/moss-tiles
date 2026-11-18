// 가족 장부(PC 프로그램 FamilyInvest 1.1에서 이식): 신호가 원본 Python signal_for()와 같고, 규칙대로 사고판다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { familySignal, familySelfV1, familyMotherV1 } from '../src/strategies/family.js';
import { runBacktest } from '../src/core/backtest.js';
import { byId, validateStrategy } from '../src/strategies/index.js';
import { makeBars } from './helpers.mjs';

test('familySignal matches the original Python signal_for() on the PC bot\'s stored Yahoo bars (496 days)', () => {
  // fixture: FamilyInvestLab/real-data-paper.sqlite3 bars (278530/379800, 2025-11-10~2026-11-13) + Python signals
  const d = JSON.parse(readFileSync(new URL('./fixtures/familyinvest-parity.json', import.meta.url), 'utf8'));
  let n = 0;
  for (const [sym, v] of Object.entries(d)) {
    v.closes.forEach((_, i) => {
      const js = familySignal(v.closes.slice(Math.max(0, i - 70), i + 1));
      assert.equal(js[0], v.sig[i][0], `${sym} #${i}`);
      assert.ok(Math.abs(js[1] - v.sig[i][1]) < 1e-6, `${sym} #${i} score ${js[1]} vs ${v.sig[i][1]}`);
      n++;
    });
  }
  assert.equal(n, 496);
});

test('family books are registered, valid, research-only, with their own virtual cash', () => {
  for (const s of [familySelfV1, familyMotherV1]) {
    assert.deepEqual(validateStrategy(s), []);
    assert.equal(byId[s.id], s);
    assert.equal(s.researchOnly, true);
  }
  assert.equal(familySelfV1.createState().initialCash, 100_000);
  assert.equal(familyMotherV1.createState().initialCash, 1_000_000);
});

test('family book backtest: caps respected, one new position per day, no top-ups', () => {
  const series = {
    '278530': makeBars({ start: '2024-01-02', n: 400, seed: 11, p0: 30000, drift: 0.0012, vol: 0.008, skipNonKrx: true }),
    '379800': makeBars({ start: '2024-01-02', n: 400, seed: 12, p0: 20000, drift: 0.0010, vol: 0.006, skipNonKrx: true }),
  };
  for (const s of [familySelfV1, familyMotherV1]) {
    const r = runBacktest({ strategy: s, series, meta: { '278530': { etf: true }, '379800': { etf: true } }, fromT: series['278530'][80].t });
    const buys = r.fills.filter((f) => f.side === 'BUY');
    assert.ok(buys.length > 0, s.id);
    const byDay = {};
    for (const f of buys) byDay[f.t] = (byDay[f.t] || 0) + 1;
    assert.ok(Object.values(byDay).every((x) => x === 1), 'at most one buy per day');
    // no top-up: a symbol is bought again only after it was sold
    const held = {};
    for (const f of r.fills) {
      if (f.side === 'BUY') { assert.ok(!held[f.sym], `${s.id} top-up ${f.sym}`); held[f.sym] = true; } else held[f.sym] = false;
    }
    const maxInvested = Math.max(...r.points.map((p) => p.invested / p.equity));
    assert.ok(maxInvested <= (s.id === 'family_self_v1' ? 0.35 : 0.25) + 0.03, `${s.id} invested ${maxInvested}`);
  }
});
