-- Runs last. Supabase grants new public functions to anon by default, so access is closed here in one
-- place rather than relying on each module to remember. Only setup and the customer portal stay open.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'erp\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname in ('erp_status', 'erp_bootstrap', 'erp_mcp') or f.proname like 'erp\_portal\_%' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;

  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'erp'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  grant execute on function erp.is_member(), erp.has_role(text[]), erp.current_actor(), erp.readable_types(), erp.open_types(), erp.scoped_types(), erp.scoped_ids() to authenticated;

  for f in select c.relname as proname, format('public.%I', c.relname) as sig from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname like 'erp\_%' and c.relkind in ('v', 'm', 'r') loop
    execute format('revoke all on %s from public, anon, authenticated', f.sig);
    execute format('grant select on %s to authenticated', f.sig);
    -- Generated resources take writes through their trigger, which only issues commands.
    if f.proname like 'erp\_api\_%' then execute format('grant insert, update, delete on %s to authenticated', f.sig); end if;
  end loop;
end $$;
