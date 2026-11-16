import { FEEDS } from '../data/feeds.js';
import { kvSetStmt, healthOk, healthErr } from '../db/store.js';
import { DAY } from '../core/calendar.js';

/** Fetch at most one due feed per call (keeps the tick small). */
export async function feedsTask(env, kv, now, { fetcher = fetch } = {}) {
  if (String(env.FEEDS_ENABLED ?? 'true') === 'false') return false;
  for (const f of FEEDS) {
    if (f.needs && !env[f.needs]) continue;
    const k = `feed:at:${f.id}`;
    if ((kv[k] || 0) > now - f.every) continue;
    kv[k] = now;
    try {
      const items = await f.fetch(fetcher, env, now);
      const st = env.DB.prepare('INSERT OR IGNORE INTO feed_items (source, t, sym, type, payload, fetched_at) VALUES (?,?,?,?,?,?)');
      await env.DB.batch([...items.map((i) => st.bind(f.id, i.t, i.sym, i.type, JSON.stringify(i.payload), now)), kvSetStmt(env.DB, k, now),
        env.DB.prepare('DELETE FROM feed_items WHERE t < ?').bind(now - 30 * DAY)]);
      await healthOk(env.DB, `feed:${f.id}`);
    } catch (e) {
      await env.DB.batch([kvSetStmt(env.DB, k, now)]);
      await healthErr(env.DB, `feed:${f.id}`, e);
    }
    return true;
  }
  return false;
}
