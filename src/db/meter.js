// D1 읽기 계량(2026-11-24 #F-010): 무료 한도는 '계정' 전체 하루 500만 행 읽기(UTC 자정에 다시 참). 넘으면 계정의 모든 D1
// 쿼리(다른 사이트 포함)가 그날 실패한다 → 틱 동안 이 DB가 읽은 행(D1 응답 meta.rows_read)을 작업별로 더해 kv 'd1:reads'에 남기고,
// 오늘 합계가 문턱을 넘으면 덜 급한 일을 쉰다(tick.js). 요청 경로(/health·대시보드)는 세지 않는다(작고 사람이 볼 때만).

/** UTC 날짜(D1 한도가 다시 차는 기준). */
export const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * db(D1 바인딩)를 감싸 읽은 행을 counter에 더한다. counter = { total, byTask: {}, cur }.
 * prepare/bind/all/run/first/batch만 가로채고 나머지는 그대로 넘긴다. first()는 all()로 읽어 meta를 얻는다(읽는 행은 같음).
 */
export function meteredDB(db, counter) {
  const raw = new WeakMap(); // 감싼 문장 → 원래 문장(batch에는 원래 문장을 넘겨야 함)
  const add = (meta) => {
    const n = Number(meta?.rows_read) || 0;
    if (!n) return;
    counter.total += n;
    const k = counter.cur || 'other';
    counter.byTask[k] = (counter.byTask[k] || 0) + n;
  };
  const wrap = (st) => {
    const p = new Proxy(st, {
      get(target, prop) {
        if (prop === 'bind') return (...a) => wrap(target.bind(...a));
        if (prop === 'all' || prop === 'run') return async (...a) => { const r = await target[prop](...a); add(r?.meta); return r; };
        if (prop === 'first') {
          return async (col) => {
            const r = await target.all();
            add(r?.meta);
            const row = r?.results?.[0] ?? null;
            return col == null ? row : row ? (row[col] ?? null) : null;
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    raw.set(p, st);
    return p;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => wrap(target.prepare(sql));
      if (prop === 'batch') {
        return async (stmts) => {
          const rs = await target.batch(stmts.map((s) => raw.get(s) || s));
          for (const r of rs || []) add(r?.meta);
          return rs;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** 문턱(이 DB의 오늘 읽은 행, UTC). 계정 다른 DB가 하루 약 50만 행(11-24 D 보고) → 이 DB 250만이면 계정 약 300만. */
export const D1_READ_SOFT = 2_500_000; // 넘으면 덜 급한 일(과거 재검증·과거 채우기·비교 AI·연구 가져오기)을 쉼
export const D1_READ_HARD = 3_500_000; // 넘으면 수집·모의 장부 한 칸·알림만(평가·배분도 쉼)

/** 오늘(UTC) 지금까지 읽은 행. 날짜가 바뀌었으면 0. */
export function readsToday(kv, now) {
  const r = kv?.['d1:reads'];
  return r && r.day === utcDay(now) ? Number(r.total) || 0 : 0;
}

/**
 * 이번 틱 계량을 합친 새 kv 값들. prev = kv 'd1:reads', hist = kv 'd1:reads:hist'(지난 날 14개).
 * 반환 { reads, hist } — hist는 날짜가 바뀐 틱에만 바뀐다(아니면 null).
 */
export function mergeReads(prev, hist, counter, now) {
  const day = utcDay(now);
  let newHist = null;
  let base = prev && prev.day === day ? prev : null;
  if (prev && prev.day && prev.day !== day) newHist = [...(Array.isArray(hist) ? hist : []), { day: prev.day, total: prev.total, ticks: prev.ticks, top: topTasks(prev.byTask, 6) }].slice(-14);
  if (!base) base = { day, total: 0, ticks: 0, byTask: {} };
  const byTask = { ...base.byTask };
  for (const [k, v] of Object.entries(counter.byTask)) byTask[k] = (byTask[k] || 0) + v;
  return { reads: { day, total: base.total + counter.total, ticks: base.ticks + 1, byTask, at: now, warned: base.warned || null }, hist: newHist };
}

export function topTasks(byTask, n = 6) {
  return Object.fromEntries(Object.entries(byTask || {}).sort((a, b) => b[1] - a[1]).slice(0, n));
}
