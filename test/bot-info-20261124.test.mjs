// 2026-11-24 #F-012: 봇 사용자 이름·웹훅 여부(주인 전용). 토큰·웹훅 주소는 응답·오류 문구에 나오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { botInfo } from '../src/jobs/notify.js';

const TOKEN = '123456:ABC-secret_token';
test('botInfo: username and webhook flag only — no token, no webhook URL', async () => {
  const seen = [];
  const f = async (url) => { seen.push(url); return Response.json(url.endsWith('/getMe') ? { ok: true, result: { username: 'invest_lab_bot', id: 1 } } : { ok: true, result: { url: 'https://hook.example/secret', pending_update_count: 3 } }); };
  const r = await botInfo({ TELEGRAM_BOT_TOKEN: TOKEN }, f);
  assert.deepEqual(r, { ready: true, username: 'invest_lab_bot', webhook: true, pending: 3 });
  assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('hook.example'));
  assert.equal(seen.length, 2);
  const none = await botInfo({ TELEGRAM_BOT_TOKEN: TOKEN }, async (u) => Response.json(u.endsWith('/getMe') ? { ok: true, result: { username: 'b' } } : { ok: true, result: { url: '' } }));
  assert.equal(none.webhook, false);
  assert.deepEqual(await botInfo({}, f), { ready: false });
});
test('botInfo: errors never leak the token', async () => {
  const r = await botInfo({ TELEGRAM_BOT_TOKEN: TOKEN }, async (u) => { throw new Error(`fetch failed ${u}`); });
  assert.ok(r.error && !r.error.includes('ABC-secret_token'), r.error);
});
