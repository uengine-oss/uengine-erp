------------------------------------------------------------------------------------------------
-- What people see on the generic screens. A line names a variant; its product id is bookkeeping.
------------------------------------------------------------------------------------------------
create or replace function erp.screen_fields(p_fields jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(case
      when f ? 'columns' then f || jsonb_build_object('columns', erp.screen_fields(f -> 'columns'))
      when has_variant and f ->> 'name' = 'product_id' then f || '{"hidden":true}'::jsonb
      when has_variant and f ->> 'name' = 'variant_id' then f || '{"label":"제품"}'::jsonb
      else f end order by o), '[]'::jsonb)
    from jsonb_array_elements(p_fields) with ordinality t(f, o),
         lateral (select exists (select 1 from jsonb_array_elements(p_fields) x where x ->> 'name' = 'variant_id') as has_variant) v
$$;

update erp.catalog set doc = jsonb_set(doc, '{fields}', erp.screen_fields(doc -> 'fields'))
 where type in ('picking', 'purchase_order', 'account_move', 'stock_adjustment', 'scrap', 'lot', 'stock_replenishment');
