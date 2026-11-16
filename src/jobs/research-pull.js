// Weekly research results PULLED from a public repo file (no token needed anywhere):
// the GitHub Actions job commits backtest/results/import.json; this task fetches RESEARCH_URL
// (raw.githubusercontent.com/...), and imports it once per new generatedAt.
// Safety: same validation as /api/import (variants may only re-parameterise existing code,
// at most 4 per run, trial counts only grow), plus a format marker and a size cap.
import { kvSetStmt } from '../db/store.js';
import { HOUR } from '../core/calendar.js';
import { importResearch } from './research-import.js';

export const RESEARCH_FORMAT = 'fip-research-1';
const MAX_BYTES = 3_000_000;
const CHECK_EVERY = 6 * HOUR;

export async function researchPullTask(env, kv, now, { fetcher = fetch } = {}) {
  const url = String(env.RESEARCH_URL || '').trim();
  if (!/^https:\/\//.test(url)) return false;
  if ((kv['research:checkedAt'] || 0) > now - CHECK_EVERY) return false;
  kv['research:checkedAt'] = now;
  const done = (extra = {}) => env.DB.batch([kvSetStmt(env.DB, 'research:checkedAt', now), ...Object.entries(extra).map(([k, v]) => kvSetStmt(env.DB, k, v))]);
  let res;
  try { res = await fetcher(url, { headers: { 'user-agent': 'family-invest-paper/2 (research pull)', accept: 'application/json' }, cf: { cacheTtl: 300 } }); } catch (e) { await done({ 'research:lastError': String(e?.message || e).slice(0, 100) }); return true; }
  if (!res.ok) { await done({ 'research:lastError': `HTTP_${res.status}` }); return true; }
  const text = await res.text();
  if (text.length > MAX_BYTES) { await done({ 'research:lastError': 'TOO_LARGE' }); return true; }
  let body;
  try { body = JSON.parse(text); } catch { await done({ 'research:lastError': 'BAD_JSON' }); return true; }
  const gen = Number(body?.generatedAt) | 0;
  if (body?.format !== RESEARCH_FORMAT || !gen) { await done({ 'research:lastError': 'BAD_FORMAT' }); return true; }
  if (gen <= (kv['research:importedGen'] || 0)) { await done(); return true; }
  const r = await importResearch(env, body);
  kv['research:importedGen'] = gen;
  await done({ 'research:importedGen': gen, 'research:lastImport': { at: now, gen, backtests: r.backtests, variants: r.variants }, 'research:lastError': null });
  return true;
}
