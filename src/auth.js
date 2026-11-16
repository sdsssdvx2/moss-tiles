// Owner-only login. Pattern adapted from my-little-kitchen/src/auth-service.js:
// random session id + HMAC proof keyed by OWNER_PASSWORD (changing the password revokes all
// sessions), revocable rows in D1, HttpOnly+Secure+SameSite=Strict cookie, HMACed rate-limit buckets.
const enc = new TextEncoder();
export const COOKIE = 'fip_owner';
const MAX_AGE = 30 * 86400;
const MSG = 'family-invest-paper-v2-owner-session';

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(message))));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function randomToken(bytes = 24) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function sameString(a, b) {
  const aa = enc.encode(String(a)), bb = enc.encode(String(b));
  if (aa.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < aa.length; i++) d |= aa[i] ^ bb[i];
  return d === 0;
}
export function cookieValue(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(rest.join('=')); } catch { return ''; } }
  }
  return '';
}
export const sessionCookie = (token) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function createSession(request, env, now = Math.floor(Date.now() / 1000)) {
  const id = randomToken(24);
  await env.DB.prepare('INSERT INTO owner_sessions (session_id, created_at, expires_at, user_agent) VALUES (?,?,?,?)')
    .bind(id, now, now + MAX_AGE, String(request.headers.get('user-agent') || '').slice(0, 300)).run();
  return `v1.${id}.${await hmac(env.OWNER_PASSWORD, `${MSG}|${id}`)}`;
}
export async function getSession(request, env, now = Math.floor(Date.now() / 1000)) {
  if (!env.OWNER_PASSWORD) return null;
  const m = cookieValue(request, COOKIE).match(/^v1\.([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  if (!sameString(m[2], await hmac(env.OWNER_PASSWORD, `${MSG}|${m[1]}`))) return null;
  try {
    const row = await env.DB.prepare('SELECT session_id FROM owner_sessions WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(m[1], now).first();
    return row ? { id: m[1] } : null;
  } catch { return null; } // fail closed
}
export async function revokeSession(env, id) {
  await env.DB.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE session_id = ?').bind(Math.floor(Date.now() / 1000), id).run();
}

const WINDOW = 15 * 60, MAX_FAIL = 8, BLOCK = 30 * 60;
async function bucketFor(request, env) {
  const ip = String(request.headers.get('cf-connecting-ip') || 'local');
  return hmac(env.OWNER_PASSWORD || 'none', `login|${ip}`);
}
export async function loginAllowed(request, env, now = Math.floor(Date.now() / 1000)) {
  const b = await bucketFor(request, env);
  const row = await env.DB.prepare('SELECT failures, window_started_at, blocked_until FROM login_rate_limits WHERE bucket = ?').bind(b).first();
  return !(row && row.blocked_until && row.blocked_until > now);
}
export async function recordLogin(request, env, ok, now = Math.floor(Date.now() / 1000)) {
  const b = await bucketFor(request, env);
  if (ok) { await env.DB.prepare('DELETE FROM login_rate_limits WHERE bucket = ?').bind(b).run(); return; }
  const row = await env.DB.prepare('SELECT failures, window_started_at FROM login_rate_limits WHERE bucket = ?').bind(b).first();
  let failures = 1, start = now;
  if (row && now - row.window_started_at < WINDOW) { failures = row.failures + 1; start = row.window_started_at; }
  await env.DB.prepare('INSERT INTO login_rate_limits (bucket, failures, window_started_at, blocked_until) VALUES (?,?,?,?) ON CONFLICT(bucket) DO UPDATE SET failures=excluded.failures, window_started_at=excluded.window_started_at, blocked_until=excluded.blocked_until')
    .bind(b, failures, start, failures >= MAX_FAIL ? now + BLOCK : null).run();
}
export async function checkPassword(env, input) {
  if (!env.OWNER_PASSWORD) return false;
  // compare HMACs so timing does not depend on length
  return sameString(await hmac('pw', String(input || '')), await hmac('pw', env.OWNER_PASSWORD));
}
/** Bearer token for machine endpoints (export / ingest). */
export function bearerOk(request, secret) {
  if (!secret) return false;
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && sameString(h.slice(7), secret);
}
