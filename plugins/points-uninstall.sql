-- Removes the plugin's live parts. Its events stay in the ledger as what happened.
drop view if exists public.erp_api_points_entry;
select erp.module_remove('points');
drop schema if exists erp_points cascade;
notify pgrst, 'reload schema';
