// Applies dist-sql/install.sql to the local Supabase stack, the same script a user pastes in the SQL Editor.
import fs from 'node:fs'
import pg from 'pg'
const url = process.env.ERP_LOCAL_PG || 'postgres://postgres:postgres@127.0.0.1:56322/postgres'
const code = process.argv[2]
const c = new pg.Client({ connectionString: url })
await c.connect()
await c.query(fs.readFileSync(new URL('../dist-sql/install.sql', import.meta.url), 'utf8'))
if (code) await c.query('select erp.set_setup_code($1)', [code])
const { rows } = await c.query('select public.erp_status() as s')
console.log(JSON.stringify(rows[0].s))
await c.end()
