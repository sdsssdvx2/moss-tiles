// One cron tick = a few small units of work, in priority order.
import { kvAll } from '../db/store.js';
import { cryptoCandlesTask, cryptoBackfillTask, cryptoUniverseTask, krxDailyTask, krxBackfillTask, krxNavBackfillTask, pruneHourlyTask } from './collect.js';
import { paperTask, workerBacktestTask } from './paper.js';
import { lifecycleTask } from './lifecycle.js';
import { allocateTask } from './allocate.js';
import { notifyPending } from './notify.js';
import { feedsTask } from './feeds.js';
import { aiTask, aiDiscTask } from './ai.js';
import { marketSignalsTask } from './market-signals.js';
import { researchPullTask } from './research-pull.js';
import { weeklyDue, weeklyText } from '../core/decision.js';
import { kvSetStmt, eventStmt, getRuns, lifecycleAll } from '../db/store.js';
import { allStrategies } from '../strategies/index.js';
import { buildScorecard, appendScorecard, scorecardLines } from '../core/scorecard.js';
import { selfCheckTask } from './selfcheck.js';
import { meteredDB, readsToday, mergeReads, topTasks, D1_READ_SOFT, D1_READ_HARD } from '../db/meter.js';

/** 오늘 읽은 행이 문턱을 넘으면 쉬는 일(덜 급한 것부터). soft: 과거 재검증·과거 채우기·비교 AI·연구 가져오기 / hard: + 평가·배분. */
export const D1_SKIP_SOFT = Object.freeze(['krxBackfill', 'krxNavBackfill', 'cryptoBackfill1d', 'cryptoBackfill1h', 'aidisc', 'research', 'workerBacktest']);
export const D1_SKIP_HARD = Object.freeze([...D1_SKIP_SOFT, 'lifecycle', 'allocate']);

export async function tick(env, now = Math.floor(Date.now() / 1000), { fetcher = fetch } = {}) {
  // 2026-11-24 #F-010: 이 틱이 D1에서 읽은 행을 작업별로 센다(kv 'd1:reads', UTC 하루). 무료 읽기 한도는 계정 전체라 넘으면 다른 사이트도 멈춤.
  const meter = { total: 0, byTask: {}, cur: 'kvAll' };
  env = { ...env, DB: meteredDB(env.DB, meter) };
  const kv = await kvAll(env.DB);
  const readsSoFar = readsToday(kv, now);
  const soft = readsSoFar >= Number(env.D1_READ_SOFT || D1_READ_SOFT), hard = readsSoFar >= Number(env.D1_READ_HARD || D1_READ_HARD);
  const skip = new Set(hard ? D1_SKIP_HARD : soft ? D1_SKIP_SOFT : []);
  const log = [];
  const run = async (name, fn) => {
    if (skip.has(name)) return false;
    meter.cur = name;
    try { const r = await fn(); if (r) log.push(name); return r; } catch (e) { log.push(`${name}:ERR:${String(e?.message || e).slice(0, 80)}`); return false; }
  };
  let data = 0;
  const maxData = Number(env.DATA_TASKS_PER_TICK || 2);
  if (String(env.COLLECT_ENABLED ?? 'true') !== 'false') {
    const tasks = [
      ['crypto1h', () => cryptoCandlesTask(env, kv, now, '1h', { fetcher })],
      ['crypto1d', () => cryptoCandlesTask(env, kv, now, '1d', { fetcher })],
      ['krx1d', () => krxDailyTask(env, kv, now, { fetcher })],
      ['universe', () => cryptoUniverseTask(env, kv, now, { fetcher })],
      ['market', () => marketSignalsTask(env, kv, now, { fetcher })],
      ['feeds', () => feedsTask(env, kv, now, { fetcher })],
      ['krxBackfill', () => krxBackfillTask(env, kv, now, { fetcher })],
      ['krxNavBackfill', () => krxNavBackfillTask(env, kv, now, { fetcher })],
      ['cryptoBackfill1d', () => cryptoBackfillTask(env, kv, now, '1d', { fetcher })],
      ['cryptoBackfill1h', () => cryptoBackfillTask(env, kv, now, '1h', { fetcher })],
      ['prune', () => pruneHourlyTask(env, kv, now)],
    ];
    for (const [n, f] of tasks) { if (data >= maxData) break; if (await run(n, f)) data++; }
  }
  // AI judgment and the weekly research pull are self-throttled (6h) and mostly I/O, so they get their own slot instead
  // of competing with the data collectors (which fill the data budget almost every tick). At most one per tick.
  // 공시 비교 점수(2026-11-24)는 본 AI가 저장을 끝낸 다음 틱에, 같은 자리(ai → 공시 비교 → 연구 가져오기 중 하나)
  if (!(await run('ai', () => aiTask(env, kv, now, { fetcher }))) && !(await run('aidisc', () => aiDiscTask(env, kv, now, { fetcher })))) await run('research', () => researchPullTask(env, kv, now, { fetcher }));
  const changed = (await run('paper', () => paperTask(env, kv, now, { maxSteps: Number(env.PAPER_STEPS_PER_TICK || 2) }))) || [];
  if (!changed.length && data === 0) await run('workerBacktest', () => workerBacktestTask(env, kv, now));
  const plan = lifecyclePlan(kv, now, changed);
  if (plan === 'full') {
    // mark the attempt first: if a full pass ever dies (CPU limit), it is retried once an hour, not every tick
    kv['lc:fullTry'] = now;
    await run('lcTry', async () => { await kvSetStmt(env.DB, 'lc:fullTry', now).run(); return false; });
    await run('lifecycle', () => lifecycleTask(env, kv, now));
  } else if (plan === 'partial') await run('lifecycle', () => lifecycleTask(env, kv, now, { only: changed }));
  else await run('allocate', () => allocateTask(env, kv, now));
  await run('scorecard', () => weeklyScorecardTask(env, kv, now));
  await run('weekly', () => weeklyDecisionTask(env, kv, now));
  await run('selfcheck', () => selfCheckTask(env, kv, now));
  // 문턱을 처음 넘은 날 한 번: 텔레그램 한 줄(즉시 알림 분류) — 알림을 보내기 전에 쌓아 같은 틱에 나가게
  if (soft && !kv['d1:reads']?.warned) {
    meter.cur = 'meter';
    try {
      const top = Object.entries(topTasks(kv['d1:reads']?.byTask, 3)).map(([k, v]) => `${k} ${Math.round(v / 10000)}만`).join(', ');
      await eventStmt(env.DB, { t: now, kind: 'self_check', strategy_id: null, message: `⚠️ D1 읽기 오늘(UTC) ${Math.round(readsSoFar / 10000)}만 행 — 계정 무료 한도(하루 500만, 다른 사이트와 같이 씀)를 지키려고 ${hard ? '평가·배분까지' : '덜 급한 일(과거 재검증·과거 채우기·비교 AI)을'} 오늘 쉽니다. 많이 읽은 곳: ${top || '-'}` }).run();
      kv['d1:reads'] = { ...kv['d1:reads'], warned: now };
    } catch (_) { /* 경고 실패는 틱을 막지 않음 */ }
  }
  await run('notify', () => notifyPending(env, { fetcher, kv, now }));
  meter.cur = 'meter';
  try {
    const m = mergeReads(kv['d1:reads'], kv['d1:reads:hist'], meter, now);
    kv['d1:reads'] = m.reads;
    await env.DB.batch([kvSetStmt(env.DB, 'd1:reads', m.reads), ...(m.hist ? [kvSetStmt(env.DB, 'd1:reads:hist', m.hist)] : [])]);
    if (m.hist) kv['d1:reads:hist'] = m.hist;
  } catch (_) { /* 계량 기록 실패는 틱을 막지 않음 */ }
  return log;
}

/**
 * Which lifecycle pass this tick runs. The full pass (automatic decision, criteria, weekly conclusion input) is keyed on
 * its OWN time 'lc:fullAt' — 2026-11-23: keyed on 'lc:at', which partial passes refresh every hour (1h books), the full
 * pass never ran in production. A failed attempt ('lc:fullTry') waits an hour before the next try.
 */
export function lifecyclePlan(kv, now, changed = []) {
  const fullDue = (kv['lc:fullAt'] || 0) < now - 6 * 3600 && (kv['lc:fullTry'] || 0) < now - 3600;
  if (fullDue) return 'full';
  return changed.length ? 'partial' : 'allocate';
}

/** Monday 08:40 KST: one plain-language conclusion (no jargon) as a Telegram event. Cheap: kv only. */
export async function weeklyDecisionTask(env, kv, now) {
  const d = kv['decision:current'];
  if (!d || !weeklyDue(now, kv['decision:weeklyAt'])) return false;
  kv['decision:weeklyAt'] = now;
  const card = (kv['paper:weekly'] || []).slice(-1)[0];
  const extra = card && now - card.at < 2 * 86400 ? scorecardLines(card) : [];
  const message = extra.length ? `${weeklyText(d)}\n\n${extra.join('\n')}` : weeklyText(d);
  await env.DB.batch([kvSetStmt(env.DB, 'decision:weeklyAt', now), eventStmt(env.DB, { t: now, kind: 'decision_weekly', strategy_id: null, message })]);
  return true;
}

/** Monday 08:40 KST: one snapshot of every paper book (주간 성과표), last 12 weeks kept in kv 'paper:weekly'. Display only. */
export async function weeklyScorecardTask(env, kv, now) {
  if (!weeklyDue(now, kv['paper:weeklyAt'])) return false;
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const lc = await lifecycleAll(env.DB);
  const hist = kv['paper:weekly'] || [];
  const card = buildScorecard(allStrategies(kv), runs, lc, now, hist.slice(-1)[0] || null);
  const next = appendScorecard(hist, card);
  kv['paper:weekly'] = next; kv['paper:weeklyAt'] = now;
  await env.DB.batch([kvSetStmt(env.DB, 'paper:weekly', next), kvSetStmt(env.DB, 'paper:weeklyAt', now)]);
  return true;
}
