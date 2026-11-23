// 자동 결정(2026-11-18): 어떤 전략을 쓸지·몇 배로 할지·언제 쉴지를 미리 정한 기준(core/principles.js)으로
// 시스템이 정하고, 결론을 쉬운 한 줄로 만든다. 사용자가 하는 결정은 미래의 "실제 돈 연결 예/아니오" 하나뿐.
// Pure: no I/O. 실제 주문 기능은 없다(연결 권고는 문구일 뿐).
import { PRINCIPLES, BOOKS, RECOMMEND, CRITERIA_VERSION } from './principles.js';
import { DAY } from './calendar.js';

export const DISCLAIMER = '투자 조언이 아니며, 실제 돈은 손실이 날 수 있어요.';
const KST = 9 * 3600;
const ymdK = (t) => new Date((t + KST) * 1000).toISOString().slice(0, 10);
const mdK = (t) => { const d = new Date((t + KST) * 1000); return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`; };
const p1 = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

/** Same-exposure baseline over paper points (avg invested share x benchmark daily moves, rest cash 0%). */
export function paperRiskMatched(pts) {
  if (!pts?.length) return 0;
  const exp = pts.reduce((a, p) => a + (p.equity > 0 ? Math.min(1, (p.invested || 0) / p.equity) : 0), 0) / pts.length;
  let rm = 1;
  for (let i = 1; i < pts.length; i++) if (pts[i - 1].bench > 0) rm *= 1 + exp * (pts[i].bench / pts[i - 1].bench - 1);
  return Math.round((rm - 1) * 10000) / 10000;
}

/** Next weekly check (KST Monday 08:40 by default) strictly after `now`. */
export function nextWeeklyCheck(now, w = PRINCIPLES.weeklyReport) {
  const k = new Date((now + KST) * 1000);
  const base = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) / 1000; // KST midnight as UTC label
  for (let i = 0; i <= 7; i++) {
    const day = base + i * DAY;
    const at = day - KST + (w.kstHour * 60 + w.kstMin) * 60;
    if (new Date(day * 1000).getUTCDay() === w.dow && at > now) return at;
  }
  return base + 7 * DAY - KST;
}

/** Why a strategy is not a candidate at all (null = it is a candidate type). */
export function exclusion(f, P = PRINCIPLES) {
  if (f.benchmarkOnly) return '비교 기준선';
  if (f.closed) return '종료된 장부(구성원 변경)';
  if (f.growthCandidate && !P.allowGrowth) return '공격 장부 전용(안전 장부 원칙 밖)';
  if (f.simulationOnly && P.allowSimulation) return f.stage === 'retired' ? '새 버전으로 대체됨' : null; // 공격 장부: 시뮬레이션도 후보(연결 대상은 아님)
  if (f.simulationOnly) return '시뮬레이션 전용(선물·레버리지)';
  if (f.sleeve && !P.allowSleeves.includes(f.sleeve)) return '고위험 슬롯(원칙상 기본 제외)';
  if (f.noBacktest) return '과거 검증 불가(비교용)';
  if (f.researchOnly) return '연구·비교용 장부';
  if (f.stage === 'retired') return '새 버전으로 대체됨';
  return null;
}

/**
 * Pre-registered selection checks for one candidate. Texts here may use technical terms (shown only in 'details').
 * f = {id, name, market, stage, bt:{dsrLab, sharpe, mdd}|null, paper:{startT, days, rebalances, ret, rmRet, mdd, halted}|null}
 */
export function selectionChecks(f, P = PRINCIPLES) {
  const s = P.select, p = f.paper, ddLim = s.maxPaperDd[f.market] ?? 0.10;
  const btOk = !['backtest', 'bt_failed', 'benchmark', 'retired'].includes(f.stage);
  return [
    { key: 'bt', ok: btOk, text: '과거 자료 검증 통과(보존 구간·비용 2배·위험 맞춤 기준선·가족 시도 수 보정)' },
    f.simulationOnly
      ? { key: 'ops', ok: true, text: '시뮬레이션 장부: 운영 점검 대상 아님(모의 비교만, 실제 돈 연결 대상이 될 수 없음)' }
      : { key: 'ops', ok: f.stage === 'live_candidate', text: '운영 점검 통과(모의 장부가 백테스트와 똑같이 움직임)' },
    { key: 'reb', ok: (p?.rebalances ?? 0) >= s.minRebalances, text: `처음 보는 자료에서 실제 조정 ${p?.rebalances ?? 0}/${s.minRebalances}회` },
    { key: 'rm', ok: !s.beatRiskMatchedPaper || (p != null && p.ret >= p.rmRet), text: p ? `모의 수익 ${p1(p.ret)} ≥ 같은 투자비율 기준 ${p1(p.rmRet)}` : '모의 기록 없음' },
    { key: 'dsr', ok: (f.bt?.dsrLab ?? 0) >= s.minLabDsr, text: `연구실 전체 시도 수 보정 실력 확률 ${f.bt?.dsrLab != null ? Math.round(f.bt.dsrLab * 100) + '%' : '-'} (≥ ${Math.round(s.minLabDsr * 100)}%)` },
    { key: 'dd', ok: p != null && p.mdd <= ddLim + 1e-12 && !p.halted, text: p ? `모의 최대 낙폭 ${p1(p.mdd)} (한도 ${p1(ddLim)})${p.halted ? ' · 위험 한도로 멈춤' : ''}` : '모의 기록 없음' },
  ];
}

/** Leverage: computed from the drawdown limit, then capped by the user's principles (default 1x, max 1x). */
export function autoLeverage(f, P = PRINCIPLES) {
  const lim = P.select.maxPaperDd[f.market] ?? 0.10;
  const worst = Math.max(f.bt?.mdd || 0, f.paper?.mdd || 0);
  const calc = worst > 0 ? Math.max(1, Math.floor(lim / (P.leverage.safety * worst))) : 1;
  if (P.leverage.max <= 1) return { leverage: Math.min(Math.max(P.leverage.default, 1), P.leverage.max, calc), calc };
  // 공격 장부: 낙폭 한도와 변동성 목표 둘 다 넘지 않는 가장 큰 배수(0.5 단위 내림, 최대 P.leverage.max). 숫자가 없으면 1배.
  const step = P.leverage.step || 0.5;
  const byDd = worst > 0 ? lim / (P.leverage.safety * worst) : 1;
  const vol = f.paper?.vol || f.bt?.vol || 0;
  const byVol = vol > 0 && P.leverage.volTarget?.[f.market] ? P.leverage.volTarget[f.market] / vol : Infinity;
  const lev = Math.max(1, Math.min(P.leverage.max, Math.floor(Math.min(byDd, byVol) / step + 1e-9) * step));
  return { leverage: f.dynamicLeverage ? 1 : lev, calc: lev, byDd: Math.round(byDd * 100) / 100, byVol: Number.isFinite(byVol) ? Math.round(byVol * 100) / 100 : null, own: !!f.dynamicLeverage };
}

/**
 * @param facts per-strategy facts (see selectionChecks) + flags {benchmarkOnly, researchOnly, simulationOnly, sleeve, noBacktest, cadence}
 * @param prev previous decision (for automatic replacement records)
 */
export function decide(facts, { now, prev = null, P = PRINCIPLES } = {}) {
  const cands = facts.filter((f) => !exclusion(f, P));
  const rows = cands.map((f) => {
    const checks = selectionChecks(f, P);
    return { f, checks, passed: checks.filter((c) => c.ok).length, ok: checks.every((c) => c.ok) };
  });
  const eligible = rows.filter((r) => r.ok).sort((a, b) => (b.f.bt?.sharpe ?? 0) - (a.f.bt?.sharpe ?? 0));
  const selected = [];
  for (const r of eligible) {
    if (selected.length >= P.select.maxSelected) break;
    if (selected.some((x) => x.market === r.f.market)) continue; // 국내 1 + 코인 1
    const lev = autoLeverage(r.f, P);
    selected.push({ id: r.f.id, name: r.f.name, market: r.f.market, startKrw: P.startKrw[r.f.market] || 20_000, leverage: lev.leverage, leverageCalc: lev.calc,
      ...(P.book === 'growth' ? { simOnly: !!r.f.simulationOnly, ownLeverage: !!lev.own, paperRet: r.f.paper?.ret ?? null, paperMdd: r.f.paper?.mdd ?? null } : { paperRet: r.f.paper?.ret ?? null, paperMdd: r.f.paper?.mdd ?? null }),
      why: `미리 정한 기준 ${r.checks.length}개를 모두 통과, 통과한 전략 중 과거 검증 위험 대비 수익이 가장 높음` });
  }
  const starts = facts.map((f) => f.paper?.startT).filter(Boolean);
  const freshDays = starts.length ? Math.max(1, Math.round((now - Math.min(...starts)) / DAY)) : 0;
  const next = nextWeeklyCheck(now, P.weeklyReport);
  // closest candidate to passing (for a plain-language reason and an honest earliest date)
  const nearest = [...rows].sort((a, b) => b.passed - a.passed || (b.f.paper?.rebalances ?? 0) - (a.f.paper?.rebalances ?? 0))[0] || null;
  let earliest = null;
  if (nearest && !nearest.ok && nearest.checks.find((c) => c.key === 'bt')?.ok) {
    const p = nearest.f.paper;
    const need = P.select.minRebalances - (p?.rebalances ?? 0);
    if (need <= 0) earliest = now;
    else if (p?.rebalances > 0 && p.days > 0) earliest = now + Math.ceil((need * p.days) / p.rebalances) * DAY;
  }
  const reasons = [];
  let headline, connect, verdict;
  if (selected.length) {
    verdict = 'ready';
    const total = selected.reduce((a, s) => a + s.startKrw, 0);
    headline = `${selected.map((s) => s.name.replace(/\s*\(.*\)$/, '')).join(', ')} 전략이 기준을 통과했어요. 소액(${Math.round(total / 10000 * 10) / 10}만 원)으로 시작해도 되는 단계예요.`;
    // 2026-11-23: 권유처럼 읽히지 않게 — 실제 주문 기능은 없고, 실거래 기준 문서(주문 단위·손실 한도 등)를 한 번 더 확인해야 연결
    connect = { state: 'ok', text: `실제 돈 연결: 1차 기준을 넘었어요. 실제 주문 기능은 아직 없고, 주문 단위·손실 한도 같은 실거래 기준을 한 번 더 확인한 뒤에만 연결해요 (전략당 ${selected.map((s) => `${s.startKrw / 10000}만 원`).join('·')}부터, 레버리지 없이 1배).` };
    reasons.push(`처음 보는 자료로 ${freshDays}일 동안 미리 정한 기준을 모두 넘었어요.`);
    reasons.push('기준에서 떨어지면 시스템이 자동으로 빼고 현금으로 쉬어요.');
  } else {
    verdict = 'not_ready';
    headline = '지금은 실제 돈을 넣을 단계가 아니에요.';
    connect = { state: 'not_yet', text: '실제 돈 연결: 아직 아니에요.' };
    reasons.push(`처음 보는 자료로 모의 기록 ${freshDays}일째예요.`);
    reasons.push(`기준을 통과한 전략: ${eligible.length}개.`);
    if (!nearest || !nearest.checks.find((c) => c.key === 'bt')?.ok) reasons.push('과거 자료 검증을 넘은 전략부터 아직 없어요.');
    else {
      const reb = nearest.checks.find((c) => c.key === 'reb');
      const n = nearest.f.paper?.rebalances ?? 0;
      reasons.push(reb.ok ? `가장 가까운 전략도 아직 다른 기준이 남아 있어요.` : `가장 가까운 전략도 실제로 사고판 횟수가 ${n}/${P.select.minRebalances}번이에요.`);
    }
  }
  // automatic replacement record
  const prevIds = new Set((prev?.selected || []).map((s) => s.id));
  const curIds = new Set(selected.map((s) => s.id));
  const changes = [];
  for (const s of selected) if (!prevIds.has(s.id)) changes.push({ t: now, kind: 'add', id: s.id, text: `${s.name}: 기준을 모두 통과해 자동으로 선발됨` });
  for (const s of prev?.selected || []) if (!curIds.has(s.id)) {
    const r = rows.find((x) => x.f.id === s.id);
    const fail = r ? r.checks.filter((c) => !c.ok).map((c) => c.text).join(', ') : '연구·비교용으로 바뀌었거나 사라짐';
    changes.push({ t: now, kind: 'remove', id: s.id, text: `${s.name}: 기준에서 떨어져 자동으로 빠짐 (${fail}) → 그 몫은 현금으로 쉼` });
  }
  return {
    at: now, verdict, headline, reasons, connect, disclaimer: DISCLAIMER,
    nextCheck: ymdK(next), nextCheckText: mdK(next), earliest: earliest ? ymdK(earliest) : null, earliestText: earliest ? mdK(earliest) : null,
    freshDays, passedCount: eligible.length, selected, book: P.book || 'safe',
    nearest: nearest ? { id: nearest.f.id, name: nearest.f.name, passed: nearest.passed, total: nearest.checks.length, paperRet: nearest.f.paper?.ret ?? null, paperMdd: nearest.f.paper?.mdd ?? null, rebalances: nearest.f.paper?.rebalances ?? 0 } : null,
    leveragePolicy: `레버리지: 원칙(손해 최소)에 따라 1배 고정. 낙폭 한도로 계산한 허용치는 참고로만 기록.`,
    candidates: rows.sort((a, b) => b.passed - a.passed).slice(0, 8).map((r) => ({ id: r.f.id, name: r.f.name, market: r.f.market, passed: r.passed, total: r.checks.length, checks: r.checks.map(({ ok, text }) => ({ ok, text })) })),
    excluded: facts.filter((f) => exclusion(f, P)).map((f) => ({ id: f.id, name: f.name, why: exclusion(f, P) })),
    changes,
    criteria: [
      `처음 보는 자료(모의)에서 실제 조정 ${P.select.minRebalances}회 이상`,
      '모의 수익이 같은 투자비율 기준 이상',
      `연구실 전체 시도 수로 보정한 실력 확률 ${Math.round(P.select.minLabDsr * 100)}% 이상`,
      `모의 최대 낙폭 국내 ${p1(P.select.maxPaperDd.krx)} · 코인 ${p1(P.select.maxPaperDd.crypto)} 이하`,
      '과거 자료 검증 + 운영 점검 통과, 연구·비교·시뮬레이션·고위험 장부 제외',
      '레버리지 1배(원칙), 국내 1개 + 코인 1개까지, 기준에서 떨어지면 자동 제외',
    ],
  };
}

/** Short weekly Telegram text (plain words only, no jargon). */
export function weeklyText(d) {
  const lines = [`📌 이번 주 결론: ${d.headline}`, ...d.reasons.map((r) => `· ${r}`), d.connect.text];
  if (d.verdict === 'not_ready') lines.push(`다음 점검: ${d.nextCheckText}${d.earliestText ? ` (빨라도 ${d.earliestText}쯤)` : ''}`);
  for (const c of d.changes || []) lines.push(`· ${c.text}`);
  lines.push(`※ ${d.disclaimer} 지금은 가상 돈으로만 시험 중이에요.`);
  return lines.join('\n');
}

/** True when the weekly report slot (Monday 08:40 KST) has come since the last one. */
export function weeklyDue(now, lastAt, P = PRINCIPLES) {
  const k = new Date((now + KST) * 1000);
  if (k.getUTCDay() !== P.weeklyReport.dow) return false;
  if (k.getUTCHours() * 60 + k.getUTCMinutes() < P.weeklyReport.kstHour * 60 + P.weeklyReport.kstMin) return false;
  return !lastAt || now - lastAt > 2 * DAY;
}


// ---------------- 안전 장부 / 공격 장부 (2026-11-18 밤) ----------------
const short = (name) => String(name || '').replace(/\s*\(.*\)$/, '');
const perDd = (x) => (x && x.paperRet != null ? x.paperRet / Math.max(x.paperMdd || 0, 0.01) : -Infinity);
const avg = (xs, k) => (xs.length ? xs.reduce((a, x) => a + (x[k] ?? 0), 0) / xs.length : null);

/**
 * 어느 장부를 권할지 숫자로 정한다(규칙은 principles.RECOMMEND, 결과를 보기 전에 고정).
 * safe / growth = decide() 결과. 반환 { book: 'none'|'safe'|'growth', text, numbers }.
 */
export function chooseBook(safe, growth, R = RECOMMEND) {
  // 공격 장부가 안전 장부와 똑같은 전략을 뽑은 경우는 '공격 장부의 증거'로 치지 않는다(같은 전략을 두 번 세지 않음)
  const safeIds = new Set(safe.selected.map((x) => x.id));
  const gReal = growth.selected.filter((x) => !x.simOnly && !safeIds.has(x.id));
  const gSim = growth.selected.filter((x) => x.simOnly);
  const numbers = {
    safe: { passed: safe.passedCount, ret: avg(safe.selected, 'paperRet'), mdd: avg(safe.selected, 'paperMdd') },
    growth: { passed: growth.passedCount, ret: avg(growth.selected, 'paperRet'), mdd: avg(growth.selected, 'paperMdd'), simOnly: gSim.length },
  };
  if (!safe.selected.length && !growth.selected.length) return { book: 'none', text: '안전 장부·공격 장부 모두 아직 기준을 넘은 전략이 없어요(둘 다 가상 돈으로 계속 시험 중).', numbers };
  if (!gReal.length) {
    if (!safe.selected.length) return { book: 'none', text: '공격 장부에서 선물 시뮬레이션만 기준을 넘었어요. 시뮬레이션은 실제 돈 연결 대상이 아니라서 계속 가상 돈으로만 봐요.', numbers };
    return { book: 'safe', text: `안전 장부를 따라요${gSim.length ? ' (공격 장부는 선물 시뮬레이션만 통과해 비교용)' : ' (공격 장부에만 있는 전략은 아직 통과 0개)'}.`, numbers };
  }
  const sRet = avg(safe.selected, 'paperRet') ?? 0, gRet = avg(gReal, 'paperRet') ?? 0;
  const sPer = safe.selected.length ? Math.max(...safe.selected.map(perDd)) : 0, gPer = Math.max(...gReal.map(perDd));
  const beats = (!R.growthMustBeatSafeReturn || gRet > sRet) && (!R.growthReturnPerDrawdownAtLeastSafe || gPer >= sPer);
  const p = (x) => `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`;
  if (beats) return { book: 'growth', text: `공격 장부 몫을 함께 써도 되는 단계예요: 가상 돈 기록에서 공격 장부 ${p(gRet)}가 안전 장부 ${p(sRet)}보다 높고, 잃은 폭에 비한 수익도 같거나 나아요. (사람별 공격 몫 상한 안에서만)`, numbers };
  return { book: safe.selected.length ? 'safe' : 'none', text: `공격 장부도 기준은 넘었지만 가상 돈 기록이 안전 장부보다 낫지 않아요(공격 ${p(gRet)} · 안전 ${p(sRet)}). ${safe.selected.length ? '안전 장부를 따라요.' : '아직은 기다려요.'}`, numbers };
}

const bookSummary = (d, label) => ({
  key: d.book, label, verdict: d.verdict, passedCount: d.passedCount, selected: d.selected, nearest: d.nearest,
  candidates: d.candidates, excluded: d.excluded, criteria: d.criteria, leveragePolicy: d.leveragePolicy,
});

/**
 * 두 장부를 같은 사실(facts)로 각각 판정하고 하나의 결론으로 묶는다. 맨 위 필드는 안전 장부 기준(예전 화면·알림과 호환),
 * books.safe / books.growth 에 장부별 내용, recommend 에 자동 선택 결과, criteriaVersion 에 기준 버전.
 */
export function decideAll(facts, { now, prev = null, criteria = null } = {}) {
  const safe = decide(facts, { now, prev, P: BOOKS.safe.P });
  const growth = decide(facts, { now, prev: prev?.books?.growth ? { selected: prev.books.growth.selected } : null, P: BOOKS.growth.P });
  growth.leveragePolicy = '배수: 낙폭 한도와 변동성 목표를 둘 다 넘지 않는 가장 큰 값을 6시간마다 다시 계산(0.5 단위, 최대 3배). 한도를 넘으면 자동으로 줄이거나 뺌. 가상 돈으로만.';
  growth.criteria = growth.criteria.map((c) => (c.startsWith('레버리지 1배') ? '배수 자동 조절(최대 3배, 모의), 국내 1개 + 코인 1개까지, 기준에서 떨어지면 자동 제외' : c.replace('연구·비교·시뮬레이션·고위험 장부 제외', '연구·비교 장부 제외(고위험 슬롯·선물 시뮬레이션은 후보)')));
  const rec = chooseBook(safe, growth);
  const out = { ...safe };
  out.reasons = [...safe.reasons, rec.text];
  if (rec.book === 'growth' && safe.verdict !== 'ready') {
    // 안전 장부는 아직인데 공격 장부(현물)가 통과하고 숫자도 나은 경우: 결론은 '소액으로 시작 가능'이되 공격 장부임을 분명히 말한다.
    const g = growth.selected.filter((x) => !x.simOnly);
    for (const x of g) x.leverage = 1; // 실제 돈 연결 권고는 항상 빌린 돈 없이(1배). 계산된 배수는 가상 장부에서만 쓴다.
    out.verdict = 'ready';
    // 2026-11-23: 공격 장부 통과는 배수를 쓴 가상 기록 → 1배로 다시 확인하기 전에는 '시작해도 된다'고 말하지 않는다(선발 결과는 그대로).
    out.headline = `${g.map((x) => short(x.name)).join(', ')} 전략(공격 장부)이 가상 돈 기준을 통과했어요. 배수를 쓴 기록이라, 빌린 돈 없이 1배로 다시 확인한 뒤에만 실제 돈을 생각해요.`;
    out.connect = { state: 'ok', text: `실제 돈 연결: 아직 아니에요. 공격 장부 통과는 1차 결과라, 빌린 돈 없이 1배로 다시 확인하고 실거래 기준(주문 단위·손실 한도)을 넘어야 해요 (공격 장부, 전략당 ${g.map((x) => `${x.startKrw / 10000}만 원`).join('·')}부터).` };
  }
  out.changes = [...safe.changes, ...growth.changes.map((c) => ({ ...c, book: 'growth', text: `[공격 장부] ${c.text}` }))];
  out.books = { safe: bookSummary(safe, BOOKS.safe.label), growth: bookSummary(growth, BOOKS.growth.label) };
  out.recommend = rec;
  out.criteriaVersion = criteria?.version ?? CRITERIA_VERSION;
  out.criteriaHash = criteria?.hash ?? null;
  return out;
}
