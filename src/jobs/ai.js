// AI 판단 (a few times a day). Two providers:
//   1) Cloudflare Workers AI binding `AI` (free 10k neurons/day, no key) — default.
//      AI_MODEL + AI_FALLBACK_MODELS (comma list) pick the models; tried in order.
//   2) Any OpenAI-compatible endpoint (paid later): AI_ENDPOINT, AI_API_KEY (secret), AI_MODEL.
//      When AI_ENDPOINT+AI_API_KEY are set they win over the binding.
// Output is bounded JSON: per symbol score -1..+1 + short reason, plus an optional market veto.
// Scores only SCALE an underlying rule strategy (0.5x..1.0x). Every prompt/response is audited.
import { kvSetStmt } from '../db/store.js';
import { DAY, HOUR } from '../core/calendar.js';
import { symName } from '../config.js';

export const AI_SYMBOLS = ['278530', '379800', 'KRW-BTC', 'KRW-ETH'];
export const DEFAULT_WORKERS_AI_MODELS = ['@cf/deepseek-ai/deepseek-v4.1-flash-1017', '@cf/zai-org/glm-4.7-flash', '@cf/google/gemma-4-26b-a4b-it'];
const useEndpoint = (env) => !!(env.AI_ENDPOINT && env.AI_API_KEY && env.AI_MODEL);
const useBinding = (env) => !!(env.AI && typeof env.AI.run === 'function') && String(env.AI_PROVIDER || 'workers-ai') !== 'off';
export const aiConfigured = (env) => useEndpoint(env) || useBinding(env);
export function aiModels(env) {
  if (useEndpoint(env)) return [String(env.AI_MODEL)];
  const list = [env.AI_MODEL, ...String(env.AI_FALLBACK_MODELS || '').split(',')].map((m) => String(m || '').trim()).filter(Boolean);
  return [...new Set(list.length ? list : DEFAULT_WORKERS_AI_MODELS)];
}
export const aiLabel = (env) => (aiConfigured(env) ? `${useEndpoint(env) ? '' : 'Workers AI · '}${aiModels(env)[0]}` : null);
export const AI_INTERVAL = 6 * HOUR; // 4 calls/day ≈ 2k of the 10k free neurons

// Workers AI responses come back as {response: string|object} or OpenAI-style {choices:[...]}.
export function textOf(out) {
  if (out == null) return null;
  if (typeof out === 'string') return out;
  const r = out.response ?? out.result?.response ?? out.choices?.[0]?.message?.content ?? out.output_text;
  if (r == null) return null;
  return typeof r === 'string' ? r : JSON.stringify(r);
}

async function callModel(env, prompt, fetcher) {
  const messages = [{ role: 'system', content: 'Reply with a single JSON object only. No markdown, no explanation.' }, { role: 'user', content: prompt }];
  if (useEndpoint(env)) {
    const res = await fetcher(`${String(env.AI_ENDPOINT).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({ model: env.AI_MODEL, temperature: 0, messages, response_format: { type: 'json_object' } }),
    });
    const j = await res.json().catch(() => null);
    return { model: String(env.AI_MODEL), text: textOf(j), note: res.ok ? '' : `HTTP_${res.status}` };
  }
  const notes = [];
  for (const model of aiModels(env)) {
    try {
      const out = await env.AI.run(model, { messages, temperature: 0, max_tokens: 900 });
      const text = textOf(out);
      const pr = text ? parseAiResponse(text) : null;
      if (pr && (Object.keys(pr.scores).length || Object.keys(pr.veto).length)) return { model, text, note: notes.join('; ') };
      notes.push(`${model.split('/').pop()}:${text ? 'PARSE' : 'EMPTY'}`);
      if (text) return { model, text, note: notes.join('; ') };
    } catch (e) { notes.push(`${model.split('/').pop()}:${String(e?.message || e).slice(0, 60)}`); }
  }
  return { model: aiModels(env)[0], text: null, note: notes.join('; ').slice(0, 200) };
}

export function buildPrompt(items, syms = AI_SYMBOLS) {
  const lines = items.slice(0, 60).map((i) => `- [${i.sym}] ${i.type}: ${(() => { try { const p = JSON.parse(i.payload); return p.title || p.label || JSON.stringify(p).slice(0, 120); } catch { return ''; } })()}`);
  return [
    'You are a cautious risk assistant for a PAPER-trading research system. You never recommend trades.',
    'From the Korean news titles and indicators below, rate the near-term (1-5 day) downside risk for each symbol.',
    'Return ONLY JSON: {"scores":[{"sym":"<symbol>","score":<number -1..1>,"reason":"<Korean, <=60 chars>"}],"veto":{"krx":"NO_VETO|VETO_NEW_BUYS|REDUCE_HALF","crypto":"NO_VETO|VETO_NEW_BUYS|REDUCE_HALF"}}',
    '-1 = clearly negative news/risk, 0 = neutral or unclear, +1 = clearly benign. If unsure, use 0.',
    `Symbols: ${syms.map((s) => `${s} (${symName(s)})`).join(', ')}`,
    'Items:', ...lines,
  ].join('\n');
}

const VETO = { NO_VETO: 0, REDUCE_HALF: 0.5, VETO_NEW_BUYS: 1 };
export function parseAiResponse(text, syms = AI_SYMBOLS) {
  let j;
  try {
    const raw = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(json)?/g, '').trim();
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    j = JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw);
  } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const scores = {};
  for (const s of Array.isArray(j?.scores) ? j.scores : []) {
    if (!syms.includes(s?.sym)) continue;
    const v = Number(s.score);
    if (!Number.isFinite(v)) continue;
    scores[s.sym] = { score: Math.max(-1, Math.min(1, v)), reason: String(s.reason || '').slice(0, 80) };
  }
  const veto = {};
  for (const m of ['krx', 'crypto']) if (j?.veto?.[m] in VETO) veto[m] = VETO[j.veto[m]];
  return { scores, veto };
}

export async function aiTask(env, kv, now, { fetcher = fetch } = {}) {
  if (!aiConfigured(env)) return false;
  if ((kv['ai:at'] || 0) > now - AI_INTERVAL) return false;
  kv['ai:at'] = now;
  const { results } = await env.DB.prepare('SELECT source, sym, type, payload FROM feed_items WHERE t >= ? ORDER BY t DESC LIMIT 60').bind(now - DAY).all();
  const prompt = buildPrompt(results);
  let text = null, ok = 0, note = '', model = aiModels(env)[0];
  try { ({ text, note, model } = await callModel(env, prompt, fetcher)); } catch (e) { note = String(e?.message || e).slice(0, 100); }
  const parsed = text ? parseAiResponse(text) : null;
  const stmts = [kvSetStmt(env.DB, 'ai:at', now)];
  if (parsed) {
    ok = 1;
    const st = env.DB.prepare('INSERT OR REPLACE INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
    for (const [sym, s] of Object.entries(parsed.scores)) stmts.push(st.bind(sym, now, 'ai_score', s.score, s.reason));
    for (const [m, v] of Object.entries(parsed.veto)) stmts.push(st.bind(`*${m}`, now, 'news_veto', v, 'AI 뉴스 판단'));
  } else note = note || 'PARSE_FAILED (fail-closed: scale 0.5x / veto)';
  stmts.push(env.DB.prepare('INSERT INTO ai_audit (t, model, prompt, response, ok, note) VALUES (?,?,?,?,?,?)').bind(now, String(model), prompt.slice(0, 20000), text ? String(text).slice(0, 20000) : null, ok, note));
  await env.DB.batch(stmts);
  return true;
}
