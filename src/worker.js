// family-invest-paper-v2 — PAPER TRADING ONLY. No broker/exchange order endpoints, no private keys.
import { tick } from './jobs/tick.js';
import { lifecycleTask } from './jobs/lifecycle.js';
import { sendTelegram, scheduledSummary, notifyStatus, saveNotifySettings, notifyTest } from './jobs/notify.js';
import { SettingsError } from './core/notify-schedule.js';
import { exportSignals, overviewCached, buildOverviewCache, markOverviewDirty, dropOverviewCache } from './api.js';
import { getSession, createSession, sessionCookie, clearCookie, checkPassword, loginAllowed, recordLogin, revokeSession, bearerOk } from './auth.js';
import { byId, byId as staticById, variantStrategies, MAX_ACTIVE_VARIANTS, allStrategies } from './strategies/index.js';
import { runUpsertStmt, equityStmts, fillStmts, backtestStmt, kvAll, kvSetStmt } from './db/store.js';
import { dashboardHtml, loginHtml } from './ui/dashboard.js';
import { probeSources } from './jobs/market-signals.js';
import { importResearch } from './jobs/research-import.js';

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra } });
const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra } });

/**
 * CSRF guard for cookie-authenticated POSTs (on top of SameSite=Strict): a browser always sends
 * Origin on POST fetches/forms; it must be this host. Non-browser clients (no Origin) are allowed.
 */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === new URL(request.url).host || host === request.headers.get('host');
  } catch { return false; }
}
const jsonBody = async (request) => {
  if (!String(request.headers.get('content-type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (p === '/health') return json({ ok: true, service: 'family-invest-paper-v2', paperOnly: true, liveOrders: false });
  if (p === '/login' && request.method === 'POST') {
    if (!env.OWNER_PASSWORD) return html(loginHtml('관리자 비밀번호가 아직 설정되지 않았습니다. 배포 스크립트를 다시 실행하세요.'), 503);
    if (!(await loginAllowed(request, env))) return html(loginHtml('로그인 시도가 너무 많습니다. 30분 뒤에 다시 시도하세요.'), 429);
    const form = await request.formData().catch(() => null);
    const ok = await checkPassword(env, form?.get('password'));
    await recordLogin(request, env, ok);
    if (!ok) return html(loginHtml('비밀번호가 맞지 않습니다.'), 401);
    const token = await createSession(request, env);
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': sessionCookie(token), ...SEC_HEADERS } });
  }
  // machine endpoints (Bearer)
  if (p === '/api/signals' && (bearerOk(request, env.EXPORT_TOKEN) || (await getSession(request, env)))) return json(await exportSignals(env));
  if (p === '/api/research-state' && bearerOk(request, env.IMPORT_TOKEN)) {
    const kv = await kvAll(env.DB);
    return json({ variants: kv.variants || [], trials: kv['research:trials'] || {} });
  }
  if (p === '/api/import' && request.method === 'POST') {
    if (!bearerOk(request, env.IMPORT_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const r = await importResearch(env, await request.json());
    await dropOverviewCache(env);
    return json(r);
  }
  if (p === '/api/ingest' && request.method === 'POST') {
    if (!bearerOk(request, env.INGEST_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const r = await ingest(env, await request.json());
    await dropOverviewCache(env);
    return json(r);
  }
  const session = await getSession(request, env);
  if (!session) {
    if (p.startsWith('/api/')) return json({ error: 'login required' }, 401);
    return html(loginHtml(''), 200);
  }
  if (request.method === 'POST' && p !== '/logout' && !sameOrigin(request)) return json({ error: 'cross-origin request refused' }, 403);
  if (p === '/logout' && request.method === 'POST') { await revokeSession(env, session.id); return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': clearCookie(), ...SEC_HEADERS } }); }
  if (p === '/api/overview') {
    const { text, hit } = await overviewCached(env);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-overview-cache': hit ? 'hit' : 'miss', ...SEC_HEADERS } });
  }
  if (p === '/api/notify/settings' && request.method === 'GET') return json(await notifyStatus(env));
  if (p === '/api/notify/settings' && request.method === 'POST') {
    const body = await jsonBody(request);
    if (!body) return json({ error: 'JSON 본문이 필요합니다' }, 400);
    try { const settings = await saveNotifySettings(env, body.settings); return json({ ok: true, settings, status: await notifyStatus(env) }); }
    catch (e) { if (e instanceof SettingsError) return json({ error: e.message }, 400); throw e; }
  }
  if (p === '/api/notify/test' && request.method === 'POST') {
    const body = await jsonBody(request);
    if (!body) return json({ error: 'JSON 본문이 필요합니다' }, 400);
    return json(await notifyTest(env, body.mode === 'summary' ? 'summary' : 'test'));
  }
  // owner-only: can the Worker egress reach each 코인 시장 신호 source? (status/latency/size only)
  if (p === '/probe' || p === '/api/admin/probe') return json(await probeSources());
  if (p === '/api/admin/tick' && request.method === 'POST') { const log = await tick(env); await dropOverviewCache(env); return json({ log }); }
  if (p === '/api/admin/evaluate' && request.method === 'POST') { const kv = await kvAll(env.DB); await lifecycleTask(env, kv, Math.floor(Date.now() / 1000)); await dropOverviewCache(env); return json({ ok: true }); }
  if (p === '/api/admin/reset-sleeve' && request.method === 'POST') {
    // Owner decision only (never automatic): re-arm the aggressive sleeve with FRESH paper books.
    const kv = await kvAll(env.DB);
    const ids = allStrategies(kv).filter((s) => s.sleeve === 'aggressive').map((s) => `${s.id}:paper`);
    const now = Math.floor(Date.now() / 1000);
    const stmts = [env.DB.prepare("DELETE FROM kv WHERE k = 'sleeve:aggressive:stopped'"),
      env.DB.prepare('INSERT INTO events (t, kind, strategy_id, message, notified) VALUES (?,?,?,?,0)').bind(now, 'stage', null, '주인이 공격형 슬롯을 새 가상 계좌로 다시 시작함 (이전 기록은 삭제)')];
    for (const id of ids) stmts.push(env.DB.prepare('DELETE FROM runs WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM equity WHERE run_id = ?').bind(id), env.DB.prepare('DELETE FROM fills WHERE run_id = ?').bind(id));
    await env.DB.batch(stmts);
    await dropOverviewCache(env);
    return json({ ok: true, reset: ids });
  }
  if (p === '/api/admin/test-telegram' && request.method === 'POST') return json({ sent: await sendTelegram(env, '[모의투자봇] 텔레그램 연결 테스트입니다. (가상 투자 알림 전용)') });
  if (p === '/' || p === '/index.html') return html(dashboardHtml());
  return json({ error: 'not found' }, 404);
}

/** External engine results (e.g. freqtrade dry-run). Only for strategies registered with external: true. */
async function ingest(env, body) {
  const s = byId[body?.strategy_id];
  if (!s || !s.external) return { error: 'strategy not registered as external' };
  const id = `${s.id}:paper`;
  const points = (body.points || []).slice(-5000).map((x) => ({ t: x.t | 0, equity: +x.equity, cash: +x.cash || 0, invested: +x.invested || 0, bench: +x.bench || +x.equity }));
  const fills = (body.fills || []).slice(-5000).map((f, i) => ({ t: f.t | 0, seq: i, sym: String(f.sym), side: f.side === 'SELL' ? 'SELL' : 'BUY', qty: +f.qty, price: +f.price, gross: +f.qty * +f.price, fee: +f.fee || 0, tax: 0, pnl: +f.pnl || 0, reason: String(f.reason || '외부 엔진 체결'), cash: +f.cash || 0 }));
  const last = points[points.length - 1];
  const state = { v: 1, kind: 'external', initialCash: points[0]?.equity || 10_000_000, equity: last?.equity || 0, cash: last?.cash || 0, bench: last?.bench || 0, peak: Math.max(0, ...points.map((x) => x.equity)), pos: {}, lastPx: {}, fills: fills.length, halted: !!body.halted, haltReason: body.haltReason || null, agreement: body.agreement || null, startT: points[0]?.t, epochT: points[0]?.t };
  const stmts = [runUpsertStmt(env.DB, { id, strategy_id: s.id, mode: 'paper', engine: s.engine || 'external', state, start_after: (points[0]?.t || 1) - 1, last_t: last?.t || null }), ...equityStmts(env.DB, id, points), ...fillStmts(env.DB, id, fills)];
  if (body.backtest) stmts.push(backtestStmt(env.DB, s.id, 'wf', s.engine || 'external', body.backtest, null));
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return { ok: true, points: points.length, fills: fills.length };
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); } catch (e) { return json({ error: 'internal', detail: String(e?.message || e).slice(0, 200) }, 500); }
  },
  async scheduled(event, env, ctx) {
    const now = Math.floor((event.scheduledTime || Date.now()) / 1000);
    // Free plan allows only 5 cron triggers per ACCOUNT, so this worker uses a single */10 cron.
    // Daily summary: owner-editable KST times/days/quiet hours (kv 'notify:settings', default 08:40 daily).
    // One small kv read per tick; the summary is claimed (compare-and-set) and sent in the background.
    try {
      const send = await scheduledSummary(env, now);
      if (send) ctx.waitUntil(send.catch(() => {}));
    } catch (_) {}
    const log = await tick(env, now);
    if (env.LOG_TICKS === 'true') console.log(JSON.stringify({ tick: now, log }));
    // Refresh the cached dashboard JSON only after a light tick (Worker CPU limit); else mark it dirty
    // so the next dashboard request rebuilds it. OVERVIEW_CACHE_IN_TICK: auto | always | never.
    const mode = String(env.OVERVIEW_CACHE_IN_TICK || 'auto');
    const heavy = log.some((x) => /^(workerBacktest|lifecycle|krxBackfill|cryptoBackfill|prune)/.test(x)) || log.length > 3;
    try {
      if (mode === 'always' || (mode === 'auto' && !heavy)) await buildOverviewCache(env, now);
      else await markOverviewDirty(env, now);
    } catch (_) {}
  },
};
