import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeBars } from './helpers.mjs';
import {
  parseUpbitFlags, parseTelegramPreview, classifyNotice, parseBithumbWallet, parseBithumbWarnings, parseBinanceDelist,
  parseOkxFunding, parseOkxOiHist, parseOkxLs, parseOkxLiq, parseHyperliquid,
  premiums, computeGuard, guardKey, mktConfig, MKT_DEFAULTS, MKT_GROUPS,
} from '../src/data/market-signals.js';
import { applyMarketGuard } from '../src/core/market-guard.js';
import { marketSignalsTask, guardFor, marketSignalsView, probeSources } from '../src/jobs/market-signals.js';
import { paperTask } from '../src/jobs/paper.js';
import { signalAgreement } from '../src/jobs/lifecycle.js';
import { tick } from '../src/jobs/tick.js';
import { overview, exportSignals } from '../src/api.js';
import { kvAll, kvSetStmt, candleStmts, getRuns } from '../src/db/store.js';
import { byId } from '../src/strategies/index.js';
import { Feed, createState, stepBar } from '../src/core/engine.js';
import { buildOpts } from '../src/core/backtest.js';
import { DAY, HOUR } from '../src/core/calendar.js';
import worker from '../src/worker.js';

const NOW = 1_794_756_800; // 2026-11-15 ~15:33 UTC
const cfg = { ...MKT_DEFAULTS };
const REL = new Set(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA', 'KRW-KAVA', 'KRW-MANTRA', 'KRW-SANC']);

// ---- mocked primary-source responses (shapes copied from live responses on 2026-11-16) ----
const ev = (warning, caution = {}) => ({ warning, caution: { PRICE_FLUCTUATIONS: false, TRADING_VOLUME_SOARING: false, DEPOSIT_AMOUNT_SOARING: false, GLOBAL_PRICE_DIFFERENCES: false, CONCENTRATION_OF_SMALL_ACCOUNTS: false, ...caution } });
const UPBIT_ALL = [
  { market: 'BTC-BERA', korean_name: '베라체인', market_event: ev(false, { GLOBAL_PRICE_DIFFERENCES: true }) },
  { market: 'KRW-BTC', korean_name: '비트코인', market_event: ev(false, { DEPOSIT_AMOUNT_SOARING: true }) },
  { market: 'KRW-ETH', korean_name: '이더리움', market_event: ev(false) },
  { market: 'KRW-XRP', korean_name: '리플', market_event: ev(false, { TRADING_VOLUME_SOARING: true }) },
  { market: 'KRW-SOL', korean_name: '솔라나', market_event: ev(false, { DEPOSIT_AMOUNT_SOARING: true }) },
  { market: 'KRW-ADA', korean_name: '에이다' }, // no market_event -> fail-closed
  { market: 'KRW-KAVA', korean_name: '카바', market_event: ev(false) },
  { market: 'KRW-MANTRA', korean_name: '만트라', market_event: ev(true) },
  { market: 'KRW-SANC', korean_name: '생텀', market_event: ev(false) },
  { market: 'KRW-WAVES', korean_name: '웨이브', market_event: ev(true) },
  // KRW-DOGE missing from the list -> frozen
];
const tgMsg = (id, iso, title) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="upbit_news/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${title}<br/><br/><a href="https://upbit.com/x">🔗 공지사항 확인하기</a></div><div class="tgme_widget_message_footer"><a class="tgme_widget_message_date"><time datetime="${iso}" class="time">00:00</time></a></div></div></div>`;
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', '+00:00');
const TG_HTML = `<html><body>${[
  tgMsg(2120, iso(NOW - 20 * DAY), '[거래] 오래된(OLD) 신규 거래지원 안내'),
  tgMsg(2125, iso(NOW - 3 * DAY), '[거래] 생텀(SANC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)'),
  tgMsg(2126, iso(NOW - 2 * DAY), '[입출금] 포켓네트워크(POKT) 입출금 일시 중단 안내 (완료)'),
  tgMsg(2127, iso(NOW - DAY), '[거래] 만트라(MANTRA) 거래지원 종료 안내 (12/14 15:00)'),
  tgMsg(2128, iso(NOW - 5 * HOUR), '[입출금] 카바(KAVA) 입출금 일시 중단 안내'),
  tgMsg(2129, iso(NOW - 4 * HOUR), '[점검] 실물 운전면허증 진위 여부 확인 일시 중단 안내 (11/13 19:00 ~)'),
  tgMsg(2130, iso(NOW - 3 * HOUR), '[거래] 리플(XRP) 유의 촉구 안내'),
].join('')}</body></html>`;
const UPBIT_TICKER = (btc, usdt = 1378) => [{ market: 'KRW-BTC', trade_price: btc }, { market: 'KRW-USDT', trade_price: usdt }];
const BITHUMB_TICKER = [{ market: 'KRW-USDT', trade_price: 1379 }, { market: 'KRW-BTC', trade_price: 89_250_000 }];
const BITHUMB_WALLET = { status: '0000', data: { BTC: { withdrawal_status: 1, deposit_status: 1 }, ETH: { withdrawal_status: 0, deposit_status: 1 }, ICX: { withdrawal_status: 1, deposit_status: 0 } } };
const BITHUMB_WARN = [
  { market: 'KRW-DOGE', warning_type: 'PRICE_DIFFERENCE_HIGH', warning_step: 'DANGER', end_date: '2099-01-01 00:00:00' },
  { market: 'KRW-SOL', warning_type: 'PRICE_SUDDEN_FLUCTUATION', warning_step: 'CAUTION', end_date: '2099-01-01 00:00:00' },
  { market: 'KRW-ETH', warning_type: 'X', warning_step: 'WARNING', end_date: '2020-01-01 00:00:00' }, // expired
];
const BINANCE_CMS = { code: '000000', data: { catalogs: [{ catalogId: 161, articles: [
  { title: 'Binance Will Delist SOL, ABC and XYZ on 2026-11-20', releaseDate: (NOW - 2 * DAY) * 1000 },
  { title: 'Binance Futures Will Delist PTBUSDT and MITOUSDT USDⓈ-M Perpetual Contracts (2026-10-23)', releaseDate: (NOW - DAY) * 1000 },
  { title: 'Binance Will Delist OLD on 2026-09-01', releaseDate: (NOW - 60 * DAY) * 1000 },
  { title: 'Notice of Removal of Spot Trading Pairs - 2026-10-30', releaseDate: (NOW - DAY) * 1000 },
] }] } };
const OKX_FUND = (r) => ({ code: '0', data: [{ fundingRate: String(r), instId: 'BTC-USDT-SWAP' }] });
const OKX_OI = { code: '0', data: [['1794754800000', '3249584', '32495', '2100000000'], ['1794668400000', '3361721', '33617', '2000000000']] };
const OKX_LS = { code: '0', data: [['1794754800000', '2.25']] };
const OKX_LIQ = { code: '0', data: [{ details: [
  { bkPx: '64000', posSide: 'long', side: 'sell', sz: '1000', ts: '1794755419574' }, // 1000*0.01*64000 = 640k
  { bkPx: '64000', posSide: 'short', side: 'buy', sz: '250', ts: '1794753619574' },  // 160k
] }] };
const HL = [{ universe: [{ name: 'BTC' }, { name: 'SOL' }, { name: 'ETH' }] }, [{ funding: '0.0000125', openInterest: '30000', markPx: '64700' }, {}, { funding: '0.00002', openInterest: '500000', markPx: '3000' }]];

function marketFetch({ upbitBtc = 89_298_000, upbitUsdt = 1378, fail = new Set(), tg = TG_HTML } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url); calls.push(u.hostname + u.pathname);
    if (fail.has(u.hostname)) return new Response('blocked', { status: 451 });
    if (u.hostname === 'api.upbit.com' && u.pathname.includes('market/all')) return Response.json(UPBIT_ALL);
    if (u.hostname === 'api.upbit.com' && u.pathname.includes('ticker')) return Response.json(UPBIT_TICKER(upbitBtc, upbitUsdt));
    if (u.hostname === 't.me') return new Response(tg, { headers: { 'content-type': 'text/html' } });
    if (u.hostname === 'api.bithumb.com' && u.pathname.includes('assetsstatus')) return Response.json(BITHUMB_WALLET);
    if (u.hostname === 'api.bithumb.com' && u.pathname.includes('virtual_asset_warning')) return Response.json(BITHUMB_WARN);
    if (u.hostname === 'api.bithumb.com') return Response.json(BITHUMB_TICKER);
    if (u.hostname === 'data-api.binance.vision') return Response.json({ symbol: 'BTCUSDT', price: '64722.68' });
    if (u.hostname === 'api.exchange.coinbase.com') return Response.json({ price: '64677.77' });
    if (u.hostname === 'open.er-api.com') return Response.json({ result: 'success', rates: { KRW: 1336 } });
    if (u.hostname === 'www.binance.com') return Response.json(BINANCE_CMS);
    if (u.hostname === 'api.hyperliquid.xyz') { assert.equal(init?.method, 'POST'); return Response.json(HL); }
    if (u.hostname === 'www.okx.com') {
      if (u.pathname.includes('funding-rate')) return Response.json(OKX_FUND(0.0000136));
      if (u.pathname.includes('open-interest-history')) return Response.json(OKX_OI);
      if (u.pathname.includes('long-short')) return Response.json(OKX_LS);
      if (u.pathname.includes('liquidation-orders')) return Response.json(OKX_LIQ);
      if (u.pathname.includes('market/ticker')) return Response.json({ code: '0', data: [{ last: '64710' }] });
    }
    if (u.hostname === 'api.alternative.me') return Response.json({ data: [{ value: '12', value_classification: 'Extreme Fear', timestamp: String(NOW) }] });
    return new Response('nope', { status: 404 });
  };
  f.calls = calls;
  return f;
}
const fullSnaps = (now = NOW) => ({
  upbit_flags: { at: now, ...parseUpbitFlags(UPBIT_ALL) },
  notices: { at: now, upbitOk: true, upbitNotices: parseTelegramPreview(TG_HTML).map((n) => ({ ...n, ...(classifyNotice(n.title) || { rule: null, coins: [] }) })), bithumbWarnings: parseBithumbWarnings(BITHUMB_WARN), wallet: parseBithumbWallet(BITHUMB_WALLET), delist: parseBinanceDelist(BINANCE_CMS, now) },
  premium: { at: now, ...premiums({ upbitBtc: 89_298_000, upbitUsdt: 1378, bithumbBtc: 89_250_000, bithumbUsdt: 1379, binanceBtc: 64722.68, okxBtc: 64710, coinbaseBtc: 64677.77, fx: 1336 }) },
  derivs: { at: now, funding: { BTC: 0.0009, ETH: 0.0001 }, liq: { usd: 1e9, longShare: 0.95 } },
});

test('parsers: Upbit flags (fail-closed), Telegram notices, Bithumb, Binance delist, OKX, Hyperliquid', () => {
  const uf = parseUpbitFlags(UPBIT_ALL);
  assert.ok(uf.krw.includes('KRW-ADA') && !uf.krw.includes('BTC-BERA') && !uf.krw.includes('KRW-DOGE'));
  assert.equal(uf.flags.find((f) => f.sym === 'KRW-ADA').missing, true);
  assert.equal(uf.flags.find((f) => f.sym === 'KRW-MANTRA').warning, true);
  assert.equal(uf.flags.some((f) => f.sym === 'KRW-ETH'), false);
  assert.throws(() => parseUpbitFlags([{ market: 'KRW-BTC' }]), /NO_MARKET_EVENT/); // is_details dropped -> error, not "all clean"
  assert.throws(() => parseUpbitFlags({ error: 1 }), /FORMAT/);
  const tg = parseTelegramPreview(TG_HTML);
  assert.equal(tg.length, 7);
  assert.equal(tg[tg.length - 1].id, 2130);
  assert.equal(tg[tg.length - 1].url, 'https://t.me/upbit_news/2130');
  assert.equal(tg[tg.length - 1].title, '[거래] 리플(XRP) 유의 촉구 안내');
  assert.equal(tg[tg.length - 1].t, NOW - 3 * HOUR);
  assert.deepEqual(parseTelegramPreview('<html>changed layout</html>'), []);
  assert.deepEqual(classifyNotice('[거래] 만트라(MANTRA) 거래지원 종료 안내 (12/14 15:00)'), { rule: 'close', coins: ['MANTRA'] });
  assert.deepEqual(classifyNotice('[거래] 카바(KAVA) 유의 촉구 안내'), { rule: 'close', coins: ['KAVA'] });
  assert.deepEqual(classifyNotice('[입출금] 카바(KAVA) 입출금 일시 중단 안내'), { rule: 'suspend', coins: ['KAVA'] });
  assert.equal(classifyNotice('[입출금] 포켓네트워크(POKT) 입출금 일시 중단 안내 (완료)'), null);
  assert.deepEqual(classifyNotice('[거래] 생텀(SANC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)'), { rule: 'listing', coins: ['SANC'] });
  assert.equal(classifyNotice('[점검] 실물 운전면허증 진위 여부 확인 일시 중단 안내'), null);
  assert.deepEqual(parseBithumbWallet(BITHUMB_WALLET), { ETH: { dep: true, wd: false }, ICX: { dep: false, wd: true } });
  assert.throws(() => parseBithumbWallet({ status: '5600' }), /FORMAT/);
  const bw = parseBithumbWarnings(BITHUMB_WARN);
  assert.equal(bw[0].end, Date.parse('2099-01-01T00:00:00+09:00') / 1000);
  const dl = parseBinanceDelist(BINANCE_CMS, NOW, 14);
  assert.equal(dl.length, 1);
  assert.deepEqual(dl[0].coins, ['SOL', 'ABC', 'XYZ']);
  assert.equal(parseOkxFunding(OKX_FUND(0.0007)), 0.0007);
  const oi = parseOkxOiHist(OKX_OI);
  assert.equal(oi.usd, 2.1e9); assert.ok(Math.abs(oi.chg24h - 0.05) < 1e-9);
  assert.equal(parseOkxLs(OKX_LS), 2.25);
  const liq = parseOkxLiq(OKX_LIQ, 0.01);
  assert.equal(Math.round(liq.usd), 800_000); assert.equal(Math.round(liq.longUsd), 640_000);
  assert.ok(Math.abs(liq.hours - 0.5) < 1e-6);
  const hl = parseHyperliquid(HL);
  assert.ok(Math.abs(hl.BTC.funding8h - 0.0001) < 1e-12); // hourly rate x8 (0.01%/8h = neutral)
  assert.equal(hl.BTC.oiUsd, 30000 * 64700);
  assert.equal(hl.SOL, undefined);
});

test('premiums: USDT-based kimchi (no FX), cross-exchange deviation, coinbase premium', () => {
  const p = premiums({ upbitBtc: 89_298_000, upbitUsdt: 1378, bithumbBtc: 89_250_000, bithumbUsdt: 1379, binanceBtc: 64722.68, okxBtc: 64710, coinbaseBtc: 64677.77, fx: 1336 });
  const base = (64722.68 + 64710) / 2;
  assert.ok(Math.abs(p.premUsdt - (89_298_000 / (base * 1378) - 1)) < 1e-12);
  assert.ok(Math.abs(p.tether - (1378 / 1336 - 1)) < 1e-12);
  assert.ok(Math.abs(p.coinbase - (64677.77 / base - 1)) < 1e-12);
  assert.ok(p.foreignDev < 0.001 && p.krDev < 0.001);
  assert.equal(p.foreignN, 3);
  assert.equal(premiums({ upbitBtc: 1, binanceBtc: 1 }).premUsdt, null); // missing input -> no number, never a guess
});

test('computeGuard: per-coin levels from flags + notices, fail-closed, frozen, alt hold, market rules, derivatives shadow only', () => {
  const g = computeGuard(fullSnaps(), cfg, NOW, REL);
  const L = (s) => g.coins[s]?.level;
  assert.equal(L('KRW-MANTRA'), 'close');               // 투자유의 + 거래지원 종료 공지
  assert.match(g.coins['KRW-MANTRA'].why, /투자유의.*거래지원 종료/);
  assert.equal(L('KRW-XRP'), 'close');                  // 주의(거래량 급증)=block, then 유의 촉구 공지=close
  assert.equal(L('KRW-KAVA'), 'block');                 // 입출금 일시 중단 공지 5h ago (48h window)
  assert.equal(L('KRW-ADA'), 'block');                  // no market_event -> fail-closed
  assert.equal(L('KRW-DOGE'), 'block');                 // vanished (frozen) + Bithumb DANGER
  assert.deepEqual(g.frozen, ['KRW-DOGE']);
  assert.equal(L('KRW-SANC'), 'block');                 // new listing 3 days ago -> 14-day no-chase
  assert.equal(L('KRW-SOL'), 'block');                  // half(입금량 급증) but Binance delist notice -> block
  assert.equal(L('KRW-ETH'), 'block');                  // Bithumb withdrawal suspended (expired Bithumb warning ignored)
  assert.equal(L('KRW-BTC'), undefined);                // majors: DEPOSIT_AMOUNT_SOARING -> warning only
  assert.ok(g.warnings.some((w) => w.includes('KRW-BTC')));
  assert.equal(g.coins['KRW-WAVES'], undefined);        // not traded by us
  assert.equal(g.altHold, null);
  assert.equal(g.damp, null);                           // premiums normal; funding/liq are SHADOW only by default
  assert.ok(!/\d/.test(Object.values(g.coins).map((c) => c.why).join('').replace(/48|14/g, '')));
  // the 48h suspend window and 14d listing window expire
  const later = computeGuard(fullSnaps(NOW + 15 * DAY), cfg, NOW + 15 * DAY, REL);
  assert.ok(!later.coins['KRW-SANC'] && !later.coins['KRW-KAVA'] && later.coins['KRW-MANTRA']?.level === 'close');
  // half level for an alt with only DEPOSIT_AMOUNT_SOARING
  const s2 = fullSnaps(); s2.notices.delist = [];
  assert.equal(computeGuard(s2, cfg, NOW, REL).coins['KRW-SOL'].level, 'half');
  // notice feed broken / flags stale -> alts on hold
  const s3 = fullSnaps(); s3.notices.upbitOk = false;
  assert.match(computeGuard(s3, cfg, NOW, REL).altHold, /공지 데이터 없음/);
  const s4 = fullSnaps(); s4.upbit_flags.at = NOW - 4 * HOUR;
  assert.match(computeGuard(s4, cfg, NOW, REL).altHold, /경보 데이터/);
  // market-wide rules
  const withPrem = (patch) => { const s = fullSnaps(); s.premium = { ...s.premium, ...patch }; return computeGuard(s, cfg, NOW, REL).damp; };
  assert.deepEqual([withPrem({ premUsdt: 0.035 }).factor, withPrem({ premUsdt: 0.035 }).triggers], [0.5, ['premHalf']]);
  assert.equal(withPrem({ premUsdt: 0.06 }).factor, 0);
  assert.equal(withPrem({ premUsdt: -0.03 }), null); // 역프: warning only
  assert.equal(withPrem({ foreignDev: 0.03 }).factor, 0);
  assert.equal(withPrem({ krDev: 0.025 }).factor, 0);
  assert.equal(withPrem({ tether: 0.045 }).factor, 0.5);
  assert.equal(withPrem({ coinbase: -0.004 }).factor, 0.5);
  assert.deepEqual(computeGuard(fullSnaps(), { ...cfg, derivRules: true }, NOW, REL).damp.triggers, ['funding', 'liq']);
  const st = fullSnaps(); st.premium.at = NOW - 4 * HOUR; st.premium.premUsdt = 0.2;
  assert.equal(computeGuard(st, cfg, NOW, REL).damp, null); // stale -> not applied, warned
  // switches + config
  assert.deepEqual(computeGuard(fullSnaps(), { ...cfg, guard: false }, NOW, REL).coins, {});
  assert.equal(guardKey(g), guardKey(computeGuard(fullSnaps(NOW + 60), cfg, NOW + 60, REL)));
  assert.equal(mktConfig({ MARKET_SIGNALS_JSON: '{"premHold":0.08}' }).premHold, 0.08);
  assert.equal(mktConfig({ MARKET_SIGNALS_JSON: 'not json' }).premHold, 0.05);
  assert.equal(mktConfig({ MARKET_SIGNALS_ENABLED: 'false' }).enabled, false);
});

test('applyMarketGuard: never adds buying; levels close/block/half, alt hold, market factor', () => {
  const g = { coins: { 'KRW-XRP': { level: 'close', why: '업비트 투자유의' }, 'KRW-DOGE': { level: 'block', why: 'x' }, 'KRW-SOL': { level: 'half', why: '업비트 주의' } }, altHold: null, damp: null };
  const w = { 'KRW-XRP': 0.2, 'KRW-ETH': 0.1 };
  let t = { 'KRW-XRP': 0.25, 'KRW-DOGE': 0.2, 'KRW-SOL': 0.2, 'KRW-ETH': 0.3 }, n = {};
  applyMarketGuard(t, n, w, g, { sleeve: null });
  assert.equal(t['KRW-XRP'], 0.2); assert.match(n['KRW-XRP'], /청산 전용/);
  assert.equal(t['KRW-DOGE'], 0); assert.match(n['KRW-DOGE'], /새로 사지 않음/);
  assert.equal(t['KRW-SOL'], 0.1);
  assert.equal(t['KRW-ETH'], 0.3);
  // aggressive sleeve: close/block coins excluded (held ones sold)
  t = { 'KRW-XRP': 0.25, 'KRW-ETH': 0.05 }; n = {};
  applyMarketGuard(t, n, w, g, { sleeve: 'aggressive' });
  assert.equal(t['KRW-XRP'], 0); assert.match(n['KRW-XRP'], /공격형 슬롯에서 제외/);
  assert.equal(t['KRW-ETH'], 0.05); // a reduction is never touched
  // alt hold: alts frozen at current weight, majors unaffected
  t = { 'KRW-ADA': 0.2, 'KRW-BTC': 0.3 }; n = {};
  applyMarketGuard(t, n, {}, { coins: {}, altHold: '업비트 공지 데이터 없음', damp: null }, {});
  assert.equal(t['KRW-ADA'], 0); assert.equal(t['KRW-BTC'], 0.3);
  // market factor 0 = hold, 0.5 = half; min with coin half
  t = { 'KRW-BTC': 0.3, 'KRW-SOL': 0.2 }; n = {};
  applyMarketGuard(t, n, { 'KRW-BTC': 0.1 }, { coins: { 'KRW-SOL': { level: 'half', why: 'h' } }, damp: { factor: 0.5, reason: '김프' } }, {});
  assert.ok(Math.abs(t['KRW-BTC'] - 0.2) < 1e-12); assert.equal(t['KRW-SOL'], 0.1);
  t = { 'KRW-BTC': 0.3 }; n = {};
  applyMarketGuard(t, n, {}, { coins: {}, damp: { factor: 0, reason: '가격 차이' } }, {});
  assert.equal(t['KRW-BTC'], 0); assert.match(n['KRW-BTC'], /보류/);
  t = { 'KRW-BTC': 0.3 };
  applyMarketGuard(t, {}, {}, null, {});
  assert.equal(t['KRW-BTC'], 0.3);
});

test('engine: guard applies only when passed (paper); backtest without guard is unchanged', () => {
  const bars = makeBars({ start: '2025-01-01', n: 260, seed: 5, drift: 0.004, vol: 0.01, p0: 50_000_000 });
  const s = byId.crypto_trend_v1;
  const run = (guard) => {
    const feed = new Feed({ 'KRW-BTC': bars, 'KRW-ETH': bars });
    const st = createState(10_000_000);
    const opts = buildOpts(s, { guard });
    const fills = [];
    for (const b of bars) fills.push(...stepBar(st, b.t, feed, opts).fills);
    return fills;
  };
  const plain = run(undefined);
  assert.ok(plain.some((f) => f.side === 'BUY'), 'fixture should produce buys');
  assert.equal(run(() => ({ coins: { 'KRW-BTC': { level: 'block', why: 'x' }, 'KRW-ETH': { level: 'close', why: 'x' } } })).filter((f) => f.side === 'BUY').length, 0);
  assert.equal(run(() => ({ coins: {}, damp: { factor: 0, reason: 'r' } })).filter((f) => f.side === 'BUY').length, 0);
  const damped = run(() => ({ coins: {}, damp: { factor: 0.5, reason: 'r' } }));
  const firstBuy = (fs) => fs.find((f) => f.side === 'BUY');
  assert.ok(firstBuy(damped).gross < firstBuy(plain).gross * 0.6);
});

test('marketSignalsTask: ≤2 groups per tick, cadence, compact snapshots, health, history only on change, shadow log, notices in D1', async () => {
  const env = { DB: makeD1() };
  await kvSetStmt(env.DB, 'crypto:universe', ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-MANTRA']).run();
  const f = marketFetch();
  let kv = await kvAll(env.DB);
  assert.equal(await marketSignalsTask(env, kv, NOW, { fetcher: f }), true);
  assert.equal(Object.keys(kv).filter((k) => k.startsWith('mkt:at:')).length, 2);
  await marketSignalsTask(env, kv, NOW + 600, { fetcher: f });
  assert.equal(await marketSignalsTask(env, kv, NOW + 1200, { fetcher: f }), false); // nothing due
  kv = await kvAll(env.DB);
  for (const g of MKT_GROUPS) assert.ok(kv[`mkt:${g.id}`]?.at, g.id);
  assert.ok(f.calls.length <= 1 + 4 + 7 + 9, `subrequests ${f.calls.length}`);
  assert.ok(JSON.stringify(kv['mkt:upbit_flags']).length < 4000); // compact, not the 250 KB body
  assert.equal(kv['mkt:premium'].foreignN, 3);
  assert.equal(kv['mkt:derivs'].oi.totalUsd, 4.2e9);
  assert.ok(kv['mkt:derivs'].hl.BTC.funding8h > 0);
  const gd = kv['mkt:guard'];
  assert.equal(gd.coins['KRW-MANTRA'].level, 'close');
  assert.equal(gd.coins['KRW-XRP'].level, 'close');
  assert.equal(gd.coins['KRW-ETH'].level, 'block');
  assert.equal(gd.damp, null);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM data_health WHERE source LIKE 'mkt:%'").get().n, 4);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM signals WHERE kind = 'deriv_log'").get().n, 2);
  const nt = env.DB.raw.prepare("SELECT sym, type, payload FROM feed_items WHERE source = 'upbit_notice'").all();
  assert.ok(nt.some((x) => x.type === 'close' && JSON.parse(x.payload).url.startsWith('https://t.me/upbit_news/')));
  const alerts = env.DB.raw.prepare("SELECT kind, message FROM events WHERE kind IN ('market_alert','market_signal')").all();
  assert.ok(alerts.some((e) => e.kind === 'market_alert' && e.message.includes('만트라') || e.message.includes('MANTRA')));
  const snaps1 = env.DB.raw.prepare("SELECT COUNT(*) n FROM signals WHERE kind = 'risk_snap'").get().n;
  // unchanged guard 30 min later -> no new history rows
  kv = await kvAll(env.DB);
  assert.equal(await marketSignalsTask(env, kv, NOW + 2401, { fetcher: f }), true); // premium due again
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM signals WHERE kind = 'risk_snap'").get().n, snaps1);
  // USDT-based premium jumps to ~+6% -> new crypto buys on hold, one history snapshot + event
  kv = await kvAll(env.DB);
  await marketSignalsTask(env, kv, NOW + 4300, { fetcher: marketFetch({ upbitBtc: 94_500_000 }), maxGroups: 4 });
  kv = await kvAll(env.DB);
  assert.deepEqual([kv['mkt:guard'].damp.factor, kv['mkt:guard'].damp.triggers], [0, ['krDev', 'premHold']]); // Upbit alone jumped: also an Upbit-Bithumb gap
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM signals WHERE kind = 'risk_snap'").get().n, snaps1 + 1);
  assert.ok(env.DB.raw.prepare("SELECT message FROM events WHERE kind = 'market_signal'").all().some((e) => e.message.includes('보류')));
  assert.equal(f.calls.filter((c) => c.startsWith('open.er-api.com')).length, 1); // FX cached
  // Telegram preview layout changes -> alts on hold + owner alert, old notices kept
  kv = await kvAll(env.DB);
  kv['mkt:at:notices'] = 0;
  await marketSignalsTask(env, kv, NOW + 9000, { fetcher: marketFetch({ tg: '<html>new layout</html>' }) });
  kv = await kvAll(env.DB);
  assert.match(kv['mkt:guard'].altHold, /공지 데이터 없음/);
  assert.ok(kv['mkt:notices'].upbitNotices.length >= 5);
  assert.ok(env.DB.raw.prepare("SELECT message FROM events WHERE kind = 'market_alert'").all().some((e) => e.message.includes('알트코인')));
  // every source down -> health error, previous snapshot kept
  const before = kv['mkt:upbit_flags'];
  kv['mkt:at:upbit_flags'] = 0;
  await marketSignalsTask(env, kv, NOW + 20000, { fetcher: async () => new Response('x', { status: 418 }), maxGroups: 4 });
  kv = await kvAll(env.DB);
  assert.deepEqual(kv['mkt:upbit_flags'], before);
  assert.match(env.DB.raw.prepare("SELECT err FROM data_health WHERE source = 'mkt:upbit_flags'").get().err, /418/);
  // dashboard view + export
  const view = await marketSignalsView(env, kv, NOW + 20000);
  assert.equal(view.groups.length, 4);
  assert.ok(view.flags.find((x) => x.sym === 'KRW-XRP').relevant);
  assert.equal(view.flags.find((x) => x.sym === 'KRW-WAVES').relevant, false);
  assert.ok(view.notices.length >= 3);
  const ex = await exportSignals(env);
  assert.equal(ex.marketRisk.coins['KRW-MANTRA'].level, 'close');
  assert.equal(await marketSignalsTask({ ...env, MARKET_SIGNALS_ENABLED: 'false' }, kv, NOW + 99999, { fetcher: f }), false);
});

test('paper ledger: point-in-time guard blocks new buys after the flag, agreement replay stays 100%', async () => {
  const env = { DB: makeD1() };
  const syms = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'];
  const stmts = [];
  syms.forEach((s, i) => stmts.push(...candleStmts(env.DB, 'crypto', '1d', s, makeBars({ start: '2025-06-01', n: 520, seed: 200 + i, drift: 0.002, vol: 0.03, p0: 50_000_000 / (i + 1) }), 'test')));
  await env.DB.batch(stmts);
  const days = env.DB.raw.prepare("SELECT DISTINCT t FROM candles WHERE market='crypto' AND tf='1d' ORDER BY t").all().map((r) => r.t);
  await env.DB.batch([kvSetStmt(env.DB, 'crypto:universe', syms), kvSetStmt(env.DB, 'cov:crypto:1d', Object.fromEntries(syms.map((s) => [s, { min: days[0], max: days[days.length - 1] }])))]);
  const flagAt = days[days.length - 30] + DAY; // guard appears at the close of that bar
  const ins = env.DB.prepare('INSERT INTO signals (sym, t, kind, value, note) VALUES (?,?,?,?,?)');
  await env.DB.batch([ins.bind('*mkt', days[days.length - 59], 'risk_snap', 0, '{}'), ins.bind('*mkt', flagAt, 'risk_snap', 1, '{"altHold":"업비트 공지 데이터 없음"}'),
    ins.bind('*crypto', flagAt, 'risk_damp', 0, '거래소 가격 차이 이상')]);
  const ids = ['crypto_trend_v1', 'alt_mom_v1', 'crypto_bh_v1'];
  const strategies = ids.map((id) => byId[id]);
  const setReady = (i) => kvSetStmt(env.DB, 'ready:crypto:1d', days[days.length - 60 + i]).run();
  await setReady(0);
  let kv = await kvAll(env.DB);
  await paperTask(env, kv, NOW, { maxSteps: 50, strategies });
  for (let i = 1; i < 60; i++) { await setReady(i); kv = await kvAll(env.DB); for (let k = 0; k < 2; k++) await paperTask(env, kv, NOW, { maxSteps: 50, strategies }); }
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.strategy_id, r]));
  // decisions at bar t fill at the NEXT bar's open -> any BUY filled after flagAt would be a leak
  const lateBuys = env.DB.raw.prepare("SELECT run_id, t, sym FROM fills WHERE side = 'BUY' AND t > ? AND run_id IN ('crypto_trend_v1:paper','alt_mom_v1:paper')").all(flagAt);
  assert.deepEqual(lateBuys, []);
  const earlyBuys = env.DB.raw.prepare("SELECT COUNT(*) n FROM fills WHERE side = 'BUY' AND t <= ? AND run_id LIKE '%:paper'").get(flagAt).n;
  assert.ok(earlyBuys > 0, 'fixture should buy before the guard');
  const guard = await guardFor(env, byId.crypto_trend_v1, days[days.length - 60], days[days.length - 1]);
  assert.equal(guard(days[days.length - 40]).damp, null);
  assert.equal(guard(days[days.length - 2]).damp.factor, 0);
  assert.equal(guard(days[days.length - 2]).altHold, '업비트 공지 데이터 없음');
  assert.equal(await guardFor(env, byId.crypto_bh_v1, 0, days[days.length - 1]), undefined); // benchmark untouched
  assert.equal(await guardFor(env, byId.etf_trend_v1, 0, days[days.length - 1]), undefined); // KRX untouched
  assert.equal(await guardFor({ ...env, MARKET_SIGNALS_ENABLED: 'false' }, byId.crypto_trend_v1, 0, days[days.length - 1]), undefined);
  for (const id of ['crypto_trend_v1', 'alt_mom_v1']) {
    const a = await signalAgreement(env, kv, byId[id], runs[id]);
    assert.equal(a.matched, a.total, id);
  }
});

test('tick + overview + /probe: piggyback on the 10-minute cron; probe is owner-only and reports every source', async () => {
  const env = { DB: makeD1(), COLLECT_ENABLED: 'true', DATA_TASKS_PER_TICK: '3', FEEDS_ENABLED: 'false', OWNER_PASSWORD: 'pw-for-test' };
  const f = marketFetch();
  const base = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.upbit.com' && u.pathname.includes('candles')) return Response.json([]);
    if (u.hostname === 'api.upbit.com' && u.pathname.includes('ticker/all')) return Response.json([{ market: 'KRW-BTC', acc_trade_price_24h: 1 }]);
    if (u.hostname === 'fchart.stock.naver.com') return new Response('<chartdata></chartdata>');
    return f(url, init);
  };
  for (let i = 0; i < 6; i++) await tick(env, NOW + i * 600, { fetcher: base });
  const kv = await kvAll(env.DB);
  assert.ok(MKT_GROUPS.filter((g) => kv[`mkt:${g.id}`]).length >= 2);
  const ov = await overview(env, NOW + 3600);
  assert.ok(ov.marketSignals && ov.marketSignals.enabled && Array.isArray(ov.marketSignals.groups));
  const pr = await probeSources({ fetcher: f });
  assert.equal(pr.total, pr.rows.length);
  assert.ok(pr.ok >= pr.total - 1, JSON.stringify(pr.rows.filter((r) => !r.ok)));
  assert.ok(pr.rows.every((r) => !('body' in r)));
  const ctx = { waitUntil() {} };
  assert.equal((await worker.fetch(new Request('https://x/probe'), env, ctx)).status, 200); // login page, not probe data
  assert.ok(!(await (await worker.fetch(new Request('https://x/probe'), env, ctx)).text()).includes('"rows"'));
  assert.equal((await worker.fetch(new Request('https://x/api/admin/probe'), env, ctx)).status, 401);
});

test('dashboard: market-signal bar + card render without errors', async () => {
  const { dashboardHtml } = await import('../src/ui/dashboard.js');
  const html = dashboardHtml();
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(js));
  for (const w of ['코인 시장 신호', '테더 김프', '김프(USDT 기준)', '코인베이스 프리미엄', '강제청산', '청산 전용', '/probe']) assert.ok(js.includes(w), w);
});
