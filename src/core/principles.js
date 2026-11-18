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
  allowSleeves: Object.freeze([]),                               // 공격형 슬롯은 선발 대상 아님
  weeklyReport: Object.freeze({ dow: 1, kstHour: 8, kstMin: 40 }), // 매주 월요일 08:40 KST 텔레그램 결론
});
