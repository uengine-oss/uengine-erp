# 재고 (`sql/40_inventory.sql`)

`picking`: `number(WH/IN/00001, WH/OUT/.., WH/INT/..), picking_type(incoming/outgoing/internal), partner_id, origin_type, origin_id, origin_name, location_from, location_to, warehouse_id, scheduled_date, date_done, shipping_policy, state(draft/waiting/confirmed/ready/done/cancelled), backorder_of, return_of, note, moves[{id, product_id, variant_id, name, uom_id, demand, reserved, done, lot_id, lot_name, origin_line_id, unit_cost}]`

명령: `create update confirm check_availability unreserve validate cancel delete`. `validate{backorder: true/false, moves:[{id, done, lot_name}]}`. 반품은 `create{return_of, moves:[{id, qty}]}`.

| 이벤트 | 계약 |
|---|---|
| `PickingCreated`, `PickingConfirmed`, `PickingReserved`, `PickingUnreserved`, `PickingCancelled`(`origin_type, origin_id, moves`) | |
| `PickingValidated` | `{origin_type, origin_id, picking_type, is_return, moves:[{move_id, origin_line_id, product_id, variant_id, qty_done, uom_id, location_from, location_to, lot_id, unit_cost}]}` |

- 파생 표 `erp.quants(variant_id, location_id, lot_id, qty, reserved)`. 재고 수량의 변화는 전부 이벤트에서 나온다.
- react: `SalesOrderConfirmed` → 출고 전표(재화 줄만), `PurchaseOrderConfirmed` → 입고 전표, `SalesOrderLineQtyChanged`·`PurchaseOrderLineQtyChanged` → 열린 전표 수량 조정, 주문 취소 → 열린 전표 취소.
- `stock_adjustment`: `variant_id, location_id, lot_id, counted_qty, theoretical_qty, difference, reason, state(draft/applied/reverted)`. 이벤트 `StockAdjusted{variant_id, location_id, lot_id, delta, unit_cost}`, `StockAdjustmentReverted`.
- `scrap`: `variant_id, location_id, lot_id, qty, reason, origin_picking_id, state(done)`. 이벤트 `StockScrapped`.
- `lot`: `name, product_id, variant_id, expiration_date`. `serial` 은 수량 1 규칙.
- `reorder_rule`: `variant_id, location_id, min_qty, max_qty, multiple, trigger(auto/manual), vendor_id, active`. 함수 `public.erp_run_scheduler()` 와 react: 재고 변동·주문 확정 때 `auto` 규칙 평가. `RfqRequested` 이벤트(`reorder_rule` 스트림)를 내면 구매 모듈이 RFQ 를 만든다.
- 뷰 `public.erp_stock`: `variant_id, product_id, location_id, lot_id, on_hand, reserved, available, incoming, outgoing, forecast, unit_cost, value`.
- 원가: 분류의 `cost_method`. `average` 면 입고 때 `ProductCostChanged` 를 낸다.

