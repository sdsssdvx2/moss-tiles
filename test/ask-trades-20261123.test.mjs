// 2026-11-23: "왜 이걸 샀어?"에 실제 가상 거래 기록(체결과 그때의 이유)으로 답한다(계획서 2-8 끝난 기준 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { ask, askContext, ruleAnswer, pickTrades, factLines } from '../src/jobs/ask.js';

const NOW = Date.UTC(2026, 10, 23, 7, 0) / 1000; // 2026-11-23 16:00 KST
const H = 3600;
function seed(DB) {
  const ins = DB.raw.prepare('INSERT INTO fills (run_id, t, seq, sym, side, qty, price, gross, fee, tax, pnl, reason, cash, phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('crypto_trend1h_v1:paper', NOW - 3 * H, 1, 'KRW-BTC', 'BUY', 0.036, 83664000, 3e6, 450, 0, 0, '비트코인: 1시간봉 24시간 평균이 72시간 평균 위로 올라가서 매수', 5e6, null);
  ins.run('etf_dualmom_v1:paper', NOW - 4 * 86400, 1, '278530', 'BUY', 104, 29015, 3e6, 450, 0, 0, 'KODEX 200TR: 12개월 수익 +40.9% > 단기채권 +2.5% → 보유', 5e6, null);
  ins.run('etf_dualmom_v1:bt', NOW - 4 * 86400, 1, '278530', 'BUY', 1, 1, 1, 0, 0, 0, '백테스트 기록은 답에 쓰지 않음', 1, null);
  ins.run('etf_trend_v1:paper', NOW - 30 * 86400, 1, '278530', 'BUY', 1, 1, 1, 0, 0, 0, '너무 오래된 기록', 1, null);
}

test('ask context carries recent paper trades with their reasons (no backtest rows, no old rows)', async () => {
  const DB = makeD1(); seed(DB);
  const ctx = await askContext({ DB }, {}, NOW);
  assert.equal(ctx.trades.length, 2);
  assert.equal(ctx.trades[0].symName, '비트코인');
  assert.equal(ctx.trades[0].act, '매수');
  assert.ok(factLines(ctx).some((l) => l.includes('그때 규칙이 적은 이유') && l.includes('72시간 평균')));
});

test('"왜 이걸 샀어?" -> rule answer cites the actual trade and its reason', async () => {
  const DB = makeD1(); seed(DB);
  const r = await ask({ DB }, {}, '왜 이걸 샀어?', NOW);
  assert.equal(r.source, 'rule');
  assert.match(r.answer, /비트코인 매수 — 이유: 비트코인: 1시간봉 24시간 평균이 72시간 평균 위로/);
  assert.match(r.answer, /KODEX 200TR/);
  assert.doesNotMatch(r.answer, /백테스트 기록은 답에 쓰지 않음|너무 오래된 기록/);
});

test('a named asset narrows the trades; "왜 안 샀어" / 실거래 are not trade questions', async () => {
  const DB = makeD1(); seed(DB);
  const ctx = await askContext({ DB }, {}, NOW);
  assert.deepEqual(pickTrades('KODEX 왜 샀어?', ctx.trades).map((x) => x.sym), ['278530']);
  assert.doesNotMatch(ruleAnswer('왜 안 샀어?', ctx), /가상 장부가 실제로 사고판 기록/);
  assert.doesNotMatch(ruleAnswer('실거래는 언제 해?', ctx), /가상 장부가 실제로 사고판 기록/);
});

test('no trades -> says so plainly (cash waiting), never an error', async () => {
  const DB = makeD1();
  const r = await ask({ DB }, {}, '최근에 뭘 왜 샀어?', NOW);
  assert.match(r.answer, /사고판 기록이 없어요/);
});
