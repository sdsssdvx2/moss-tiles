// 2026-11-23: DART 공시가 Workers에서 'Too many redirects'로 한 번도 안 들어옴(UA 없음 → error1.html 자기 순환),
// 그 오류 문구에 인증키가 든 주소가 그대로 data_health.err에 저장됨 → UA를 보내고, 오류 문구에서 키를 가린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers.mjs';
import { FEEDS, DART_UA } from '../src/data/feeds.js';
import { healthErr, redactSecrets } from '../src/db/store.js';
import { feedsTask } from '../src/jobs/feeds.js';

const dart = FEEDS.find((f) => f.id === 'dart');
const NOW = Date.UTC(2026, 10, 23, 12, 0) / 1000;
const SECRET = 'abcdef0123456789abcdef0123456789abcdef01';

test('DART request sends a User-Agent and does not follow redirects', async () => {
  let seen;
  const fetcher = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ status: '000', list: [{ stock_code: '005930', corp_name: '삼성전자', report_nm: '주요사항보고서' }] }), { status: 200 }); };
  const items = await dart.fetch(fetcher, { DART_API_KEY: SECRET }, NOW);
  assert.equal(seen.init.headers['user-agent'], DART_UA);
  assert.equal(seen.init.redirect, 'manual');
  assert.deepEqual(items.map((i) => [i.sym, i.type, i.payload.corp]), [['005930', 'disclosure', '삼성전자']]);
});

test('a redirect or a network error never puts the key into the error text', async () => {
  const redir = async () => new Response(null, { status: 302, headers: { location: 'https://opendart.fss.or.kr/error1.html' } });
  await assert.rejects(dart.fetch(redir, { DART_API_KEY: SECRET }, NOW), (e) => e.message === 'DART_REDIRECT_302');
  const boom = async (url) => { throw new TypeError(`Too many redirects.${url}`); };
  await assert.rejects(dart.fetch(boom, { DART_API_KEY: SECRET }, NOW), (e) => !e.message.includes(SECRET) && /^DART_FETCH_/.test(e.message));
});

test('healthErr masks key-like query values (defence for every source)', async () => {
  assert.equal(redactSecrets(`Too many redirects.https://x.kr/api/list.json?crtfc_key=${SECRET}&bgn_de=20261123`), 'Too many redirects.https://x.kr/api/list.json?crtfc_key=***&bgn_de=20261123');
  assert.equal(redactSecrets('https://a/b?serviceKey=AAA%2Bbb&x=1&token=zz'), 'https://a/b?serviceKey=***&x=1&token=***');
  assert.equal(redactSecrets('NEWS_HTTP_503'), 'NEWS_HTTP_503');
  const DB = makeD1();
  await healthErr(DB, 'feed:x', new Error(`boom https://h/p?crtfc_key=${SECRET}`));
  const row = DB.raw.prepare("SELECT err FROM data_health WHERE source = 'feed:x'").get();
  assert.ok(!row.err.includes(SECRET));
  assert.match(row.err, /crtfc_key=\*\*\*/);
});

test('feedsTask stores disclosures as feed_items when DART answers', async () => {
  const DB = makeD1();
  const kv = {};
  for (const f of FEEDS) if (f.id !== 'dart') kv[`feed:at:${f.id}`] = NOW; // 다른 출처는 방금 돈 것으로
  const fetcher = async () => new Response(JSON.stringify({ status: '000', list: [{ stock_code: '000660', corp_name: 'SK하이닉스', report_nm: '임원ㆍ주요주주특정증권등소유상황보고서' }] }), { status: 200 });
  assert.equal(await feedsTask({ DB, DART_API_KEY: SECRET }, kv, NOW, { fetcher }), true);
  const rows = DB.raw.prepare("SELECT source, sym, type FROM feed_items").all();
  assert.deepEqual(rows.map((r) => [r.source, r.sym, r.type]), [['dart', '000660', 'disclosure']]);
  assert.ok(DB.raw.prepare("SELECT last_ok FROM data_health WHERE source = 'feed:dart'").get().last_ok);
});
