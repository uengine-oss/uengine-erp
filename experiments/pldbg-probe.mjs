// Reproduces the preloaded extension's "cannot find parent statement" error: a function active in an outer frame
// is called again in an inner one while function definitions change. Does it stick to the connection afterwards?
import pg from 'pg'
const base = 'postgres://postgres:postgres@127.0.0.1:56322/'
const admin = new pg.Client({ connectionString: base + 'postgres' }); await admin.connect()
const dbA = `erp_t_probe_${Date.now().toString(36)}`, dbB = dbA + '_b'
await admin.query(`create database ${dbA}`); await admin.query(`create database ${dbB}`)
const a = new pg.Client({ connectionString: base + dbA }); await a.connect()
const fns = (n) => Array.from({ length: n }, (_, i) => `create or replace function ddl_${i}() returns int language plpgsql as $f$ begin return ${i}; end $f$;`).join('\n')
await a.query(`
  create function rec_f(d int) returns int language plpgsql as $f$
  declare t int := 0; s int;
  begin
    for s in 1..3 loop
      begin
        if d > 0 then t := t + rec_f(d - 1); end if;
        if s = 2 and d = 1 then raise exception 'x'; end if;
      exception when others then t := t - 1;
      end;
      -- Lagging behind the invalidation queue is what a long batch does; sleeping makes it certain.
      if d = 2 and s = 2 then perform pg_sleep(0.3); end if;
      perform pg_catalog.length('a');
      exit when s > 3;
    end loop;
    return t;
  end $f$;`)
async function loopA(ms, label, k = a) {
  const end = Date.now() + ms
  let ok = 0, bad = 0, streak = 0, maxStreak = 0, first = null, other = null
  while (Date.now() < end) {
    try { await k.query('select rec_f(4)'); ok++; streak = 0 }
    catch (e) { bad++; streak++; maxStreak = Math.max(maxStreak, streak); if (/pldbgapi2/.test(e.message)) first ??= e.message.slice(0, 50); else other = e.message.slice(0, 80) }
  }
  console.log(label, { ok, bad, maxStreak, first, other })
  return { ok, bad }
}
await loopA(4000, 'alone')
async function withDdl(db, label, n) {
  const b = new pg.Client({ connectionString: base + db }); await b.connect()
  let stop = false, rounds = 0
  const ddl = (async () => { while (!stop) { await b.query(fns(n)); rounds++ } })()
  await loopA(15000, label)
  stop = true; await ddl; await b.end()
  console.log('  ddl rounds', rounds)
}
await withDdl(dbB, 'DDL flood in another database, caller lagging', 800)
await loopA(6000, 'same connection, flood stopped')
await withDdl(dbA, 'DDL in the same database, caller lagging', 800)
await loopA(6000, 'same connection, DDL stopped')
const a2 = new pg.Client({ connectionString: base + dbA }); await a2.connect()
await loopA(3000, 'new connection', a2)
await a.end(); await a2.end()
await admin.query(`drop database ${dbA} with (force)`); await admin.query(`drop database ${dbB} with (force)`); await admin.end()
