// 2026-11-27 (#F-016): PC 봇 계좌 화면에 있던 '계좌 카드'와 '오늘 판단 근거'를 연구실 가족 탭으로 옮김.
// 판단 근거는 장부가 쓰는 familySignal과 같은 판정이어야 한다(따로 만든 계산이 아님).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeD1 } from './helpers.mjs';
import { familySignal, familySignalDetail } from '../src/strategies/family.js';
import { overview, familyTodayView } from '../src/api.js';
import { allStrategies } from '../src/strategies/index.js';
import { dashboardHtml } from '../src/ui/dashboard.js';

const NOW = Date.UTC(2026, 10, 27, 0, 0) / 1000;
const DAY = 86400;

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
function walk(seed, n, drift, vol, jumpAt = -1) {
  const r = rng(seed); const out = [10000]; for (let i = 1; i < n; i++) { const z = (r() + r() + r() - 1.5) * 2; let px = out[i - 1] * Math.exp(drift + vol * z); if (i === jumpAt) px = out[i - 1] * 1.08; out.push(px); }
  return out;
}

test('familySignalDetail: verdict is familySignal itself, and BUY happens exactly when every check is ok', () => {
  const seen = { BUY: 0, WAIT: 0, SELLvol: 0, SELLtrend: 0, short: 0 };
  const series = [];
  for (let k = 0; k < 12; k++) series.push(walk(11 + k, 260, [0.003, -0.002, 0.0005, 0][k % 4], [0.006, 0.012, 0.03, 0.05][k % 4], 120 + k * 7));
  for (const s of series) for (let e = 30; e <= s.length; e += 3) {
    const w = s.slice(Math.max(0, e - 70), e);
    const d = familySignalDetail(w), f = familySignal(w);
    assert.equal(d.sig, f[0]); assert.equal(d.score, f[1]); assert.equal(d.reason, f[2]);
    if (w.length < 65) { assert.equal(d.checks.length, 0); seen.short++; continue; }
    assert.equal(d.checks.length, 5);
    assert.equal(d.sig === 'BUY', d.checks.every((c) => c.ok));
    if (d.sig === 'BUY') seen.BUY++;
    else if (d.sig === 'WAIT') { seen.WAIT++; assert.ok(!d.checks.find((c) => c.key === 'jump').ok); }
    else if (!d.checks.find((c) => c.key === 'vol').ok) seen.SELLvol++;
    else seen.SELLtrend++;
  }
  for (const k of Object.keys(seen)) assert.ok(seen[k] > 0, `branch ${k} covered`);
});

function seedCandles(DB, rising) {
  const c = DB.raw.prepare("INSERT INTO candles (market, tf, sym, t, o, h, l, c, v, src) VALUES ('krx','1d',?,?,?,?,?,?,1,'test')");
  for (const sym of ['278530', '379800']) for (let i = 0; i < 90; i++) {
    const px = rising ? 10000 * (1 + 0.004 * i) : 30000 * (1 - 0.003 * i);
    c.run(sym, NOW - (90 - i) * DAY, px, px, px, px);
  }
}

test('overview.familyToday: last 70 daily closes per family symbol, same verdict as familySignal; null on error', async () => {
  for (const rising of [true, false]) {
    const DB = makeD1(); seedCandles(DB, rising);
    const o = await overview({ DB }, NOW);
    assert.equal(o.familyToday.syms.length, 2);
    for (const x of o.familyToday.syms) {
      const closes = DB.raw.prepare("SELECT c FROM candles WHERE sym = ? ORDER BY t").all(x.sym).map((r) => r.c).slice(-70);
      assert.equal(x.sig, familySignal(closes)[0]);
      assert.equal(x.sig, rising ? 'BUY' : 'SELL');
      assert.equal(x.t, NOW - DAY);
      assert.ok(x.name);
    }
  }
  const empty = await overview({ DB: makeD1() }, NOW);
  assert.ok(empty.familyToday.syms.every((x) => x.checks.length === 0 && x.sig === 'WAIT'));
  assert.equal(await familyTodayView({ batch() { throw new Error('x'); }, prepare() { return { bind() { return this; } }; } }, allStrategies({})), null);
});

function vmCtx() {
  const html = dashboardHtml();
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const ctx = vm.createContext({ console, setInterval() {}, setTimeout() {}, clearTimeout() {},
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, AbortController,
    document: { addEventListener() {}, querySelector: () => ({ addEventListener() {}, innerHTML: '', style: {}, classList: { add() {}, remove() {} } }), querySelectorAll: () => [] },
    fetch: () => new Promise(() => {}) });
  vm.runInContext(js, ctx);
  return ctx;
}
const chk = (okAll, failKey) => ['above60', 'trend', 'mom', 'vol', 'jump'].map((key) => ({ key, ok: okAll || key !== failKey, value: key === 'vol' ? 0.036 : -0.05, need: key + ' 조건' }));
function data({ F = 'sell', held = false, paperNull = false, invested = 0 } = {}) {
  const book = (id, cash, eq, extra = {}) => ({ id, name: id, stage: 'paper', label: '모의', universe: [{ sym: '379800', name: 'KODEX 미국S&P500TR' }, { sym: '278530', name: 'KODEX 200TR' }],
    risk: { minCash: 0.65, maxPositionWeight: 0.35 }, paper: paperNull ? null : { equity: eq, initial: cash, ret: eq / cash - 1, cash: eq - invested, benchRet: -0.079, fills: held ? 1 : 0, startT: NOW - 10 * DAY, halted: false },
    positions: held ? [{ sym: '278530', name: 'KODEX 200TR', value: invested, weight: invested / eq, pnlPct: -0.02 }] : [], recent: [], pending: [], ...extra });
  const syms = F === 'sell' ? [
    { sym: '379800', name: 'KODEX 미국S&P500TR', t: NOW - DAY, close: 20000, sig: 'SELL', score: -30, reason: '상승 추세 조건 미달', checks: chk(false, 'mom') },
    { sym: '278530', name: 'KODEX 200TR', t: NOW - DAY, close: 30000, sig: 'SELL', score: -100, reason: '변동성', checks: chk(false, 'vol') },
  ] : [
    { sym: '379800', name: 'KODEX 미국S&P500TR', t: NOW - DAY, close: 20000, sig: 'BUY', score: 5, reason: 'ok', checks: chk(true) },
    { sym: '278530', name: 'KODEX 200TR', t: NOW - DAY, close: 30000, sig: 'BUY', score: 9, reason: 'ok', checks: chk(true) },
  ];
  return {
    members: { members: [{ key: 'self', label: '본인', bookId: 'family_self_v1', budgetKrw: 100000, profile: 'careful' }], profiles: {}, limits: { nameMax: 10, minKrw: 10000, maxKrw: 1e8, maxActive: 6 }, past: [], log: [] },
    strategies: [book('family_self_v1', 100000, 100000)],
    familyToday: F ? { syms } : null,
  };
}

test('family tab: account card (equity, invested bar with cap tick, buy-and-hold) and per-condition reasons', () => {
  const ctx = vmCtx();
  ctx.d = data();
  const h = vm.runInContext('DATA=d; viewFamily()', ctx);
  assert.match(h, /본인 장부/);
  assert.match(h, /100,000원/);
  assert.match(h, /class="cap" style="left:35\.0%"/);
  assert.match(h, /투자 비율 <b>0%<\/b> · 상한 35%/);
  assert.match(h, /KODEX 200TR을 그냥 들고 있었으면 <b class="down">-7\.9%<\/b>/);
  assert.match(h, /11-26 종가 기준/);
  assert.match(h, /KODEX 200TR<\/b> — <span class="">안 삼 — 변동성 3\.60%\(3\.5% 이하여야\)/); // 11-27 문구 짧게(진행.md에 이유)
  assert.match(h, /사는 조건 하나씩 보기/);
  assert.match(h, /<span class="ck no">✗<\/span>vol 조건/);
  assert.match(h, /아직 없어요 — 사는 조건이 맞은 날이 없었어요/);
  assert.match(h, /가족 구성원과 금액/); // 설정 양식은 그대로 아래에
  const top = vm.runInContext('famNow()', ctx);
  assert.match(top, /가족 장부 지금/);
  assert.match(top, /data-gotab="family"/);
  assert.match(top, /KODEX 200TR 안 삼\(변동성 3\.60%\(3\.5% 이하여야\)\)/); // 11-27 문구 짧게(진행.md에 이유)
});

test('family tab: BUY picks only the higher score, held symbol says hold, a full cap says no room', () => {
  const ctx = vmCtx();
  ctx.d = data({ F: 'buy' });
  let h = vm.runInContext('DATA=d; viewFamily()', ctx);
  assert.match(h, /KODEX 200TR<\/b> — <span class="buy">사는 조건 맞음 — 다음 거래일 시가에 삼/);
  assert.match(h, /KODEX 미국S&amp;P500TR<\/b> — <span class="">사는 조건 맞음 — 같은 날엔 점수 높은 한 종목만/);
  ctx.d = data({ F: 'buy', held: true, invested: 35000 });
  h = vm.runInContext('DATA=d; viewFamily()', ctx);
  assert.match(h, /KODEX 200TR<\/b> — <span class="">계속 보유/);
  assert.match(h, /KODEX 미국S&amp;P500TR<\/b> — <span class="">사는 조건 맞음 — 투자 상한이 차서 안 삼/);
  assert.match(h, /<h3>보유<\/h3>/);
});

test('family tab still renders without the new field (old cache) and for a book that has not started', () => {
  const ctx = vmCtx();
  ctx.d = data({ F: null });
  const h = vm.runInContext('DATA=d; viewFamily()', ctx);
  assert.match(h, /판단 근거를 불러오는 중이에요/);
  assert.ok(!/오늘 판단/.test(h));
  assert.doesNotThrow(() => vm.runInContext('famNow()', ctx));
  ctx.d = data({ paperNull: true });
  assert.match(vm.runInContext('DATA=d; viewFamily()', ctx), /새 장부가 다음 거래일부터 시작해요/);
  assert.match(vm.runInContext('famNow()', ctx), /다음 거래일부터 시작/);
});

test('phone width: tiles show 만 원, a symbol failing many conditions shows two and "외 N개" (full list stays in the rules card)', () => {
  const ctx = vmCtx();
  ctx.d = data();
  ctx.d.familyToday.syms[1].checks = ctx.d.familyToday.syms[1].checks.map((c) => ({ ...c, ok: false }));
  const h = vm.runInContext('DATA=d; viewFamily()', ctx);
  assert.match(h, /<div class="k">원금<\/div><div class="v num">10만 원<\/div>/);
  assert.match(h, /KODEX 200TR<\/b> — <span class="">안 삼 — 60일 수익률 -5\.0%\(\+2\.5% 넘어야\) · 변동성 3\.60%\(3\.5% 이하여야\) 외 3개/);
  assert.equal((h.match(/<span class="ck no">✗<\/span>/g) || []).length, 6); // 하나씩 보기 카드엔 전부(1 + 5)
  assert.match(vm.runInContext('manw(1000000)+"|"+manw(35000)+"|"+manw(9000)', ctx), /^100만 원\|3\.5만 원\|9,000원$/);
  assert.match(dashboardHtml(), /\.fam \.mrow input\{width:100%\}/);
});
