import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { aiTask, aiConfigured, aiModels, aiLabel, parseAiResponse, textOf, DEFAULT_WORKERS_AI_MODELS } from '../src/jobs/ai.js';

const good = JSON.stringify({ scores: [{ sym: 'KRW-BTC', score: -0.4, reason: '규제 뉴스' }, { sym: 'XXX', score: 1 }], veto: { krx: 'NO_VETO', crypto: 'REDUCE_HALF' } });

test('workers ai binding counts as configured; endpoint wins when set', () => {
  const AI = { run: async () => ({}) };
  assert.equal(aiConfigured({}), false);
  assert.equal(aiConfigured({ AI }), true);
  assert.equal(aiConfigured({ AI, AI_PROVIDER: 'off' }), false);
  assert.deepEqual(aiModels({ AI }), DEFAULT_WORKERS_AI_MODELS);
  assert.deepEqual(aiModels({ AI, AI_MODEL: 'a', AI_FALLBACK_MODELS: 'b, a ,c' }), ['a', 'b', 'c']);
  assert.match(aiLabel({ AI, AI_MODEL: 'a' }), /^Workers AI · a$/);
  assert.equal(aiLabel({ AI, AI_ENDPOINT: 'https://x', AI_API_KEY: 'k', AI_MODEL: 'paid' }), 'paid');
});

test('parse tolerates think blocks, fences and prose', () => {
  assert.equal(textOf({ response: { a: 1 } }), '{"a":1}');
  assert.equal(textOf({ choices: [{ message: { content: 'x' } }] }), 'x');
  const p = parseAiResponse('<think>hmm {not json}</think>\nSure:\n```json\n' + good + '\n```');
  assert.deepEqual(Object.keys(p.scores), ['KRW-BTC']);
  assert.equal(p.veto.crypto, 0.5);
  assert.equal(parseAiResponse('no json here'), null);
});

test('aiTask falls back to the next model and writes signals + audit', async () => {
  const DB = makeD1();
  const calls = [];
  const AI = { run: async (model) => { calls.push(model); if (calls.length === 1) throw new Error('3040 capacity'); return { response: good }; } };
  const env = { DB, AI, AI_MODEL: 'm1', AI_FALLBACK_MODELS: 'm2' };
  const kv = {};
  assert.equal(await aiTask(env, kv, 1_800_000_000), true);
  assert.deepEqual(calls, ['m1', 'm2', 'm2']); // 2nd same-prompt sample on the model that answered (consistency)
  const sig = DB.raw.prepare("SELECT sym, kind, value FROM signals ORDER BY sym").all();
  assert.ok(sig.some((r) => r.sym === 'KRW-BTC' && r.kind === 'ai_score' && r.value === -0.4));
  assert.ok(sig.some((r) => r.sym === '*crypto' && r.kind === 'news_veto' && r.value === 0.5));
  const audit = DB.raw.prepare('SELECT model, ok, note FROM ai_audit').all();
  assert.equal(audit[0].model, 'm2'); assert.equal(audit[0].ok, 1); assert.match(audit[0].note, /m1:3040/);
  // throttled for 6h
  assert.equal(await aiTask(env, kv, 1_800_000_000 + 3600), false);
});

test('aiTask fails closed when every model fails', async () => {
  const DB = makeD1();
  const env = { DB, AI: { run: async () => { throw new Error('down'); } }, AI_MODEL: 'm1' };
  assert.equal(await aiTask(env, {}, 1_800_000_000), true);
  const audit = DB.raw.prepare('SELECT ok, response FROM ai_audit').all();
  assert.equal(audit[0].ok, 0); assert.equal(audit[0].response, null);
  // Conservative snapshot: every AI score -1 (→ 0.5x buys) and both news vetoes on, so stale
  // successes are not reused after a failure.
  const sig = DB.raw.prepare('SELECT kind, value FROM signals').all();
  assert.ok(sig.length > 0);
  assert.ok(sig.filter((r) => r.kind === 'ai_score').every((r) => r.value === -1));
  assert.deepEqual(sig.filter((r) => r.kind === 'news_veto').map((r) => r.value), [1, 1]);
});
