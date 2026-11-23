// 2026-11-24 #F-002 ③ / #F-003: 공시(DART) 비교 — 본 AI와 입력만 다른 쌍둥이 점수(ai_score_disc)와 비교 장부.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { aiTask, aiDiscTask, AI_SYMBOLS, AI_DISC_INTERVAL } from '../src/jobs/ai.js';
import { withAiScale } from '../src/strategies/research-set.js';
import { STRATEGIES } from '../src/strategies/index.js';
import { signalsFor } from '../src/jobs/paper.js';

const NOW = 1_800_000_000;
const DISC_HEAD = 'Korean corporate disclosures';
const answer = (score) => JSON.stringify({ scores: AI_SYMBOLS.map((sym) => ({ sym, score, basis: ['trend'], reason: `점수 ${score}` })), veto: { krx: 'NO_VETO', crypto: 'NO_VETO' } });

function setup({ disclosures = true, discFails = false } = {}) {
  const DB = makeD1();
  const ins = DB.raw.prepare('INSERT INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)');
  ins.run('news_kr', NOW - 100, '*krx', 'headline', JSON.stringify({ title: '뉴스제목' }), NOW);
  if (disclosures) {
    ins.run('dart', NOW - 200, '005930', 'disclosure', JSON.stringify({ corp: '삼성전자', title: '주요사항보고서(자기주식취득결정)' }), NOW);
    ins.run('dart', NOW - 300, '000660', 'disclosure', JSON.stringify({ corp: 'SK하이닉스', title: '기업설명회(IR)개최   ' }), NOW);
  }
  const prompts = [];
  const AI = { run: async (_m, { messages }) => {
    const p = messages[1].content; prompts.push(p);
    if (p.includes(DISC_HEAD)) { if (discFails) throw new Error('3040 capacity'); return { response: answer(-0.4) }; }
    return { response: answer(0.2) };
  } };
  return { DB, prompts, env: { DB, AI, AI_PROVIDER: 'workers-ai' } };
}
const rows = (DB, sql) => DB.raw.prepare(sql).all();

test('main AI prompt and stored rows are identical with or without disclosures', async () => {
  const a = setup({ disclosures: false }), b = setup({ disclosures: true });
  await aiTask(a.env, {}, NOW); await aiTask(b.env, {}, NOW);
  assert.deepEqual(a.prompts, b.prompts);
  const q = "SELECT sym, t, kind, value, note FROM signals ORDER BY sym, kind";
  assert.deepEqual(rows(a.DB, q), rows(b.DB, q));
});

test('disc twin: next tick only, main prompt + disclosure section, same pipeline, main rows untouched', async () => {
  const { DB, env, prompts } = setup();
  const kv = {};
  await aiTask(env, kv, NOW);
  assert.equal(await aiDiscTask(env, kv, NOW), false, 'not in the same tick as the main AI');
  const before = rows(DB, "SELECT * FROM signals WHERE kind != 'ai_score_disc' ORDER BY sym, kind");
  const auditBefore = rows(DB, 'SELECT * FROM ai_audit ORDER BY id');
  const mainPrompt = prompts[0];
  const n0 = prompts.length;
  assert.equal(await aiDiscTask(env, kv, NOW + 600), true);
  const discPrompts = prompts.slice(n0);
  assert.equal(discPrompts.length, n0, 'same number of calls as the main pipeline (2 samples + cross model)');
  assert.ok(discPrompts.every((p) => p.startsWith(mainPrompt + '\n') && p.includes(DISC_HEAD) && p.includes('삼성전자: 주요사항보고서(자기주식취득결정)') && p.includes('SK하이닉스: 기업설명회(IR)개최')));
  assert.deepEqual(rows(DB, "SELECT * FROM signals WHERE kind != 'ai_score_disc' ORDER BY sym, kind"), before);
  assert.deepEqual(rows(DB, 'SELECT * FROM ai_audit ORDER BY id').slice(0, auditBefore.length), auditBefore);
  const disc = rows(DB, "SELECT sym, t, value FROM signals WHERE kind = 'ai_score_disc' ORDER BY sym");
  assert.equal(disc.length, AI_SYMBOLS.length);
  assert.ok(disc.every((r) => r.t === NOW + 600 && r.value === -0.4));
  const h = kv['ai:disc:hist'].at(-1);
  assert.equal(h.n, 2); assert.equal(h.scores['278530'].main, 0.2); assert.equal(h.scores['278530'].disc, -0.4);
  assert.match(rows(DB, 'SELECT prompt, note FROM ai_audit ORDER BY id DESC LIMIT 1')[0].prompt, /^\(공시 포함 비교, 공시 2건\)/);
  // 같은 본 판단으로는 다시 안 함, 12시간 안에도 안 함
  assert.equal(await aiDiscTask(env, kv, NOW + 1200), false);
});

test('disc failure: main rows unchanged, twin fails closed (-1), no retry every tick', async () => {
  const { DB, env, prompts } = setup({ discFails: true });
  const kv = {};
  await aiTask(env, kv, NOW);
  const before = rows(DB, "SELECT * FROM signals ORDER BY sym, kind");
  const n0 = prompts.length;
  assert.equal(await aiDiscTask(env, kv, NOW + 600), true);
  assert.deepEqual(rows(DB, "SELECT * FROM signals WHERE kind != 'ai_score_disc' ORDER BY sym, kind"), before);
  assert.ok(rows(DB, "SELECT value FROM signals WHERE kind = 'ai_score_disc'").every((r) => r.value === -1));
  // 저장된 시각 덕분에 kv를 새로 읽어도(다음 틱) 다시 부르지 않음
  const kv2 = Object.fromEntries(rows(DB, 'SELECT k, v FROM kv').map((r) => [r.k, JSON.parse(r.v)]));
  const n1 = prompts.length;
  assert.equal(await aiDiscTask(env, kv2, NOW + 1200), false);
  assert.equal(prompts.length, n1);
  assert.ok(n1 > n0);
  // 새 본 판단 + 12시간 뒤에는 다시
  await aiTask(env, kv2, NOW + AI_DISC_INTERVAL);
  assert.equal(await aiDiscTask(env, kv2, NOW + AI_DISC_INTERVAL + 600), true);
});

test('no disclosures: no AI call, twin copies the main scores', async () => {
  const { DB, env, prompts } = setup({ disclosures: false });
  const kv = {};
  await aiTask(env, kv, NOW);
  const n0 = prompts.length;
  assert.equal(await aiDiscTask(env, kv, NOW + 600), true);
  assert.equal(prompts.length, n0);
  const disc = rows(DB, "SELECT value, note FROM signals WHERE kind = 'ai_score_disc'");
  assert.equal(disc.length, AI_SYMBOLS.length);
  assert.ok(disc.every((r) => r.value === 0.2 && /공시 없음/.test(r.note)));
});

test('disc book reads only the disclosure score; the existing AI book is unchanged', () => {
  const base = { family: 'x', version: 1, name: 'n', description: 'd', decide: () => ({ targets: { A: 1 } }) };
  const ctx = { weights: {}, t: NOW, signals: { aiRequired: true, ai: { A: { score: 1 } }, aiDisc: { A: { score: -1 } } } };
  assert.equal(withAiScale(base).decide(ctx).targets.A, 1);
  assert.equal(withAiScale(base, { disc: true }).decide(ctx).targets.A, 0.5);
  assert.equal(withAiScale(base).id, 'x_ai_v1');
  const s = STRATEGIES.find((x) => x.id === 'etf_trend_aidisc_v1');
  assert.ok(s && s.researchOnly && s.overlayOf === 'etf_trend_v1' && s.family === 'etf_trend_aidisc' && s.aiDisclosure);
  assert.ok(STRATEGIES.find((x) => x.id === 'etf_trend_ai_v1' && !x.aiDisclosure));
});

test('paper signal view exposes ai_score_disc as aiDisc', async () => {
  const DB = makeD1();
  const st = DB.raw.prepare('INSERT INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  st.run('278530', NOW, 'ai_score', 0.3, 'main'); st.run('278530', NOW, 'ai_score_disc', -0.2, 'disc');
  const s = STRATEGIES.find((x) => x.id === 'etf_trend_aidisc_v1');
  const view = await signalsFor({ DB, AI: { run: async () => ({}) } }, s, NOW - 86400, NOW + 86400);
  const v = view(NOW + 3600);
  assert.equal(v.ai['278530'].score, 0.3);
  assert.equal(v.aiDisc['278530'].score, -0.2);
});
