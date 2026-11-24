// 2026-11-24 #F-009 ① (무인운영 점검표 3번): Workers AI 무료 한도(하루 1만 뉴런)를 넘으면 어떻게 되나.
// 모든 모델이 4006(무료 한도 소진)을 던져도 틱이 죽지 않고, AI 장부는 '점수 없음 → 신규 매수 0.5배'로 안전하게 떨어지며,
// 한도를 두드리며 다시 부르지 않는다(다음 판단 시각까지 기다림).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { aiTask, AI_SYMBOLS, AI_INTERVAL } from '../src/jobs/ai.js';

const NOW = 1_800_000_000;
const QUOTA = '4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan';

function setup() {
  const DB = makeD1();
  DB.raw.prepare('INSERT INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)').run('news_kr', NOW - 100, '*krx', 'headline', JSON.stringify({ title: '뉴스제목' }), NOW);
  let calls = 0;
  const AI = { run: async () => { calls++; throw new Error(QUOTA); } };
  return { DB, env: { DB, AI, AI_PROVIDER: 'workers-ai' }, calls: () => calls };
}

test('quota exhausted on every free model: tick survives, AI books fall back to -1 (new buys x0.5), reason recorded', async () => {
  const { DB, env, calls } = setup();
  const kv = {};
  await aiTask(env, kv, NOW); // 던지지 않음
  assert.ok(calls() >= 1);
  const sc = DB.raw.prepare("SELECT sym, value, note FROM signals WHERE kind = 'ai_score' ORDER BY sym").all();
  assert.deepEqual(sc.map((r) => r.sym).sort(), [...AI_SYMBOLS].sort());
  for (const r of sc) { assert.equal(r.value, -1, r.sym); assert.match(r.note, /AI 결과 없음/); }
  const au = DB.raw.prepare('SELECT * FROM ai_audit').all();
  assert.equal(au.length, 1);
  assert.match(JSON.stringify(au[0]), /4006/); // 왜 안 됐는지가 기록에 남음
});

test('quota exhausted: no hammering — the next ticks before the next AI slot do not call the model again', async () => {
  const { env, calls } = setup();
  const kv = {};
  await aiTask(env, kv, NOW);
  const n = calls();
  for (let i = 1; i <= 5; i++) await aiTask(env, kv, NOW + i * 600);
  assert.equal(calls(), n);
  await aiTask(env, kv, NOW + AI_INTERVAL + 60); // 다음 판단 시각에는 다시 시도(한도는 UTC 자정에 다시 참)
  assert.ok(calls() > n);
});
