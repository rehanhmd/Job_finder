import { DatabaseSync } from 'node:sqlite';
export function D1() {
  const db = new DatabaseSync(':memory:');
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, a),
    _run() { const st = db.prepare(sql); if (/^\s*(select|insert.*returning|update.*returning)/is.test(sql)) return { results: st.all(...args), meta: {} }; const r = st.run(...args); return { results: [], meta: { changes: Number(r.changes) } }; },
    async first() { return this._run().results[0] || null; }, async all() { return this._run(); }, async run() { return this._run(); }
  });
  return { prepare: (s) => mk(s), batch: async (stmts) => stmts.map((s) => s._run()), _db: db };
}
