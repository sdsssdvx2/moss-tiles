// 2026-11-23: (1) '연결해도 되는 단계' 문구가 권유처럼 읽히지 않게(선발 결과는 그대로) (2) 오래전 한 번 실패한 출처가 매일 '데이터 문제'로 찍히지 않게.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { decideAll } from '../src/core/decision.js';
import { dailySummaryText } from '../src/jobs/notify.js';

const NOW = Date.UTC(2026, 10, 18, 6, 0) / 1000;
const DAY = 86400;
const good = (over = {}) => ({
  id: 'etf_voltarget_v1', name: 'E. ETF 변동성 목표 조절 (매월)', market: 'krx', stage: 'live_candidate',
  bt: { dsrLab: 0.6, sharpe: 1.5, mdd: 0.08 },
  paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 13, ret: 0.03, rmRet: 0.02, mdd: 0.04, halted: false, vol: 0.08 }, ...over,
});
const growthSpot = () => good({ id: 'crypto_trend_growth_v1', name: '공격 장부: 비트·이더 추세 크게(현물, 최대 90%)', market: 'crypto', growthCandidate: true,
  bt: { dsrLab: 0.7, sharpe: 1.2, mdd: 0.2 }, paper: { startT: NOW - 120 * DAY, days: 120, rebalances: 14, ret: 0.18, rmRet: 0.05, mdd: 0.22, halted: false, vol: 0.45 } });

test('safe pass: connect line says no order function yet + one more real-trading check (selection unchanged)', () => {
  const d = decideAll([good()], { now: NOW });
  assert.equal(d.verdict, 'ready');
  assert.match(d.connect.text, /실제 주문 기능은 아직 없고/);
  assert.doesNotMatch(d.connect.text, /연결해도 되는 단계/);
});

test('growth-only pass: never says "시작해도 되는 단계"; connect says 아직', () => {
  const d = decideAll([growthSpot()], { now: NOW });
  assert.equal(d.recommend.book, 'growth'); // 선발 결과는 그대로
  assert.doesNotMatch(`${d.headline}\n${d.connect.text}`, /시작해도 되는 단계|연결해도 되는 단계/);
  assert.match(d.connect.text, /^실제 돈 연결: 아직 아니에요/);
});

test('daily summary: only failures from the last 2 days are listed as data problems', async () => {
  const DB = makeD1();
  const now = NOW + 10 * DAY;
  DB.raw.prepare("INSERT INTO data_health (source, last_ok, last_err, err, ok_count, err_count) VALUES ('krx:navbf', NULL, ?, 'KRX_AUTH', 0, 1), ('feed:news_kr', ?, ?, 'NEWS_HTTP_503', 1, 1)")
    .run(now - 4 * DAY, now - 3 * 3600, now - 3600);
  const text = await dailySummaryText({ DB }, now);
  assert.match(text, /데이터 문제: feed:news_kr/);
  assert.doesNotMatch(text, /krx:navbf/);
});

test('AI prompt: a very long fact list never cuts off the question', async () => {
  const { askPrompt, askContext } = await import('../src/jobs/ask.js');
  const ctx = await askContext({ DB: makeD1() }, {}, NOW);
  ctx.trades = Array.from({ length: 40 }, (_, i) => ({ when: '11-23 13:00', strategy: '아주 긴 전략 이름 '.repeat(5), symName: '비트코인', act: '매수', reason: '긴 이유 '.repeat(40) + i }));
  const p = askPrompt('왜 이걸 샀어?', ctx);
  assert.ok(p.length <= 9000);
  assert.match(p, /질문: 왜 이걸 샀어\?$/);
});
