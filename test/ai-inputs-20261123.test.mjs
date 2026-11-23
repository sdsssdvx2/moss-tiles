// 2026-11-23 #F-002 ③: DART 공시·뉴스레터는 지금 AI 장부 입력에 들어가지 않는다(비교 장부에서만 시험할 것).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { aiTask, AI_MAIN_EXCLUDED_TYPES } from '../src/jobs/ai.js';

test('main AI prompt excludes disclosure/newsletter feed items but keeps news', async () => {
  assert.ok(AI_MAIN_EXCLUDED_TYPES.includes('disclosure') && AI_MAIN_EXCLUDED_TYPES.includes('newsletter'));
  const DB = makeD1();
  const now = 1_800_000_000;
  const ins = DB.raw.prepare('INSERT INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)');
  ins.run('news_kr', now - 100, '*krx', 'headline', JSON.stringify({ title: '뉴스제목-포함되어야함' }), now);
  ins.run('dart', now - 100, '005930', 'disclosure', JSON.stringify({ corp: '공시회사', title: '공시제목-빠져야함' }), now);
  ins.run('letter', now - 100, '*', 'newsletter', JSON.stringify({ title: '뉴스레터-빠져야함' }), now);
  let prompt = '';
  const env = { DB, AI_PROVIDER: 'workers-ai', AI_SAMPLES: '1', AI_CROSS_MODEL: 'off', AI: { run: async (_m, { messages }) => { prompt = messages.map((x) => x.content).join('\n'); return { response: '{"scores":[]}' }; } } };
  await aiTask(env, {}, now);
  assert.match(prompt, /뉴스제목-포함되어야함/);
  assert.doesNotMatch(prompt, /공시제목-빠져야함|뉴스레터-빠져야함/);
});
