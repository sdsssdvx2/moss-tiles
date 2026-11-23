// Thin D1 data-access helpers. All SQL lives here.
const nowSec = () => Math.floor(Date.now() / 1000);

export async function kvAll(db) {
  // overview:* = the cached dashboard JSON (hundreds of KB): never parsed by the jobs.
  const { results } = await db.prepare("SELECT k, v FROM kv WHERE k NOT LIKE 'overview:%'").all();
  const o = {};
  for (const r of results) { try { o[r.k] = JSON.parse(r.v); } catch { o[r.k] = r.v; } }
  return o;
}
export const kvSetStmt = (db, k, v) => db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(k, JSON.stringify(v), nowSec());
export const kvSet = (db, k, v) => kvSetStmt(db, k, v).run();

export function candleStmts(db, market, tf, sym, bars, src) {
  const st = db.prepare('INSERT INTO candles (market, tf, sym, t, o, h, l, c, v, src) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(market, tf, sym, t) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v, src=excluded.src');
  return bars.map((b) => st.bind(market, tf, sym, b.t, b.o, b.h, b.l, b.c, b.v, src));
}

/** {sym: {min, max, n}} for a market/timeframe. */
export async function coverage(db, market, tf) {
  const { results } = await db.prepare('SELECT sym, MIN(t) AS min, MAX(t) AS max, COUNT(*) AS n FROM candles WHERE market = ? AND tf = ? GROUP BY sym').bind(market, tf).all();
  return Object.fromEntries(results.map((r) => [r.sym, r]));
}

export async function loadSeries(db, market, tf, syms, fromT, toT) {
  const ph = syms.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT sym, t, o, h, l, c, v FROM candles WHERE market = ? AND tf = ? AND sym IN (${ph}) AND t >= ? AND t <= ? ORDER BY sym, t`)
    .bind(market, tf, ...syms, fromT, toT).all();
  const out = {};
  for (const s of syms) out[s] = [];
  for (const r of results) out[r.sym].push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  return out;
}

export async function healthOk(db, source) {
  await db.prepare('INSERT INTO data_health (source, last_ok, ok_count, err_count) VALUES (?, ?, 1, 0) ON CONFLICT(source) DO UPDATE SET last_ok = excluded.last_ok, ok_count = ok_count + 1').bind(source, nowSec()).run();
}
/** 오류 문구 안의 주소 쿼리 키 값을 가린다(2026-11-23: DART 'Too many redirects' 문구에 인증키가 그대로 저장됐음). */
export function redactSecrets(s) {
  return String(s).replace(/([?&](?:crtfc_key|service_?key|api_?key|apikey|key|token|access_token|secret|password|pw|auth)=)[^&\s#"']+/gi, '$1***');
}
export async function healthErr(db, source, err) {
  const msg = redactSecrets(String(err?.message || err)).slice(0, 120);
  await db.prepare('INSERT INTO data_health (source, last_err, err, ok_count, err_count) VALUES (?, ?, ?, 0, 1) ON CONFLICT(source) DO UPDATE SET last_err = excluded.last_err, err = excluded.err, err_count = err_count + 1').bind(source, nowSec(), msg).run();
}

export async function getRun(db, id) {
  const r = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  if (r) r.state = JSON.parse(r.state);
  return r;
}
export async function getRuns(db) {
  const { results } = await db.prepare('SELECT id, strategy_id, mode, engine, state, start_after, last_t, updated_at FROM runs').all();
  return results.map((r) => ({ ...r, state: JSON.parse(r.state) }));
}
export function runUpsertStmt(db, run) {
  return db.prepare('INSERT INTO runs (id, strategy_id, mode, engine, state, start_after, last_t, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, start_after = excluded.start_after, last_t = excluded.last_t, updated_at = excluded.updated_at, engine = excluded.engine')
    .bind(run.id, run.strategy_id, run.mode, run.engine || 'builtin', JSON.stringify(run.state), run.start_after ?? null, run.last_t ?? null, nowSec());
}
export function fillStmts(db, runId, fills) {
  const st = db.prepare('INSERT OR REPLACE INTO fills (run_id, t, seq, sym, side, qty, price, gross, fee, tax, pnl, reason, cash, phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  return fills.map((f, i) => st.bind(runId, f.t, f.seq ?? i, f.sym, f.side, f.qty, f.price, f.gross, f.fee, f.tax, f.pnl, String(f.reason || '').slice(0, 300), f.cash, f.phase ?? null));
}
export function equityStmts(db, runId, points) {
  const st = db.prepare('INSERT OR REPLACE INTO equity (run_id, t, equity, cash, invested, bench) VALUES (?,?,?,?,?,?)');
  return points.map((p) => st.bind(runId, p.t, p.equity, p.cash ?? 0, p.invested ?? 0, p.bench ?? p.equity));
}
export function eventStmt(db, e) {
  return db.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)').bind(e.t ?? nowSec(), e.kind, e.strategy_id ?? null, String(e.message).slice(0, 500));
}
export async function equityPoints(db, runId, fromT = 0) {
  const { results } = await db.prepare('SELECT t, equity, cash, invested, bench FROM equity WHERE run_id = ? AND t >= ? ORDER BY t').bind(runId, fromT).all();
  return results;
}
export async function fillsOf(db, runId, fromT = 0, limit = 5000) {
  const { results } = await db.prepare('SELECT * FROM fills WHERE run_id = ? AND t >= ? ORDER BY t DESC, seq DESC LIMIT ?').bind(runId, fromT, limit).all();
  return results;
}
export async function backtests(db) {
  const { results } = await db.prepare('SELECT strategy_id, kind, source, created_at, summary, curve FROM backtests').all();
  return results.map((r) => ({ ...r, summary: JSON.parse(r.summary), curve: r.curve ? JSON.parse(r.curve) : null }));
}
export function backtestStmt(db, strategyId, kind, source, summary, curve) {
  return db.prepare('INSERT INTO backtests (strategy_id, kind, source, created_at, summary, curve) VALUES (?,?,?,?,?,?) ON CONFLICT(strategy_id, kind) DO UPDATE SET source = excluded.source, created_at = excluded.created_at, summary = excluded.summary, curve = excluded.curve')
    .bind(strategyId, kind, source, nowSec(), JSON.stringify(summary), curve ? JSON.stringify(curve) : null);
}
export async function lifecycleAll(db) {
  const { results } = await db.prepare('SELECT * FROM lifecycle').all();
  return Object.fromEntries(results.map((r) => [r.strategy_id, { ...r, checks: JSON.parse(r.checks) }]));
}
export function lifecycleStmt(db, r) {
  return db.prepare('INSERT INTO lifecycle (strategy_id, family, version, stage, label, summary, checks, paper_since, promoted_t, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(strategy_id) DO UPDATE SET stage=excluded.stage, label=excluded.label, summary=excluded.summary, checks=excluded.checks, paper_since=excluded.paper_since, promoted_t=excluded.promoted_t, updated_at=excluded.updated_at, family=excluded.family, version=excluded.version')
    .bind(r.strategy_id, r.family, r.version, r.stage, r.label, r.summary, JSON.stringify(r.checks || []), r.paper_since ?? null, r.promoted_t ?? null, nowSec());
}

/** Downsample a curve to at most n points (keeps first/last). */
export function downsample(points, n = 240) {
  if (points.length <= n) return points;
  const out = [];
  const step = (points.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
  return out;
}
