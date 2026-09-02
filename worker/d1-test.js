/** 테스트용 D1 대체 — node:sqlite 위에 D1 바인딩 API(prepare/bind/first/all/run/batch)를 얹는다.
 *  실제 schema.sql을 그대로 실행하므로 스키마 오류가 테스트에서 잡힌다. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeD1(schemaPath){
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  if(schemaPath) db.exec(readFileSync(schemaPath, "utf8"));

  const wrap = (sql) => {
    let args = [];
    const stmt = db.prepare(sql);
    const api = {
      bind(...a){ args = a.map(v => v === undefined ? null : v); return api; },
      async first(col){ const r = stmt.get(...args); return r == null ? null : (col ? r[col] : r); },
      async all(){ return { results: stmt.all(...args), success: true }; },
      async run(){ const r = stmt.run(...args); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; }
    };
    return api;
  };
  return {
    prepare: wrap,
    async batch(stmts){ const out = []; for(const s of stmts) out.push(await s.run()); return out; },
    async exec(sql){ db.exec(sql); return { count: 1 }; },
    _raw: db
  };
}
