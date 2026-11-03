-- Sample plugin: customers earn points when an order is confirmed. Nothing outside this file changes,
-- and the sales module does not know it exists. Paste into the SQL Editor after the ERP is installed.
create schema if not exists erp_points;

select erp.catalog_put('{
  "type": "points_entry", "module": "points", "sort": 500, "label": "포인트", "label_en": "Points",
  "fields": [
    {"name": "name", "label": "내용", "type": "text", "list": true},
    {"name": "partner_id", "label": "거래처", "type": "ref", "ref": "partner", "list": true},
    {"name": "points", "label": "포인트", "type": "number", "list": true},
    {"name": "origin_id", "label": "원본 주문", "type": "text"}
  ],
  "commands": {}
}'::jsonb);

create or replace function erp_points.on_order(ev erp.events) returns void
language plpgsql as $$
declare id_ uuid := erp.seed_id('points:' || ev.stream_id);
begin
  -- The same event can arrive twice after a retry or a reinstall; the fixed id makes that harmless.
  if ev.event_type = 'SalesOrderConfirmed' and not exists (select 1 from erp.records where id = id_ and not deleted) then
    perform erp.emit('points_entry', id_, 'PointsEarned', jsonb_build_object('set', jsonb_build_object(
      'name', '주문 ' || (ev.data ->> 'number'),
      'partner_id', ev.data ->> 'partner_id',
      'points', floor((ev.data ->> 'amount_untaxed')::numeric / 100),
      'origin_id', ev.stream_id)));
  elsif ev.event_type = 'SalesOrderCancelled' and exists (select 1 from erp.records where id = id_ and not deleted) then
    perform erp.emit('points_entry', id_, 'PointsCancelled', '{"set":{"deleted":true,"active":false}}');
  end if;
end $$;

select erp.module_put('{
  "id": "points", "label": "포인트", "label_en": "Points", "sort": 500,
  "description": "주문을 확정하면 거래처에 포인트를 쌓습니다.",
  "subscribes": [{"name": "points.orders", "handler": "erp_points.on_order", "events": ["SalesOrderConfirmed", "SalesOrderCancelled"]}]
}'::jsonb);
select erp.rest_publish('points_entry');
notify pgrst, 'reload schema';
