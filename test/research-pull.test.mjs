import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { researchPullTask, RESEARCH_FORMAT } from '../src/jobs/research-pull.js';
import { kvAll } from '../src/db/store.js';
import { STRATEGIES } from '../src/strategies/index.js';

const base = STRATEGIES.find((s) => !s.benchmarkOnly && !s.external);
const body = (gen, extra = {}) => ({ format: RESEARCH_FORMAT, generatedAt: gen,
  backtests: [{ strategy_id: base.id, kind: 'wf', source: 'research', summary: { years: 3 }, curve: [] }],
  variants: [{ id: `${base.family}_v${base.version + 7}`, base: base.id, version: base.version + 7, params: { ...base.params }, trials: 12, note: 't' }],
  trials: { [base.family]: 12 }, ...extra });
const fetcherFor = (b, status = 200) => async () => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status });

test('research pull imports once per generatedAt and is throttled', async () => {
  const DB = makeD1();
  const env = { DB, RESEARCH_URL: 'https://raw.githubusercontent.com/x/y/main/backtest/results/import.json' };
  let kv = {};
  assert.equal(await researchPullTask(env, kv, 1_800_000_000, { fetcher: fetcherFor(body(100)) }), true);
  let st = await kvAll(DB);
  assert.equal(st['research:importedGen'], 100);
  assert.equal(st['research:lastImport'].variants, 1);
  assert.equal(st.variants.length, 1);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM backtests').get().n, 1);
  // within 6h: no fetch at all
  assert.equal(await researchPullTask(env, kv, 1_800_000_000 + 3600, { fetcher: async () => { throw new Error('should not fetch'); } }), false);
  // same generation later: no re-import
  kv = await kvAll(DB);
  assert.equal(await researchPullTask(env, kv, 1_800_000_000 + 7 * 3600, { fetcher: fetcherFor(body(100)) }), true);
  st = await kvAll(DB);
  assert.equal(st.variants.length, 1);
});

test('research pull rejects bad format, bad json and http errors without importing', async () => {
  for (const [f, err] of [[fetcherFor({ generatedAt: 5 }), 'BAD_FORMAT'], [fetcherFor('{nope'), 'BAD_JSON'], [fetcherFor('x', 404), 'HTTP_404']]) {
    const DB = makeD1();
    const env = { DB, RESEARCH_URL: 'https://example.com/import.json' };
    assert.equal(await researchPullTask(env, {}, 1_800_000_000, { fetcher: f }), true);
    const st = await kvAll(DB);
    assert.equal(st['research:lastError'], err);
    assert.equal(st.variants, undefined);
  }
  assert.equal(await researchPullTask({ DB: makeD1() }, {}, 1, { fetcher: fetcherFor(body(1)) }), false); // no URL configured
});
