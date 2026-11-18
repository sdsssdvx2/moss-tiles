// 사용자 원칙(2026-11-18 정리, 원문 출처: Download/Claude-작업결과/주식봇/사용자-원칙.md).
// 자동 결정(core/decision.js)의 기준은 모두 여기서 결과를 보기 전에 고정한다. 사용자에게 판단을 맡기지 않는다.
//   R1 "수익이 적어도 괜찮으니 손해는 최대한 안 보는 안정적인 수익" (소액: 본인 10만 원, 어머니 100만 원)
//   R2 "주식을 하나도 모른다. AI가 알아서 판단" → 사용자가 하는 결정은 '실제 돈을 연결할지 예/아니오' 하나뿐
//   리스크 규칙(RESEARCH-STRATEGY-KO.md 4장): 레버리지·선물·알트코인은 기본 금지, 코인 비중 상한, 계좌 낙폭 정지선
// 공격적인 설정(레버리지 2배 이상, 공격형 슬롯, 시뮬레이션 전용 장부)은 기본값으로 선발하지 않는다.

export const PRINCIPLES = Object.freeze({
  goal: '수익이 적어도 손해는 최대한 안 보는 안정적인 수익',
  accounts: Object.freeze({
    self: { label: '본인', budgetKrw: 100_000, cryptoMaxShare: 0.25, accountDdStop: 0.08 },
    mother: { label: '어머니', budgetKrw: 1_000_000, cryptoMaxShare: 0.10, accountDdStop: 0.05 },
  }),
  // 선발 기준 (모두 만족해야 '기준 통과')
  select: Object.freeze({
    minRebalances: 12,          // 처음 보는 자료(모의)에서 실제 조정(체결이 난 날) 12회 이상
    beatRiskMatchedPaper: true, // 모의 수익 ≥ 같은 투자비율 기준(평균 투자 비율만큼 지수, 나머지 현금)
    minLabDsr: 0.5,             // 연구실 전체 시도 수로 보정한 실력 확률 50% 이상 (운보다 나을 가능성이 더 큼)
    maxPaperDd: Object.freeze({ krx: 0.10, crypto: 0.15 }), // 모의 최대 낙폭 한도
    maxSelected: 2,             // 동시에 쓰는 전략 수 (국내 1 + 코인 1)
  }),
  leverage: Object.freeze({ default: 1, max: 1, safety: 1.5 }), // 원칙상 레버리지 금지 → 계산상 허용치는 참고로만 표시
  startKrw: Object.freeze({ krx: 30_000, crypto: 20_000 }),      // 처음 실제 돈을 연결할 때 전략당 금액(소액)
  book: 'safe',
  allowSleeves: Object.freeze([]),                               // 공격형 슬롯은 선발 대상 아님
  weeklyReport: Object.freeze({ dow: 1, kstHour: 8, kstMin: 40 }), // 매주 월요일 08:40 KST 텔레그램 결론
  // 가족 구성원 성향(화면에서 고르지 않으면 '조심'). 금액·이름은 화면에서 바꾸고, 한도는 시스템이 성향으로 정한다.
  memberProfiles: Object.freeze({
    careful: Object.freeze({ label: '조심', maxTotal: 0.25, maxAsset: 0.20, drawdown: 0.04, cryptoMaxShare: 0.10, accountDdStop: 0.05, growthMaxShare: 0.10 }),
    active: Object.freeze({ label: '조금 적극', maxTotal: 0.35, maxAsset: 0.35, drawdown: 0.06, cryptoMaxShare: 0.25, accountDdStop: 0.08, growthMaxShare: 0.30 }),
  }),
});

// 2026-11-18(밤) 사용자 요구: "손해 최소"만으로 수익이 너무 낮으면 실망 → 장부를 둘로 나눠 둘 다 가상 돈으로 굴린다.
//   안전 장부 = 위 원칙 그대로(1배 고정). 공격 장부 = 변동성 목표·낙폭 한도 안에서 배수를 시스템이 자동 조절(최대 3배, 모의).
//   어느 장부를 권할지는 아래 recommend 규칙(결과를 보기 전에 고정)으로 숫자가 정한다. 사용자에게 고르라고 하지 않는다.
export const GROWTH_PRINCIPLES = Object.freeze({
  ...PRINCIPLES,
  book: 'growth',
  goal: '낙폭 한도 안에서 수익을 더 노린다(모의). 한도를 넘으면 자동으로 줄이거나 쉰다',
  select: Object.freeze({ ...PRINCIPLES.select, maxPaperDd: Object.freeze({ krx: 0.20, crypto: 0.30 }) }),
  leverage: Object.freeze({ default: 1, max: 3, safety: 1.5, step: 0.5, volTarget: Object.freeze({ krx: 0.15, crypto: 0.40 }) }),
  allowSleeves: Object.freeze(['aggressive']),
  allowSimulation: true, // 선물·레버리지 시뮬레이션 장부도 후보(단, 실제 돈 연결 대상은 될 수 없음)
  allowGrowth: true,
});
export const BOOKS = Object.freeze({
  safe: Object.freeze({ key: 'safe', label: '안전 장부', P: PRINCIPLES }),
  growth: Object.freeze({ key: 'growth', label: '공격 장부', P: GROWTH_PRINCIPLES }),
});
// 공격 장부를 권하는 조건(모두 만족). 하나라도 아니면 안전 장부.
export const RECOMMEND = Object.freeze({
  growthMustBeatSafeReturn: true,   // 공격 장부 선발 전략의 모의 수익 > 안전 장부 선발 전략의 모의 수익(없으면 0)
  growthReturnPerDrawdownAtLeastSafe: true, // 수익 ÷ 최대 낙폭이 안전 장부 이상
  simulationNeverConnects: true,    // 선물 시뮬레이션만 통과한 경우 실제 돈 연결은 '아직 아님'
});

// 기준 버전. 숫자·규칙을 바꾸면 반드시 올리고 CRITERIA_HISTORY에 한 줄 추가한다(화면 '기준' 탭에 그대로 보임).
// 실행 중 설정(GATES_JSON 등)으로 값이 바뀌면 워커가 스스로 감지해 변경 이력(kv 'criteria:log')에 전·후 값을 남긴다.
export const CRITERIA_VERSION = 2;
export const CRITERIA_HISTORY = Object.freeze([
  { version: 1, date: '2026-11-18', text: '처음 정함: 손해 최소 원칙, 레버리지 1배 고정, 실제 조정 12회·같은 투자비율 기준·실력 확률 50%·낙폭 한도(국내 10%, 코인 15%).' },
  { version: 2, date: '2026-11-18', text: '안전 장부(그대로)와 공격 장부(낙폭 한도 국내 20%·코인 30%, 배수 자동 조절 최대 3배, 모의)를 나눠 둘 다 굴림. 어느 쪽을 권할지는 숫자로 자동 선택. 가족 구성원·금액을 화면에서 바꿀 수 있게 함(바꾼 시점부터 새 장부).' },
]);
