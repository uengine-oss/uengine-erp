// Returns the local test stack to "no ERP installed", so browser tests can walk the first-run flow.
// Refuses any database except the local stack on 127.0.0.1:56322: this script deletes data.
import pg from 'pg'
import { fileURLToPath } from 'node:url'

export const LOCAL_PG = 'postgres://postgres:postgres@127.0.0.1:56322/postgres'

export async function resetLocal(connectionString = LOCAL_PG) {
  const target = new URL(connectionString)
  if (target.hostname !== '127.0.0.1' || target.port !== '56322') {
    throw new Error('reset-local only runs against the local stack on 127.0.0.1:56322')
  }
  const c = new pg.Client({ connectionString })
  await c.connect()
  try {
    // Cron jobs live outside the erp schema and would keep failing after it is gone.
    await c.query(`select cron.unschedule(jobname) from cron.job where jobname like 'erp-%'`).catch(() => {})
    await c.query('begin')
    const fns = await c.query(`
      select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'erp\\_%'`)
    for (const { sig } of fns.rows) await c.query(`drop function if exists ${sig} cascade`)
    const views = await c.query(`
      select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'erp\\_%' and c.relkind in ('v', 'm')`)
    for (const { relname, relkind } of views.rows) {
      await c.query(`drop ${relkind === 'm' ? 'materialized view' : 'view'} if exists public.${relname} cascade`)
    }
    // Takes the sign-up guard trigger on auth.users with it.
    await c.query('drop schema if exists erp cascade')
    await c.query(`delete from auth.users where email like '%@example.com' or email like '%@test.co' or email like '%@demo.example'`)
    await c.query('commit')
    await c.query(`notify pgrst, 'reload schema'`)
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    await c.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await resetLocal(process.env.ERP_LOCAL_PG || LOCAL_PG)
  console.log('local stack reset: erp schema, public.erp_* and test accounts removed')
}
