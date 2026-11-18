// '지금 적용 중인 기준'을 쉬운 말로 보여 주고, 기준이 바뀌면 전·후 값을 변경 이력으로 남기기 위한 순수 로직. I/O 없음.
// 기준이 바뀌면 어떻게 되나(규칙):
//   1) 바뀐 기준은 '다음 평가부터' 적용한다. 이미 내린 결정 기록과 모의 장부(체결 기록)는 고치지 않는다.
//   2) 모든 자동 결정에는 그때의 기준 버전·지문(hash)이 함께 저장된다 → 어떤 기준으로 내린 결정인지 나중에 알 수 있다.
//   3) 코드의 기준 버전(CRITERIA_VERSION)이 오르거나 실행 설정(GATES_JSON)으로 값이 달라지면 워커가 스스로 알아채
//      kv 'criteria:log'에 '무엇이 얼마에서 얼마로'를 남기고 알림(기록 탭·텔레그램)을 보낸다.
//   4) 결과가 나쁘다고 같은 기간에 기준을 느슨하게 바꾸는 것은 하지 않는다(원칙 P6). 바꾸면 이력에 남으므로 숨길 수 없다.
import { PRINCIPLES, GROWTH_PRINCIPLES, RECOMMEND, CRITERIA_VERSION, CRITERIA_HISTORY } from './principles.js';
import { GATE_DEFAULTS } from './lifecycle.js';

const pc = (x) => `${Math.round(x * 1000) / 10}%`;
const man = (n) => `${(n / 10000).toLocaleString('ko-KR')}만 원`;

/** 판단에 쓰이는 숫자만 모은 평평한 객체(지문 계산·비교용). */
export function criteriaValues(gates = GATE_DEFAULTS) {
  const S = PRINCIPLES.select, G = GROWTH_PRINCIPLES, b = gates.backtest, pp = gates.paper;
  const v = {
    'safe.minRebalances': S.minRebalances, 'safe.minLabDsr': S.minLabDsr, 'safe.maxPaperDd.krx': S.maxPaperDd.krx, 'safe.maxPaperDd.crypto': S.maxPaperDd.crypto,
    'safe.maxSelected': S.maxSelected, 'safe.leverage.max': PRINCIPLES.leverage.max, 'safe.beatRiskMatched': S.beatRiskMatchedPaper,
    'growth.maxPaperDd.krx': G.select.maxPaperDd.krx, 'growth.maxPaperDd.crypto': G.select.maxPaperDd.crypto, 'growth.leverage.max': G.leverage.max,
    'growth.leverage.safety': G.leverage.safety, 'growth.volTarget.krx': G.leverage.volTarget.krx, 'growth.volTarget.crypto': G.leverage.volTarget.crypto,
    'recommend.growthMustBeatSafeReturn': RECOMMEND.growthMustBeatSafeReturn, 'recommend.growthReturnPerDrawdownAtLeastSafe': RECOMMEND.growthReturnPerDrawdownAtLeastSafe,
    'start.krx': PRINCIPLES.startKrw.krx, 'start.crypto': PRINCIPLES.startKrw.crypto,
    'bt.minSharpe': b.minSharpe, 'bt.minDeflatedSharpe': b.minDeflatedSharpe, 'bt.maxMddVsBench': b.maxMddVsBench, 'bt.mustBeProfitable2x': b.mustBeProfitable2x, 'bt.mustBeatRiskMatched': b.mustBeatRiskMatched,
    'paper.maxMdd.krx': pp.maxMdd.krx, 'paper.maxMdd.crypto': pp.maxMdd.crypto, 'paper.requireSignalAgreement': pp.requireSignalAgreement,
  };
  for (const [k, p] of Object.entries(PRINCIPLES.memberProfiles)) {
    v[`member.${k}.maxTotal`] = p.maxTotal; v[`member.${k}.drawdown`] = p.drawdown; v[`member.${k}.growthMaxShare`] = p.growthMaxShare;
  }
  return v;
}

/** 짧고 안정적인 지문(FNV-1a 32비트, 16진). 암호용이 아니라 '값이 달라졌는지'만 본다. */
export function hashOf(obj) {
  const s = JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const LABELS = {
  'safe.minRebalances': '안전 장부: 실제로 사고판 횟수(최소)', 'safe.minLabDsr': '안전 장부: 운이 아닐 확률(최소)', 'safe.maxPaperDd.krx': '안전 장부: 국내 최대 손실 폭', 'safe.maxPaperDd.crypto': '안전 장부: 코인 최대 손실 폭',
  'safe.maxSelected': '동시에 쓰는 전략 수', 'safe.leverage.max': '안전 장부: 배수 상한', 'growth.maxPaperDd.krx': '공격 장부: 국내 최대 손실 폭', 'growth.maxPaperDd.crypto': '공격 장부: 코인 최대 손실 폭',
  'growth.leverage.max': '공격 장부: 배수 상한', 'growth.volTarget.krx': '공격 장부: 국내 목표 흔들림(연)', 'growth.volTarget.crypto': '공격 장부: 코인 목표 흔들림(연)', 'start.krx': '처음 연결 금액(국내)', 'start.crypto': '처음 연결 금액(코인)',
};
/** 두 값 묶음의 차이를 사람이 읽을 줄로. */
export function diffCriteria(prev = {}, cur = {}) {
  const out = [];
  for (const k of [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort()) {
    if (JSON.stringify(prev[k]) === JSON.stringify(cur[k])) continue;
    const name = LABELS[k] || k;
    out.push(prev[k] === undefined ? `${name}: 새로 생김 → ${cur[k]}` : cur[k] === undefined ? `${name}: 없어짐 (전 ${prev[k]})` : `${name}: ${prev[k]} → ${cur[k]}`);
  }
  return out;
}

/** 화면 '기준' 탭과 AI 질문 답변이 함께 쓰는 쉬운 말 설명. */
export function criteriaView(gates = GATE_DEFAULTS) {
  const values = criteriaValues(gates);
  const S = PRINCIPLES.select, G = GROWTH_PRINCIPLES;
  return {
    version: CRITERIA_VERSION, hash: hashOf(values), values,
    goal: PRINCIPLES.goal,
    plain: [
      { title: '누가 정하나요?', lines: ['어떤 전략을 쓸지, 얼마나 크게 할지, 언제 쉴지는 모두 시스템이 아래 기준으로 정해요.', '사용자가 정하는 것은 나중에 "실제 돈을 연결할지" 하나뿐이고, 그때도 화면이 "연결해도 되는 단계 / 아직 아니에요"를 먼저 말해요.', '지금은 전부 가상 돈이에요. 이 프로그램에는 실제 주문 기능이 없어요.'] },
      { title: '전략이 뽑히려면 (안전 장부 · 모두 만족)', lines: [
        '과거 자료 시험을 통과해야 해요(끝까지 안 본 구간에서도 벌고, 수수료를 2배로 쳐도 벌고, 같은 위험의 단순 보유보다 나아야 함).',
        '가상 장부가 시험 때와 똑같이 움직이는지 확인돼야 해요.',
        `처음 보는 시장에서 실제로 사고판 날이 ${S.minRebalances}번 이상이어야 해요.`,
        '가상 수익이 "같은 비율로 그냥 들고 있었을 때"보다 같거나 높아야 해요.',
        `여러 번 시도한 것을 감안해도 운이 아닐 확률이 ${pc(S.minLabDsr)} 이상이어야 해요.`,
        `가상 기록에서 가장 많이 잃은 폭이 국내 ${pc(S.maxPaperDd.krx)}, 코인 ${pc(S.maxPaperDd.crypto)} 이하여야 해요.`,
        `국내 1개 + 코인 1개까지만 뽑고, 기준에서 떨어지면 자동으로 빼고 그 몫은 현금으로 쉬어요.`,
      ] },
      { title: '안전 장부와 공격 장부', lines: [
        `안전 장부: 빌린 돈 없이 1배만. 손해를 덜 보는 것이 먼저예요.`,
        `공격 장부: 더 벌 기회를 노려요. 잃어도 되는 폭을 국내 ${pc(G.select.maxPaperDd.krx)}, 코인 ${pc(G.select.maxPaperDd.crypto)}까지 넓히고, 크기(배수)를 시스템이 자동으로 조절해요(최대 ${G.leverage.max}배, 가상 돈으로만).`,
        `배수는 "한도 ÷ (${G.leverage.safety} × 지금까지 가장 크게 잃은 폭)"과 "목표 흔들림 ÷ 최근 흔들림" 중 작은 쪽으로 정해요. 많이 흔들리거나 잃으면 저절로 줄어요.`,
        '두 장부 모두 가상 돈으로 계속 굴리고, 어느 쪽을 권할지는 숫자로 정해요: 공격 장부가 기준을 모두 넘고, 가상 수익이 안전 장부보다 높고, 잃은 폭에 비한 수익도 같거나 나을 때만 공격 장부를 권해요.',
        '선물(레버리지) 시뮬레이션은 비교용이에요. 통과해도 실제 돈 연결 대상이 되지 않아요.',
      ] },
      { title: '가족 구성원과 금액', lines: [
        '구성원 추가·빼기·이름·금액은 "가족" 탭에서 바꿀 수 있어요.',
        '금액을 바꾸면 그 사람의 새 장부가 다음 거래일부터 새 금액으로 시작해요. 이전 장부는 기록으로 남아요(지난 기록을 고치지 않아요).',
        ...Object.values(PRINCIPLES.memberProfiles).map((p) => `성향 "${p.label}": 투자 상한 ${pc(p.maxTotal)}(나머지 현금), 고점 대비 ${pc(p.drawdown)} 잃으면 전부 팔고 멈춤, 공격 장부 몫 상한 ${pc(p.growthMaxShare)}.`),
      ] },
      { title: '처음 실제 돈을 연결한다면', lines: [`전략당 국내 ${man(PRINCIPLES.startKrw.krx)}, 코인 ${man(PRINCIPLES.startKrw.crypto)}부터예요.`, '연결은 사용자가 "예"라고 할 때만, 별도 작업으로만 이뤄져요. 지금은 연결 기능 자체가 없어요.'] },
      { title: '기준이 바뀌면', lines: ['바뀐 기준은 다음 평가부터 적용하고, 이미 내린 결정과 가상 장부 기록은 고치지 않아요.', '모든 결정에는 그때의 기준 버전이 함께 저장돼요.', '무엇이 얼마에서 얼마로 바뀌었는지 아래 "변경 이력"에 자동으로 남아요.', '결과가 나쁘다고 같은 기간에 기준을 느슨하게 바꾸지 않아요.'] },
    ],
    history: CRITERIA_HISTORY,
  };
}

/**
 * 기준 변경 감지. prev = kv 'criteria:current' ({version, hash, values}) 또는 null.
 * 반환 { current, entry } — entry 는 바뀌었을 때만(처음 기록도 포함) 변경 이력 한 줄.
 */
export function criteriaChange(prev, gates, now) {
  const v = criteriaView(gates);
  const current = { version: v.version, hash: v.hash, values: v.values, at: prev?.hash === v.hash ? prev.at : now };
  if (prev?.hash === v.hash && prev?.version === v.version) return { current, entry: null };
  const changes = prev ? diffCriteria(prev.values, v.values) : [];
  const note = CRITERIA_HISTORY.find((h) => h.version === v.version)?.text || '';
  const entry = { t: now, version: v.version, hash: v.hash, from: prev ? { version: prev.version, hash: prev.hash } : null,
    text: prev ? `기준 v${prev.version} → v${v.version}${changes.length ? `: ${changes.slice(0, 12).join(' / ')}` : ' (값은 같고 설명만 바뀜)'}` : `기준 v${v.version} 기록 시작`, note };
  return { current, entry };
}
