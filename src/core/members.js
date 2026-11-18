// 가족 구성원(누구 몫의 가상 장부를 굴릴지)과 금액을 화면에서 바꾸기 위한 순수 로직. I/O 없음.
// 설계 원칙: 이미 쌓인 모의 기록과 재생 일치를 절대 깨지 않는다.
//   - 장부 하나의 시작 금액·규칙은 한 번 정하면 바뀌지 않는다.
//   - 금액이나 성향을 바꾸면 그 사람의 '새 장부'(버전 +1)가 다음 봉부터 새 금액으로 시작하고,
//     이전 장부는 '종료'로 표시되어 더 진행하지 않되 기록은 그대로 남는다(변경 시점부터 적용).
//   - 이름만 바꾸는 것은 표시만 바뀐다(장부는 그대로).
//   - 구성원을 빼면 그 장부는 종료된다(기록 유지). 다시 넣으면 새 장부.
// 저장 위치: kv 'family:members' = { v, members: [...], log: [...] }. D1 스키마 변경 없음.
import { PRINCIPLES } from './principles.js';

export const MEMBER_LIMITS = Object.freeze({ maxActive: 6, maxBooks: 24, minKrw: 10_000, maxKrw: 100_000_000, stepKrw: 10_000, nameMax: 12, logMax: 60 });

export class MemberError extends Error {}

/** 처음 상태: PC 봇에서 옮긴 두 장부(본인 10만 원, 어머니 100만 원)가 그대로 1번 버전. */
export function defaultMembers() {
  return {
    v: 1,
    members: [
      { key: 'self', label: '본인', budgetKrw: 100_000, profile: 'active', rev: 1, active: true, since: null, books: [{ id: 'family_self_v1', rev: 1, budgetKrw: 100_000, profile: 'active', from: null, to: null }] },
      { key: 'mother', label: '어머니', budgetKrw: 1_000_000, profile: 'careful', rev: 1, active: true, since: null, books: [{ id: 'family_mother_v1', rev: 1, budgetKrw: 1_000_000, profile: 'careful', from: null, to: null }] },
    ],
    log: [],
  };
}

export function loadMembers(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.members)) return defaultMembers();
  return raw;
}

const cleanLabel = (x) => String(x ?? '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').trim().slice(0, MEMBER_LIMITS.nameMax);
function cleanBudget(x) {
  const n = Math.round(Number(x));
  if (!Number.isFinite(n)) throw new MemberError('금액은 숫자로 넣어 주세요.');
  if (n < MEMBER_LIMITS.minKrw || n > MEMBER_LIMITS.maxKrw) throw new MemberError(`금액은 ${MEMBER_LIMITS.minKrw / 10000}만 원부터 ${MEMBER_LIMITS.maxKrw / 100000000}억 원까지예요.`);
  if (n % MEMBER_LIMITS.stepKrw) throw new MemberError('금액은 만 원 단위로 넣어 주세요.');
  return n;
}
const cleanProfile = (x, fallback = 'careful') => (Object.hasOwn(PRINCIPLES.memberProfiles, String(x)) ? String(x) : fallback);
const won = (n) => `${(n / 10000).toLocaleString('ko-KR')}만 원`;
const bookId = (key, rev) => `family_${key}_v${rev}`;
const clone = (s) => JSON.parse(JSON.stringify(s));

/**
 * 구성원 변경 한 건을 적용한다. 반환: { state, entry } (entry = 변경 이력 한 줄). 잘못된 입력은 MemberError.
 * op: { type: 'add', label, budgetKrw, profile? } | { type: 'update', key, label?, budgetKrw?, profile? } | { type: 'remove', key }
 */
export function applyMemberOp(state0, op, now) {
  const state = clone(loadMembers(state0));
  const active = state.members.filter((m) => m.active);
  const books = state.members.reduce((a, m) => a + m.books.length, 0);
  let entry;
  if (op?.type === 'add') {
    const label = cleanLabel(op.label);
    if (!label) throw new MemberError('이름을 넣어 주세요.');
    if (active.some((m) => m.label === label)) throw new MemberError('같은 이름이 이미 있어요.');
    if (active.length >= MEMBER_LIMITS.maxActive) throw new MemberError(`구성원은 ${MEMBER_LIMITS.maxActive}명까지예요.`);
    if (books >= MEMBER_LIMITS.maxBooks) throw new MemberError('장부 기록이 너무 많아요. 더 만들 수 없어요.');
    const budgetKrw = cleanBudget(op.budgetKrw);
    const profile = cleanProfile(op.profile);
    let n = state.members.length + 1;
    while (state.members.some((m) => m.key === `m${n}`)) n++;
    const key = `m${n}`;
    state.members.push({ key, label, budgetKrw, profile, rev: 1, active: true, since: now, books: [{ id: bookId(key, 1), rev: 1, budgetKrw, profile, from: now, to: null }] });
    entry = { t: now, kind: 'add', key, text: `${label} 추가: 가상 ${won(budgetKrw)} (${PRINCIPLES.memberProfiles[profile].label}) → 다음 거래일부터 새 장부 시작` };
  } else if (op?.type === 'update') {
    const m = state.members.find((x) => x.key === op.key && x.active);
    if (!m) throw new MemberError('그 구성원을 찾지 못했어요.');
    const parts = [];
    if (op.label != null) {
      const label = cleanLabel(op.label);
      if (!label) throw new MemberError('이름을 넣어 주세요.');
      if (label !== m.label) {
        if (active.some((x) => x !== m && x.label === label)) throw new MemberError('같은 이름이 이미 있어요.');
        parts.push(`이름 ${m.label} → ${label}`);
        m.label = label;
      }
    }
    const budgetKrw = op.budgetKrw != null ? cleanBudget(op.budgetKrw) : m.budgetKrw;
    const profile = op.profile != null ? cleanProfile(op.profile, m.profile) : m.profile;
    if (budgetKrw !== m.budgetKrw || profile !== m.profile) {
      if (books >= MEMBER_LIMITS.maxBooks) throw new MemberError('장부 기록이 너무 많아요. 더 만들 수 없어요.');
      if (budgetKrw !== m.budgetKrw) parts.push(`금액 ${won(m.budgetKrw)} → ${won(budgetKrw)}`);
      if (profile !== m.profile) parts.push(`성향 ${PRINCIPLES.memberProfiles[m.profile].label} → ${PRINCIPLES.memberProfiles[profile].label}`);
      const cur = m.books.find((b) => b.to == null);
      if (cur) cur.to = now;
      m.rev += 1; m.budgetKrw = budgetKrw; m.profile = profile;
      m.books.push({ id: bookId(m.key, m.rev), rev: m.rev, budgetKrw, profile, from: now, to: null });
      parts.push('이전 장부는 기록으로 남기고, 다음 거래일부터 새 장부로 시작');
    }
    if (!parts.length) throw new MemberError('바뀐 내용이 없어요.');
    entry = { t: now, kind: 'update', key: m.key, text: `${m.label}: ${parts.join(' · ')}` };
  } else if (op?.type === 'remove') {
    const m = state.members.find((x) => x.key === op.key && x.active);
    if (!m) throw new MemberError('그 구성원을 찾지 못했어요.');
    if (active.length <= 1) throw new MemberError('마지막 한 명은 뺄 수 없어요.');
    m.active = false;
    const cur = m.books.find((b) => b.to == null);
    if (cur) cur.to = now;
    entry = { t: now, kind: 'remove', key: m.key, text: `${m.label} 빼기: 장부를 종료(기록은 그대로 남음)` };
  } else throw new MemberError('알 수 없는 요청이에요.');
  state.log = [...(state.log || []), entry].slice(-MEMBER_LIMITS.logMax);
  return { state, entry };
}

/** 장부 id → { key, label, budgetKrw, profile, closed, rev } (가족 장부가 아니면 undefined). */
export function memberBookIndex(state0) {
  const out = {};
  for (const m of loadMembers(state0).members) for (const b of m.books) out[b.id] = { key: m.key, label: m.label, budgetKrw: b.budgetKrw, profile: b.profile, closed: b.to != null, rev: b.rev, from: b.from, to: b.to };
  return out;
}

/** 화면용 요약(현재 구성원 + 지난 장부). */
export function membersView(state0) {
  const s = loadMembers(state0);
  return {
    limits: MEMBER_LIMITS,
    profiles: Object.fromEntries(Object.entries(PRINCIPLES.memberProfiles).map(([k, v]) => [k, { label: v.label, maxTotal: v.maxTotal, drawdown: v.drawdown, growthMaxShare: v.growthMaxShare }])),
    members: s.members.filter((m) => m.active).map((m) => ({ key: m.key, label: m.label, budgetKrw: m.budgetKrw, profile: m.profile, bookId: m.books.find((b) => b.to == null)?.id || null, since: m.books.find((b) => b.to == null)?.from ?? null })),
    past: s.members.flatMap((m) => m.books.filter((b) => b.to != null).map((b) => ({ label: m.label, bookId: b.id, budgetKrw: b.budgetKrw, from: b.from, to: b.to }))),
    log: [...(s.log || [])].reverse(),
  };
}
