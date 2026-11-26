// 2026-11-26 (#F-015): "수익률 어때?"에 '+0.0%' 하나만 말하지 않고 장부별 숫자와 까닭(가족 장부가 왜 0%인지)을 같이 답한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { ask, askContext, factLines, ruleAnswer, ledgerSummary } from '../src/jobs/ask.js';
import { familySignal } from '../src/strategies/family.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0) / 1000; // 2026-11-26 21:00 KST
const DAY = 86400;
const T0 = Date.UTC(2026, 10, 16) / 1000;

function seed(DB, { rising = false } = {}) {
  const run = DB.raw.prepare("INSERT INTO runs (id, strategy_id, mode, state, updated_at) VALUES (?, ?, 'paper', '{}', ?)");
  const eq = DB.raw.prepare('INSERT INTO equity (run_id, t, equity, cash, invested, bench) VALUES (?,?,?,?,?,?)');
  const fill = DB.raw.prepare("INSERT INTO fills (run_id, t, seq, sym, side, qty, price, gross, fee, tax, pnl, reason, cash) VALUES (?,?,1,'X','BUY',1,1,1,0,0,0,'r',1)");
  const book = (id, e0, e1, b0, b1, trades) => {
    run.run(`${id}:paper`, id, NOW);
    eq.run(`${id}:paper`, T0, e0, e0, 0, b0);
    eq.run(`${id}:paper`, T0 + 9 * DAY, e1, e1, 0, b1);
    for (let i = 0; i < trades; i++) fill.run(`${id}:paper`, T0 + (i + 1) * DAY);
  };
  book('family_self_v1', 100000, 100000, 100000, 92122, 0);
  book('family_mother_v1', 1000000, 1000000, 1000000, 921221, 0);
  book('btc_perp_lev3_v1', 1e7, 10682694, 1e7, 9555465, 1);
  book('crypto_bh_v1', 1e7, 9117715, 1e7, 9116833, 1);
  book('krx_bh_v1', 1e7, 9383541, 1e7, 9153448, 1);
  book('krx_trend_v1', 1e7, 1e7, 1e7, 9153942, 0);
  const c = DB.raw.prepare("INSERT INTO candles (market, tf, sym, t, o, h, l, c, v, src) VALUES ('krx','1d',?,?,?,?,?,?,1,'test')");
  for (const sym of ['278530', '379800']) for (let i = 0; i < 110; i++) {
    const t = T0 - (100 - i) * DAY;
    const px = rising ? 10000 * (1 + 0.004 * i) : 30000 * (1 - 0.003 * i); // 내림: 추세 조건 미달 → SELL
    c.run(sym, t, px, px, px, px);
  }
}

test('ledger summary: counts traded/idle books, best/worst, buy-and-hold, and why family books are at 0%', async () => {
  const DB = makeD1(); seed(DB);
  const lg = await ledgerSummary({ DB }, {}, NOW);
  assert.equal(lg.n, 6);
  assert.equal(lg.traded, 3);
  assert.equal(lg.idle, 3);
  assert.equal(lg.best.id, 'btc_perp_lev3_v1');
  assert.equal(lg.worst.id, 'crypto_bh_v1');
  assert.equal(lg.family.length, 2);
  assert.equal(lg.familySig.buyDays, 0); // 내림장 → 모의 시작 뒤 사는 조건이 맞은 날 없음
  assert.ok(lg.familySig.days >= 9);
  const lines = factLines({ members: { members: [], profiles: {} }, ai: [], trades: [], ledgers: lg, now: NOW });
  const all = lines.join('\n');
  assert.match(all, /가상 장부 6개 중 3개가 실제로 가상 거래/);
  assert.match(all, /가장 좋은 장부: .*\+6\.8%.*가장 나쁜 장부: .*-8\.8%/);
  assert.match(all, /그냥 사서 들고 있었으면: 국내 주식 ETF\(KODEX 200TR\) -6\.2%, 비트코인 -8\.8%/);
  assert.match(all, /가족 장부\(본인 아직 한 번도 안 삼, 0% \/ 어머니 아직 한 번도 안 삼, 0%\): 사는 조건.*한 번도 안 맞았어요 — 규칙대로/);
  assert.match(all, /12-06/);
});

test('"모의투자 수익률 지금 어떤 편이야?" -> rule answer gives the numbers and the reason, not just 0%', async () => {
  const DB = makeD1(); seed(DB);
  const r = await ask({ DB }, {}, '모의투자 수익률 지금 어떤 편이야?', NOW);
  assert.equal(r.source, 'rule');
  assert.match(r.answer, /가상 장부 6개 중 3개/);
  assert.match(r.answer, /가족 장부/);
  assert.match(r.answer, /그냥 사서 들고 있었으면/);
});

test('family BUY days are counted from the same signal the family books use (rising market -> buy days > 0)', async () => {
  const DB = makeD1(); seed(DB, { rising: true });
  const lg = await ledgerSummary({ DB }, {}, NOW);
  const closes = DB.raw.prepare("SELECT c FROM candles WHERE sym = '278530' ORDER BY t").all().map((x) => x.c);
  assert.equal(familySignal(closes.slice(-70))[0], 'BUY');
  assert.ok(lg.familySig.buyDays > 0);
  assert.match(ruleAnswer('수익 얼마야?', await askContext({ DB }, {}, NOW)), /번 맞았어요/);
});

test('no ledgers / DB error -> no ledger lines, answer still works', async () => {
  const DB = makeD1();
  assert.equal(await ledgerSummary({ DB }, {}, NOW), null);
  assert.equal(await ledgerSummary({ DB: { prepare() { throw new Error('x'); } } }, {}, NOW), null);
  const r = await ask({ DB }, {}, '수익률 어때?', NOW);
  assert.match(r.answer, /아직 가상 장부의 평가 기록이 없어요/);
});
