// Synthetic deterministic data + an in-memory D1 shim (node:sqlite) for job tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { DAY, isKrxBusinessDay, dayT } from '../src/core/calendar.js';

export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** Random-walk daily bars with drift; `skipNonKrx` drops weekends/holidays. */
export function makeBars({ start = '2020-01-01', n = 600, p0 = 10000, drift = 0.0004, vol = 0.012, seed = 7, skipNonKrx = false }) {
  const r = rng(seed);
  const out = [];
  let t = dayT(start), p = p0;
  while (out.length < n) {
    if (!skipNonKrx || isKrxBusinessDay(t)) {
      const z = (r() + r() + r() - 1.5) * 2;
      const o = p * (1 + (r() - 0.5) * vol * 0.3);
      const c = Math.max(1, o * (1 + drift + vol * z));
      const h = Math.max(o, c) * (1 + r() * vol * 0.5), l = Math.min(o, c) * (1 - r() * vol * 0.5);
      out.push({ t, o, h, l, c, v: 1000 + Math.floor(r() * 1000) });
      p = c;
    }
    t += DAY;
  }
  return out;
}

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { const s = new Stmt(this.db, this.sql); s.args = a.map((x) => (x === undefined ? null : typeof x === 'boolean' ? Number(x) : x)); return s; }
  _p() { return this.db.prepare(this.sql); }
  async all() { return { results: this._p().all(...this.args), meta: {} }; }
  async first() { return this._p().get(...this.args) ?? null; }
  async run() { const r = this._p().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await (/^\s*(SELECT|WITH)/i.test(s.sql) ? s.all() : s.run())); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
