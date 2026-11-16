// OPTIONAL idea step for the weekly research job. Off unless LLM_ENDPOINT, LLM_API_KEY and LLM_MODEL
// are set (any OpenAI-compatible endpoint: Gemini/Groq/OpenRouter free tiers, or the user's own gateway).
// The model may only PROPOSE parameter sets inside the declared ranges; every proposal is clamped to the
// range, counted as a trial, and must pass exactly the same gates as random variants.
export async function llmIdeas(family, cfg, baseParams, { fetcher = fetch, env = process.env } = {}) {
  if (!env.LLM_ENDPOINT || !env.LLM_API_KEY || !env.LLM_MODEL) return [];
  const prompt = `Propose up to 4 parameter sets for the trading strategy family "${family}" (current: ${JSON.stringify(baseParams)}).\n` +
    `Allowed values per key: ${JSON.stringify(cfg.space)}. Prefer robust, slower settings; avoid overfitting.\n` +
    'Return ONLY JSON: {"ideas":[{...params...}]}';
  try {
    const r = await fetcher(`${env.LLM_ENDPOINT.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.2, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    const j = await r.json();
    const ideas = JSON.parse(j?.choices?.[0]?.message?.content || '{}').ideas || [];
    return ideas.slice(0, 4).map((idea) => Object.fromEntries(Object.entries(cfg.space).map(([k, vals]) => {
      const v = Number(idea?.[k]);
      if (!Number.isFinite(v)) return [k, baseParams[k] ?? vals[0]];
      return [k, vals.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), vals[0])]; // snap into the declared range
    })));
  } catch { return []; }
}
