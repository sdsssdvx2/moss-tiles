// AI 판단 (a few times a day). Two providers:
//   1) Cloudflare Workers AI binding `AI` (free 10k neurons/day, no key) — default.
//      AI_MODEL + AI_FALLBACK_MODELS (comma list) pick the models; tried in order.
//   2) Any OpenAI-compatible endpoint (paid later): AI_ENDPOINT, AI_API_KEY (secret), AI_MODEL.
//      When AI_ENDPOINT+AI_API_KEY are set they win over the binding.
// Output is bounded JSON: per symbol score -1..+1 + short reason, plus an optional market veto.
// Scores only SCALE an underlying rule strategy (0.5x..1.0x). Every prompt/response is audited.
import { kvSetStmt } from '../db/store.js';
import { DAY, HOUR } from '../core/calendar.js';
import { symName, KRX_STOCKS, CRYPTO_CORE } from '../config.js';
import { sma } from '../core/indicators.js';
import { realizedVol } from '../strategies/common.js';
import { scorecardTask, calibrationLines } from './ai-scorecard.js';

export const AI_SYMBOLS = ['278530', '379800', 'KRW-BTC', 'KRW-ETH'];
// Free-plan models verified 2026-11-16 (deepseek-v4.x needs Workers Paid → 5035). gpt-oss with low reasoning ≈ 22 neurons/call.
export const DEFAULT_WORKERS_AI_MODELS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/zai-org/glm-4.7-flash'];
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

async function callModel(env, prompt, fetcher, onlyModel = null) {
  const messages = [{ role: 'system', content: 'Reply with a single JSON object only. No markdown, no explanation.' }, { role: 'user', content: prompt }];
  if (useEndpoint(env)) {
    const res = await fetcher(`${String(env.AI_ENDPOINT).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({ model: env.AI_MODEL, temperature: 0, messages, response_format: { type: 'json_object' } }),
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const j = await res.json().catch(() => null);
    return { model: String(env.AI_MODEL), text: textOf(j), note: res.ok ? '' : `HTTP_${res.status}` };
  }
  const notes = [];
  for (const model of onlyModel ? [onlyModel] : aiModels(env)) {
    try {
      // reasoning models spend tokens thinking before the answer: generous cap, and low effort where supported
      const out = await env.AI.run(model, { messages, temperature: 0, max_tokens: 3000, ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}) });
      const text = textOf(out);
      const pr = text ? parseAiResponse(text) : null;
      if (pr && (Object.keys(pr.scores).length || Object.keys(pr.veto).length)) return { model, text, note: notes.join('; ') };
      notes.push(`${model.split('/').pop()}:${text ? 'PARSE' : 'EMPTY'}`);
      // Empty, malformed or schema-invalid text must also try the next model.
    } catch (e) { notes.push(`${model.split('/').pop()}:${String(e?.message || e).slice(0, 60)}`); }
  }
  return { model: aiModels(env)[0], text: null, note: notes.join('; ').slice(0, 200) };
}

// ---------- market context for the prompt (2026-11-18): price structure, volatility, market breadth ----------
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : null);
/** Per-symbol price structure from daily closes (oldest -> newest). Pure. */
export function priceFeatures(bars, ppy = 252) {
  const c = (bars || []).map((b) => b.c);
  if (c.length < 25) return null;
  const last = c[c.length - 1];
  const ret = (n) => (c.length > n ? last / c[c.length - 1 - n] - 1 : NaN);
  const hi = Math.max(...c.slice(-252));
  return {
    ret5: r1(ret(5)), ret20: r1(ret(20)), ret60: r1(ret(60)),
    vsSma50: r1(last / sma(c, 50) - 1), vsSma200: r1(last / sma(c, 200) - 1),
    vol20: r1(realizedVol(c, 20, ppy)), ddFromHigh: r1(last / hi - 1),
  };
}
/** Share of symbols whose last close is above their window average (approx. 200 trading days / 50 days). */
export async function breadth(env, market, syms, fromT) {
  const ph = syms.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT sym, AVG(c) AS avg, COUNT(*) AS n, (SELECT c FROM candles c2 WHERE c2.market = c1.market AND c2.tf = '1d' AND c2.sym = c1.sym ORDER BY t DESC LIMIT 1) AS last FROM candles c1 WHERE market = ? AND tf = '1d' AND sym IN (${ph}) AND t >= ? GROUP BY sym`)
    .bind(market, ...syms, fromT).all();
  const ok = results.filter((r) => r.n >= 20 && r.last > 0);
  return ok.length ? { above: ok.filter((r) => r.last > r.avg).length, total: ok.length } : null;
}
export async function marketContext(env, now, syms = AI_SYMBOLS) {
  const out = { features: {}, breadth: {} };
  try {
    for (const [market, list] of [['krx', syms.filter((s) => !s.startsWith('KRW-'))], ['crypto', syms.filter((s) => s.startsWith('KRW-'))]]) {
      if (!list.length) continue;
      const { results } = await env.DB.prepare(`SELECT sym, t, c FROM candles WHERE market = ? AND tf = '1d' AND sym IN (${list.map(() => '?').join(',')}) AND t >= ? ORDER BY sym, t`)
        .bind(market, ...list, now - 400 * DAY).all();
      for (const sym of list) out.features[sym] = priceFeatures(results.filter((r) => r.sym === sym), market === 'krx' ? 252 : 365);
    }
    out.breadth.krx = await breadth(env, 'krx', Object.keys(KRX_STOCKS), now - 290 * DAY); // ≈200 거래일
    out.breadth.crypto = await breadth(env, 'crypto', CRYPTO_CORE, now - 50 * DAY);
  } catch (_) { /* context is optional: the prompt says "not available" */ }
  return out;
}

/** 세계 지표·온체인 줄(최근 3일, 지표별 최신 하나). feeds 'macro'·'crypto_global'이 모은 것. */
export async function worldLines(env, now) {
  try {
    const { results } = await env.DB.prepare("SELECT t, payload FROM feed_items WHERE type IN ('macro', 'onchain') AND t >= ? ORDER BY t DESC LIMIT 60").bind(now - 3 * DAY).all();
    const seen = new Set(), out = [];
    for (const r of results) { try { const p = JSON.parse(r.payload); if (!p.id || seen.has(p.id)) continue; seen.add(p.id); out.push(`- ${p.en || p.title}`); } catch { /* skip */ } }
    return out.slice(0, 14);
  } catch { return []; }
}

export function buildPrompt(items, syms = AI_SYMBOLS, ctx = null) {
  const lines = items.slice(0, 60).map((i) => `- [${i.sym}] ${i.type}: ${(() => { try { const p = JSON.parse(i.payload); return p.title || p.label || JSON.stringify(p).slice(0, 120); } catch { return ''; } })()}`);
  const f = ctx?.features || {};
  const feat = syms.map((s) => {
    const x = f[s];
    return x ? `- ${s}: 5d ${x.ret5}%, 20d ${x.ret20}%, 60d ${x.ret60}%, vs 50d avg ${x.vsSma50}%, vs 200d avg ${x.vsSma200 ?? 'n/a'}%, 20d vol ${x.vol20}%/yr, from 1y high ${x.ddFromHigh}%` : `- ${s}: price data not available`;
  });
  const b = ctx?.breadth || {};
  const br = [b.krx ? `- KRX large caps above ~200-day average: ${b.krx.above}/${b.krx.total}` : '- KRX breadth: not available', b.crypto ? `- Major coins above 50-day average: ${b.crypto.above}/${b.crypto.total}` : '- Crypto breadth: not available'];
  return [
    'You are a cautious risk assistant for a PAPER-trading research system. You never recommend trades.',
    'Using the price structure, volatility, market breadth and Korean news titles below, rate the near-term (1-4 week) outlook for each symbol, weighting downside risk more than upside.',
    'Return ONLY JSON: {"scores":[{"sym":"<symbol>","score":<number -1..1>,"basis":["trend"|"volatility"|"breadth"|"news"],"reason":"<Korean, <=60 chars>"}],"veto":{"krx":"NO_VETO|VETO_NEW_BUYS|REDUCE_HALF","crypto":"NO_VETO|VETO_NEW_BUYS|REDUCE_HALF"}}',
    '-1 = clearly unfavorable (downtrend, high volatility, weak breadth, clearly negative news), 0 = neutral or unclear, +1 = clearly favorable. If unsure, use 0. A few headlines alone are weak evidence; one-off news about unrelated companies is not a reason.',
    'basis = which inputs actually drove the score (1-3 items).',
    `Symbols: ${syms.map((s) => `${s} (${symName(s)})`).join(', ')}`,
    'Price structure (daily closes, as of the last finished bar):', ...feat,
    'Market breadth:', ...br,
    ...(ctx?.world?.length ? ['World macro / on-chain context (latest values, change over ~1 month where given):', ...ctx.world] : []),
    ...(ctx?.calibration?.length ? ['', ...ctx.calibration, ''] : []),
    'News items (last 24h):', ...lines,
  ].join('\n');
}

const VETO = { NO_VETO: 0, REDUCE_HALF: 0.5, VETO_NEW_BUYS: 1 };
const BASIS_KO = { trend: '추세', volatility: '변동성', breadth: '시장 폭', news: '뉴스' };

/**
 * Same-prompt consistency of two samples (judgment stability). Returns null unless both parsed.
 * meanAbsDiff: average |score1 - score2| over symbols both scored; signAgree: share with the same sign bucket (-,0,+).
 */
export function consistencyOf(a, b) {
  if (!a || !b) return null;
  const syms = Object.keys(a.scores).filter((s) => b.scores[s]);
  if (!syms.length) return null;
  const bucket = (x) => (x > 0.05 ? 1 : x < -0.05 ? -1 : 0);
  const d = syms.map((s) => Math.abs(a.scores[s].score - b.scores[s].score));
  const vk = ['krx', 'crypto'].filter((m) => m in a.veto && m in b.veto);
  return {
    n: syms.length, meanAbsDiff: Math.round((d.reduce((x, y) => x + y, 0) / d.length) * 1000) / 1000,
    signAgree: Math.round((syms.filter((s) => bucket(a.scores[s].score) === bucket(b.scores[s].score)).length / syms.length) * 1000) / 1000,
    vetoAgree: vk.length ? vk.filter((m) => a.veto[m] === b.veto[m]).length / vk.length : null,
  };
}
/** Merge two parsed samples: average scores (noise reduction), the MORE conservative veto per market. */
export function mergeSamples(a, b) {
  if (!a || !b) return a || b || null;
  const scores = { ...a.scores };
  for (const [s, x] of Object.entries(b.scores)) {
    scores[s] = scores[s] ? { ...scores[s], score: Math.round(((scores[s].score + x.score) / 2) * 1000) / 1000 } : x;
  }
  const veto = { ...a.veto };
  for (const [m, v] of Object.entries(b.veto)) veto[m] = Math.max(veto[m] ?? 0, v);
  return { scores, veto };
}
/**
 * 교차 판단 반영: 다른 모델과 방향(−, 0, +)이 엇갈린 종목은 점수를 절반으로(확신 축소), 거부권은 더 보수적인 쪽.
 * 방향이 같으면 그대로 둔다(주 모델의 점수를 유지 → 같은 모델 2회 평균의 뜻이 바뀌지 않음).
 */
export function crossShrink(main, other) {
  if (!main || !other) return main;
  const bucket = (x) => (x > 0.05 ? 1 : x < -0.05 ? -1 : 0);
  const scores = {};
  for (const [s, x] of Object.entries(main.scores)) {
    const o = other.scores[s];
    scores[s] = o && bucket(o.score) !== bucket(x.score) ? { ...x, score: Math.round((x.score / 2) * 1000) / 1000, reason: `${x.reason} · 다른 모델과 엇갈려 절반`.slice(0, 100) } : x;
  }
  const veto = { ...main.veto };
  for (const [m, v] of Object.entries(other.veto)) veto[m] = Math.max(veto[m] ?? 0, v);
  return { scores, veto };
}
/** Rolling consistency record kept in kv 'ai:consistency' (last 40 runs). */
export function rollConsistency(prev, c, now) {
  const runs = [...(prev?.runs || []), { t: now, ...c }].slice(-40);
  const avg = (k) => { const v = runs.map((r) => r[k]).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; };
  return { runs, n: runs.length, meanAbsDiff: avg('meanAbsDiff'), signAgree: avg('signAgree'), vetoAgree: avg('vetoAgree'), at: now };
}
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
    const v = s.score;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const basis = (Array.isArray(s.basis) ? s.basis : []).map((x) => String(x).toLowerCase()).filter((x) => BASIS_KO[x]).slice(0, 3);
    const why = String(s.reason || '').slice(0, 80);
    scores[s.sym] = { score: Math.max(-1, Math.min(1, v)), reason: basis.length ? `[${basis.map((x) => BASIS_KO[x]).join('·')}] ${why}`.slice(0, 100) : why, ...(basis.length ? { basis } : {}) };
  }
  const veto = {};
  for (const m of ['krx', 'crypto']) if (Object.hasOwn(VETO, j?.veto?.[m])) veto[m] = VETO[j.veto[m]];
  return Object.keys(scores).length || Object.keys(veto).length ? { scores, veto } : null;
}

/** 지금 AI 장부 프롬프트에서 빼는 피드 종류(macro·onchain은 '세계 지표' 줄로 따로 들어감). */
export const AI_MAIN_EXCLUDED_TYPES = Object.freeze(['macro', 'onchain', 'disclosure', 'newsletter']);

export async function aiTask(env, kv, now, { fetcher = fetch } = {}) {
  if (!aiConfigured(env)) return false;
  if ((kv['ai:at'] || 0) > now - AI_INTERVAL) return false;
  kv['ai:at'] = now;
  // 2026-11-23 (#F-002 ③): 공시(DART)·뉴스레터는 지금 AI 장부의 입력을 바꾸지 않게 뺀다 → 따로 만들 비교 장부에서만 시험(기준 불변, P6)
  const { results } = await env.DB.prepare(`SELECT source, sym, type, payload FROM feed_items WHERE t >= ? AND type NOT IN (${AI_MAIN_EXCLUDED_TYPES.map((x) => `'${x}'`).join(', ')}) ORDER BY t DESC LIMIT 60`).bind(now - DAY).all();
  const mctx = await marketContext(env, now);
  mctx.world = await worldLines(env, now);
  // 자기 보정: 지난 판단을 실제 결과와 대조한 성적표를 프롬프트에 되돌려 준다(하루 한 번 다시 채점)
  try { mctx.calibration = calibrationLines(await scorecardTask(env, kv, now, AI_SYMBOLS)); } catch (_) { mctx.calibration = []; }
  const prompt = buildPrompt(results, AI_SYMBOLS, mctx);
  let text = null, note = '', model = aiModels(env)[0];
  try { ({ text, note, model } = await callModel(env, prompt, fetcher)); } catch (e) { note = String(e?.message || e).slice(0, 100); }
  const p1 = text ? parseAiResponse(text) : null;
  // 2nd sample, same prompt + same model: measures judgment consistency and averages out noise.
  // Free budget: gpt-oss-120b ≈ 31.8k neurons/M in + 68.2k/M out → ≈120-150 neurons/call; 2 calls × 4 runs/day ≈ 1.2k of 10k/day.
  const samples = Math.max(1, Math.min(2, Number(env.AI_SAMPLES ?? 2) | 0));
  let text2 = null, note2 = '', p2 = null;
  if (p1 && samples > 1) {
    try { ({ text: text2, note: note2 } = await callModel(env, prompt, fetcher, model)); } catch (e) { note2 = String(e?.message || e).slice(0, 100); }
    p2 = text2 ? parseAiResponse(text2) : null;
  }
  let parsed = mergeSamples(p1, p2);
  const cons = consistencyOf(p1, p2);
  // 다른 무료 모델의 교차 판단(AI_CROSS_MODEL: 'auto' = 목록의 다음 모델, 'off' = 끔). 방향이 엇갈린 종목은 확신을 절반으로 줄인다.
  let cross = null, text3 = null, note3 = '', crossModel = null;
  if (p1 && !useEndpoint(env)) {
    const want = String(env.AI_CROSS_MODEL ?? 'auto');
    crossModel = want === 'off' ? null : want === 'auto' ? aiModels(env).find((m) => m !== model) || null : want;
    if (crossModel) {
      try { ({ text: text3, note: note3 } = await callModel(env, prompt, fetcher, crossModel)); } catch (e) { note3 = String(e?.message || e).slice(0, 100); }
      const p3 = text3 ? parseAiResponse(text3) : null;
      cross = consistencyOf(parsed, p3);
      if (p3) parsed = crossShrink(parsed, p3);
    }
  }
  const stmts = [kvSetStmt(env.DB, 'ai:at', now)];
  if (!parsed) note = note || 'PARSE_FAILED (fail-closed: scale 0.5x / veto)';
  if (cons) { const roll = rollConsistency(kv['ai:consistency'], cons, now); kv['ai:consistency'] = roll; stmts.push(kvSetStmt(env.DB, 'ai:consistency', roll)); }
  if (cross) { const roll = { ...rollConsistency(kv['ai:cross'], cross, now), model: String(crossModel).split('/').pop() }; kv['ai:cross'] = roll; stmts.push(kvSetStmt(env.DB, 'ai:cross', roll)); }
  // Persist a complete conservative snapshot, including missing fields on partial success.
  // Historical paper replay then observes the failure only at/after this timestamp.
  const st = env.DB.prepare('INSERT OR REPLACE INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  for (const sym of AI_SYMBOLS) {
    const s = parsed?.scores[sym] || { score: -1, reason: 'AI 결과 없음: 신규 매수 0.5배' };
    stmts.push(st.bind(sym, now, 'ai_score', s.score, s.reason));
  }
  for (const m of ['krx', 'crypto']) {
    stmts.push(st.bind(`*${m}`, now, 'news_veto', parsed?.veto[m] ?? 1, 'AI 뉴스 판단 (누락/실패는 신규 매수 보류)'));
  }
  const audit = env.DB.prepare('INSERT INTO ai_audit (t, model, prompt, response, ok, note) VALUES (?,?,?,?,?,?)');
  stmts.push(audit.bind(now, String(model), prompt.slice(0, 20000), text ? String(text).slice(0, 20000) : null, p1 ? 1 : 0, note));
  if (p1 && samples > 1) stmts.push(audit.bind(now, String(model), '(같은 프롬프트 2번째 표본)', text2 ? String(text2).slice(0, 20000) : null, p2 ? 1 : 0, [note2, cons ? `일관성: 점수 차 ${cons.meanAbsDiff}, 방향 일치 ${Math.round(cons.signAgree * 100)}%` : ''].filter(Boolean).join('; ').slice(0, 200)));
  if (crossModel) stmts.push(audit.bind(now, String(crossModel), '(같은 프롬프트, 다른 모델 교차 판단)', text3 ? String(text3).slice(0, 20000) : null, cross ? 1 : 0, [note3, cross ? `교차: 방향 일치 ${Math.round(cross.signAgree * 100)}%` : ''].filter(Boolean).join('; ').slice(0, 200)));
  await env.DB.batch(stmts);
  return true;
}
