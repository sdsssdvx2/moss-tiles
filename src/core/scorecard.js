// 주간 성과표 (2026-11-23, 계획서 2-8 끝난 기준 3 "전략별 모의 성과표가 매주 갱신됨").
// 매주 월요일 08:40 KST(주간 결론과 같은 때) 모든 가상 장부의 숫자를 한 번 찍어 12주치를 남긴다.
// 평가 기준이 아니다: 선발·결정에는 쓰지 않고 보여 주기만 한다(P6 — 기준 불변).
export const SCORECARD_WEEKS = 12;
const KST = 9 * 3600;
const ymd = (t) => new Date((t + KST) * 1000).toISOString().slice(0, 10);

/** 장부 하나의 줄. prevRow = 지난주 같은 장부 줄(없으면 이번 주 변화는 null). */
function rowOf(s, run, lc, prevRow) {
  const st = run.state;
  const eq = st.equity, init = st.initialCash;
  const book = s.benchmarkOnly ? 'bench' : s.profile ? 'family' : s.sleeve === 'aggressive' || s.simulationOnly ? 'growth' : s.researchOnly ? 'research' : 'safe';
  return {
    id: s.id, name: s.name, book,
    equity: Math.round(eq), ret: init > 0 ? eq / init - 1 : 0,
    bench: init > 0 ? st.bench / init - 1 : 0,
    weekRet: prevRow?.equity > 0 ? eq / prevRow.equity - 1 : null,
    stage: lc?.stage || null, label: lc?.label || '평가 대기', halted: !!st.halted,
  };
}

/** 이번 주 성과표 한 장. strategies = allStrategies(kv), runs = {id:run}, lc = lifecycleAll, prev = 지난 성과표(없으면 null). */
export function buildScorecard(strategies, runs, lc, now, prev = null) {
  const prevRows = Object.fromEntries((prev?.rows || []).map((r) => [r.id, r]));
  const rows = [];
  for (const s of strategies) {
    const run = runs[`${s.id}:paper`];
    if (!run || s.closed) continue;
    rows.push(rowOf(s, run, lc[s.id], prevRows[s.id]));
  }
  rows.sort((a, b) => b.ret - a.ret);
  return { week: ymd(now), at: now, rows };
}

/** 성과표 기록에 이번 주를 더한다(같은 주는 덮어씀, 최근 12주만). */
export function appendScorecard(hist, card) {
  const h = (Array.isArray(hist) ? hist : []).filter((c) => c.week !== card.week);
  return [...h, card].slice(-SCORECARD_WEEKS);
}

const pct = (x) => `${x >= 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toFixed(1)}%`;
/** 텔레그램용 한두 줄(쉬운 말, 전략 이름·전문 용어 없이 개수와 가족 장부만). */
export function scorecardLines(card) {
  if (!card?.rows?.length) return [];
  const withWeek = card.rows.filter((r) => r.weekRet != null);
  const up = withWeek.filter((r) => r.weekRet > 0.0005).length, down = withWeek.filter((r) => r.weekRet < -0.0005).length;
  const fam = card.rows.filter((r) => r.book === 'family').map((r) => `${r.name.replace(/:.*$/, '')} ${pct(r.ret)}`);
  const head = withWeek.length
    ? `📊 주간 성과표(가상): 장부 ${card.rows.length}개 중 이번 주 오른 곳 ${up}개 · 내린 곳 ${down}개`
    : `📊 주간 성과표(가상): 장부 ${card.rows.length}개의 첫 기록을 남겼어요(다음 주부터 한 주 변화도 보여요)`;
  return [head, ...(fam.length ? [`· ${fam.join(', ')} (시작부터)`] : []), '· 자세한 표는 화면 \'결론·순위\' 맨 아래에 있어요.'];
}
