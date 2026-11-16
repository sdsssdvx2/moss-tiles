// Evaluates every strategy's lifecycle stage and emits events on transitions.
import { evaluateStage, applySupersession, mergeGates, STAGES } from '../core/lifecycle.js';
import { liveKillSwitch } from '../core/live-policy.js';
import { computeMetrics } from '../core/metrics.js';
import { createState } from '../core/engine.js';
import { DAY } from '../core/calendar.js';
import { getRuns, lifecycleAll, lifecycleStmt, backtests, equityPoints, eventStmt, kvSetStmt, fillsOf, runUpsertStmt } from '../db/store.js';
import { allStrategies } from '../strategies/index.js';
import { advanceRun } from './paper.js';
import { INITIAL_CASH } from '../config.js';

export function gatesFrom(env) {
  try { return mergeGates(env.GATES_JSON ? JSON.parse(env.GATES_JSON) : {}); } catch { return mergeGates({}); }
}

/** Pick the backtest evidence for the gate: local heavy runner first, worker re-run as fallback. */
export function btEvidence(rows, id) {
  const local = rows.find((r) => r.strategy_id === id && r.kind === 'wf');
  if (local) return local.summary;
  const w = rows.find((r) => r.strategy_id === id && r.kind === 'worker');
  if (w) return { holdout: w.summary.oos, years: (w.summary.full.days || 0) / 365.25, totalTrades: w.summary.full.trades, trials: 1, source: 'worker' };
  return null;
}

/** Replay the whole paper ledger from scratch with the backtest engine; fills must match 100%. */
export async function signalAgreement(env, kv, strategy, run) {
  if (!run || run.last_t == null) return { matched: 0, total: 0 };
  const replay = { ...run, state: (strategy.createState || createState)(INITIAL_CASH), last_t: null };
  const res = await advanceRun(env, kv, strategy, replay, run.last_t, 2000);
  const stored = (await fillsOf(env.DB, run.id, 0, 100000)).sort((a, b) => a.t - b.t || a.seq - b.seq);
  const key = (f) => `${f.t}|${f.sym}|${f.side}|${Math.round(f.qty * 1e6)}|${Number(f.price).toPrecision(10)}`;
  // B06: multiset match — each replayed fill can satisfy at most one stored fill
  const want = new Map();
  for (const f of res.fills) want.set(key(f), (want.get(key(f)) || 0) + 1);
  const matched = stored.filter((f) => { const k = key(f), n = want.get(k) || 0; if (!n) return false; want.set(k, n - 1); return true; }).length;
  const total = Math.max(stored.length, res.fills.length);
  return { matched: total === 0 ? 0 : matched, total, checkedT: run.last_t };
}

export async function lifecycleTask(env, kv, now, { only = null } = {}) {
  const gates = gatesFrom(env);
  const prev = await lifecycleAll(env.DB);
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const bts = await backtests(env.DB);
  const rows = [];
  const stmts = [];
  let replays = 0; // at most one signal-agreement replay per invocation (CPU budget)
  for (const s of allStrategies(kv)) {
    const p = prev[s.id];
    const run = runs[`${s.id}:paper`];
    if (only && !only.includes(s.id) && p) { rows.push({ ...p, id: s.id, btSharpe: btEvidence(bts, s.id)?.holdout?.sharpe }); continue; }
    const bt = btEvidence(bts, s.id);
    let paperSince = Math.max(p?.paper_since || 0, run?.state?.epochT || 0) || null;
    let paper = null;
    if (run && run.last_t != null) {
      const pts = await equityPoints(env.DB, run.id, paperSince || 0);
      const fills = (await fillsOf(env.DB, run.id, paperSince || 0, 5000)).reverse();
      const m = computeMetrics(pts, fills, { market: s.market, tf: s.timeframe });
      paper = { ...m, bars: pts.length, decisions: pts.length, halted: run.state.halted, haltReason: run.state.haltReason };
      if (s.timeframe === '1h') paper.days = Math.round((pts.length ? pts[pts.length - 1].t - pts[0].t : 0) / DAY);
      // signal agreement: only for strategies that can be promoted
      if (!s.benchmarkOnly && !s.researchOnly && !s.external) {
        const ak = `agree:${s.id}`;
        let a = kv[ak];
        if (!a || a.checkedT !== run.last_t) {
          const bars = run.state.bars || 0;
          // replay whenever the ledger moved (stale agreement no longer counts); one replay per invocation for CPU
          if (replays === 0 && bars <= 160) {
            replays++;
            a = { ...(await signalAgreement(env, kv, s, run)), at: now };
            kv[ak] = a; stmts.push(kvSetStmt(env.DB, ak, a));
          }
        }
        // B05: only an agreement checked up to the CURRENT last_t counts (stale success must not promote)
        paper.agreement = a && a.checkedT === run.last_t ? a : null;
      } else if (s.external) paper.agreement = run.state.agreement || null; // reported by the external engine
    }
    let kill = null;
    if (p?.stage === 'live_candidate' && run) {
      const pts = await equityPoints(env.DB, run.id, p.promoted_t || 0);
      const fl = (await fillsOf(env.DB, run.id, p.promoted_t || 0, 2000)).reverse();
      kill = liveKillSwitch(pts, fl, { market: s.market, backtestMdd: bt?.holdout?.mdd }, gates.live.kill);
    }
    const ev = evaluateStage({ strategy: s, bt, paper, kill, gates });
    let promoted = p?.promoted_t || null;
    if (ev.stage === 'live_candidate' && p?.stage !== 'live_candidate') {
      promoted = run?.last_t || now;
      stmts.push(eventStmt(env.DB, { t: now, kind: 'promote', strategy_id: s.id, message: `🎉 ${s.name}: '실거래 가능(소액)' 단계 도달. 자동 주문은 하지 않으며, 사람이 검토 후 결정합니다.` }));
      stmts.push(env.DB.prepare("INSERT INTO live_budgets (strategy_id, frac, budget_krw, step, status, note, updated_at) VALUES (?, 0, ?, 0, 'eligible', ?, ?) ON CONFLICT(strategy_id) DO UPDATE SET status = 'eligible', budget_krw = excluded.budget_krw, updated_at = excluded.updated_at")
        .bind(s.id, gates.live.budgetKrw[s.market], '미래 실거래 모듈용 예산 기록(현재 주문 기능 없음)', now));
    }
    if (kill?.kill) {
      paperSince = run?.last_t || now; promoted = null;
      stmts.push(eventStmt(env.DB, { t: now, kind: 'kill', strategy_id: s.id, message: `⛔ ${s.name}: ${kill.reason} → '실거래 가능' 해제, 모의 검증 다시 시작` }));
      stmts.push(env.DB.prepare("UPDATE live_budgets SET status = 'killed', updated_at = ? WHERE strategy_id = ?").bind(now, s.id));
    } else if (ev.stage !== 'live_candidate') promoted = null;
    if (p && p.stage !== ev.stage && !['promote'].includes(ev.stage) && ev.stage !== 'live_candidate' && !kill?.kill) {
      stmts.push(eventStmt(env.DB, { t: now, kind: 'stage', strategy_id: s.id, message: `${s.name}: ${STAGES[p.stage]?.label || p.stage} → ${ev.label}` }));
    }
    rows.push({ id: s.id, strategy_id: s.id, family: s.family, version: s.version, stage: ev.stage, label: ev.label, summary: ev.summary, checks: ev.checks, paper_since: paperSince, promoted_t: promoted, btSharpe: bt?.holdout?.sharpe });
  }
  // 공격형 슬롯: total sleeve loss -30% -> stop every sleeve strategy permanently (no auto refill).
  const sleeveCfg = gates.live.sleeves?.aggressive;
  const sleeveRuns = allStrategies(kv).filter((s) => s.sleeve === 'aggressive').map((s) => runs[`${s.id}:paper`]).filter(Boolean);
  if (sleeveCfg && sleeveRuns.length) {
    const init = sleeveRuns.reduce((a, r) => a + r.state.initialCash, 0);
    const eqNow = sleeveRuns.reduce((a, r) => a + r.state.equity, 0);
    const loss = 1 - eqNow / init;
    if (loss >= sleeveCfg.maxTotalLoss && !kv['sleeve:aggressive:stopped']) {
      const reason = `공격형 슬롯 전체 손실 ${Math.round(loss * 1000) / 10}% (한도 ${Math.round(sleeveCfg.maxTotalLoss * 100)}%) → 슬롯 전체 정지. 자동으로 다시 채우지 않음(주인 확인 필요)`;
      kv['sleeve:aggressive:stopped'] = reason;
      stmts.push(kvSetStmt(env.DB, 'sleeve:aggressive:stopped', reason));
      stmts.push(eventStmt(env.DB, { t: now, kind: 'halt', strategy_id: null, message: `⛔ ${reason}` }));
      for (const r of sleeveRuns) {
        if (r.state.kind === 'futures') { if (r.state.pos) r.state.pending = { action: 'close', reason: '공격형 슬롯 정지' }; }
        else r.state.pending = Object.keys(r.state.pos).map((sym) => ({ sym, side: 'SELL', all: true, qty: r.state.pos[sym].qty, reason: '위험 관리: 공격형 슬롯 전체 손실 한도 → 전량 매도' }));
        r.state.halted = true; r.state.haltReason = reason; r.state.haltBars = -1e12;
        stmts.push(runUpsertStmt(env.DB, r));
      }
    }
    for (const row of rows) if (kv['sleeve:aggressive:stopped'] && allStrategies(kv).find((x) => x.id === row.id)?.sleeve === 'aggressive') {
      row.stage = 'halted'; row.label = STAGES.halted.label; row.summary = kv['sleeve:aggressive:stopped'];
    }
  }
  applySupersession(rows);
  for (const r of rows) stmts.push(lifecycleStmt(env.DB, r));
  stmts.push(kvSetStmt(env.DB, 'lc:at', now));
  await env.DB.batch(stmts);
  kv['lc:at'] = now;
  return rows;
}
