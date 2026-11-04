# 재고 (`sql/40_inventory.sql`)

모듈 `inventory`(sort 20). 판매·구매 없이도 수동 전표로 동작한다. 판매·구매는 이벤트로만 안다(`docs/modules/events.md`). 판매 표와 함수를 읽지 않는다.

## 켜기

- `module enable {id: 'inventory', options: {import_since: '2024-12-01'}}`. `import_since` 를 주면 그 날짜 이후의 판매 이벤트를 처음부터 다시 받아 출고 대기를 만든다(취소·수량 변경도 함께 재생된다). 없으면 켠 뒤의 이벤트만 받는다. 구매 이벤트는 켠 뒤부터다.
- 기초 재고는 `stock_adjustment` 로 넣는다. 시드: 창고 `WH`, 위치 `재고·공급사·고객·재고조정·폐기·생산`, 작업 유형 `WH/IN`, `WH/OUT`, `WH/INT`.

## 전표 `picking`

`number(WH/IN/00001, WH/OUT/.., WH/INT/..), picking_type(incoming/outgoing/internal), operation_type_id, partner_id, origin_type, origin_id, origin_name, location_from, location_to, warehouse_id, scheduled_date, date_done, shipping_policy(direct/one), state(draft/waiting/confirmed/ready/done/cancelled), backorder_of, return_of, is_return, to_refund, note, moves[{id, product_id, variant_id, name, uom_id, demand, reserved, done, lot_id, lot_name, lots, origin_line_id, unit_cost, allocs, date_planned, source_seq, storable, tracking, state}]`

- 이동의 수량과 단위는 언제나 제품 기준 단위다. 주문 줄 단위는 이벤트의 `uom_id` 로 환산한다.
- 이동 `state`: `draft, confirmed, partial, ready, done, cancelled`. 수량 0 이면 `cancelled`.
- 전표 `state`: 직접 정책(`direct`)은 일부라도 예약되면 `ready`, 전량 정책(`one`)은 전부 예약돼야 `ready`. 재고 위치에서 나가지 않는 전표(입고, 반품 입고)는 확정하면 바로 `ready`.

| 명령 | 뜻 |
|---|---|
| `create` | 초안. `{picking_type, partner_id, location_from, location_to, warehouse_id, scheduled_date, shipping_policy, note, moves:[{variant_id 또는 product_id, demand, uom_id, unit_cost, lot_name}]}`. 위치는 유형과 창고로 채운다 |
| `create{return_of, moves:[{id, qty}], to_refund}` | 반품. 원 전표의 위치를 뒤집어 바로 확정한다. `to_refund` 기본값 `true`. 수량 상한이 없고, 완료 전 전표와 반품의 반품도 된다 |
| `update` | 머리글과 이동. 끝난 전표는 메모만 |
| `confirm` | 초안 → 열림. 출고면 자동 재주문 규칙을 평가한다 |
| `check_availability` | 가능한 만큼 예약. 초안이면 함께 확정 |
| `unreserve` | 예약 해제 |
| `validate{backorder, moves:[{id, done, lot_name, lot_id, lots:[{lot_name, lot_id, qty}]}]}` | 처리. 초안이면 함께 확정 |
| `cancel`, `delete` | 완료된 전표는 거부. 삭제는 초안·열림·취소만 |

`validate` 규칙:

- 수량을 주지 않으면 입력해 둔 `done`, 그것도 없으면 예약된 수량을 처리한다. 합이 0 이면 `ERP_NOTHING_RESERVED`.
- 요구보다 많이 처리해도 된다. 재고보다 많이 처리하면 음수가 된다. 다른 전표의 예약은 재고가 줄어든 만큼 최근 것부터 풀린다.
- 요구보다 적으면 `backorder` 로 정한다. `true` 는 나머지로 새 전표(`backorder_of`), `false` 는 나머지를 버린다. 없으면 작업 유형의 `backorder_policy`, `ask` 면 `ERP_BACKORDER_CHOICE`.
- 로트·일련번호 제품은 로트가 필요하다(`ERP_LOT_REQUIRED`). 출고는 입력이 없으면 예약된 로트를 쓴다. 일련번호는 한 번호에 수량 1, 중복과 재고에 있는 번호 입고는 `ERP_SERIAL`. 입고의 새 번호는 `lot` 을 만든다.

이벤트: `PickingCreated`, `PickingUpdated`, `PickingConfirmed`, `PickingReserved`, `PickingUnreserved`, `PickingReservationReduced`, `PickingMoveAdded/Changed/Removed`, `PickingMoveCostChanged`, `PickingCancelled`, `PickingDeleted`. 모듈 사이 계약은 `PickingStateChanged`(상태가 바뀔 때마다), `PickingValidated`.

`PickingValidated.moves` 는 이동·로트마다 한 줄이고, 줄마다 `move_id` 가 다르다. 받는 쪽은 `origin_line_id` 로 합친다.

## 재고 수량

- 파생 표 `erp.quants(variant_id, location_id, lot_id, qty, reserved, in_date)`. 효과 kind `quant` 로만 바뀐다. `data.effects.quant = [{variant_id, location_id, lot_id, qty, reserved}]`.
- **실물 위치(`internal`, `transit`)만 행이 있다.** 공급사·고객·재고조정·폐기 쪽 행은 없으므로 합계가 곧 재고다.
- 일상 운영의 음수는 막지 않는다. `check_fn` 은 커널 되돌리기(`erp_rollback_*`)만 막는다. 재고 조정의 `revert` 명령은 음수가 되어도 된다.
- 동시성: 재고를 읽고 판단하는 처리는 제품별 advisory 잠금과 행 잠금을 정렬 순서로 잡는다. 다른 전표의 예약을 풀 때 그 전표가 처리 중이면 건너뛴다. 기다리면 교착이 생기고, 그 전표는 스스로 정리한다.
- `erp.stock_open_moves`: 열린 전표의 이동. `project` 훅이 유지하며 재고 보기와 예측이 읽는다.

## 원가

- 분류의 `cost_method`. `standard` 는 입고로 바뀌지 않는다.
- `average`: 반품이 아닌 입고 때 `(재고×원가 + 입고×단가) / 합계`, 소수 6자리. 재고가 0 이하면 입고 단가. 출고·반품·조정은 바꾸지 않는다. 변형의 `standard_price` 를 `ProductCostChanged` 로 고친다.
- 단가는 구매 줄의 `unit_price × (1 - discount/100)` 를 기준 단위로 환산한 값이다. 입고 전 가격 변경은 `PurchaseOrderLinePriceChanged` 로 따라간다. 수동 전표는 이동의 `unit_cost`, 없으면 현재 원가.

## 재고 조정 `stock_adjustment`

`number(ADJ/00001), variant_id, product_id, location_id, warehouse_id, lot_id, counted_qty, theoretical_qty, difference, reason, reference, count_date, assignee_id, accounting_date, counted_by, applied_by, applied_at, state(draft/applied/reverted)`

- 명령: `create update apply revert match zero delete`. `create{apply: true}` 는 만들면서 반영, `create{prefill: 'current'}` 는 현재고로 채움. `count_date` 기본값은 회사 설정 `annual_count_month`, `annual_count_day`(기본 12월 31일)의 다음 날짜.
- `apply` 는 실사 뒤 재고가 움직였으면 `ERP_STOCK_MOVED`, `{force: true}` 로 진행한다. 결과는 언제나 실사 수량이다. 차이가 0 이어도 `StockAdjusted` 가 남는다.
- `revert` 는 차이를 거꾸로 낸다. 이벤트는 `StockAdjusted`(`delta` 음수 또는 양수, `reverts`)라서 회계와 분석이 따로 알 필요가 없다.
- 일괄: `public.erp_stock_adjust_many(ids, 'apply'|'match'|'zero', force)`.

## 폐기 `scrap`

`number(SP/00001), variant_id, product_id, qty, uom_id, location_id, scrap_location_id, lot_id, reason, origin_picking_id, replenish, date_done, unit_cost, state(draft/done)`

명령: `create update validate delete`. 현재고보다 많으면 `ERP_SCRAP_SHORT`, `validate{force: true}` 로 진행한다. 끝난 폐기는 고치거나 지울 수 없다. `replenish` 면 재주문 규칙을 바로 평가한다. 폐기 위치의 누적은 뷰 `public.erp_stock_scrapped`.

## 로트 `lot`, 작업 유형 `operation_type`

- `lot`: `name, product_id, variant_id, expiration_date`. 변형 안에서 이름이 유일하다. 예약은 먼저 들어온 로트부터다.
- `operation_type`: `name, code(incoming/outgoing/internal), warehouse_id, prefix, backorder_policy(ask/always/never), reservation_method(at_confirm/manual/by_date), reservation_days_before, return_type_id`. 없으면 창고 코드로 기본값(`W2/IN/`, `ask`, `at_confirm`)을 쓴다.

## 재주문 `reorder_rule`

`name, variant_id, location_id, warehouse_id, min_qty, max_qty, multiple, trigger(auto/manual), vendor_id, snoozed_until, last_error, active`. 같은 제품·위치에 하나, 최소 ≤ 최대. 만들어도 바로 요청하지 않는다.

- 예측 = 현재고 − 출고 예정 + 입고 예정 + 초안 구매 수량·제조 계획 + 답 없는 요청. 예정은 공급사 납기 안에 드는 이동만 센다. 확정 안 된 판매 견적은 세지 않는다.
- 수량: 예측 < 최소일 때 `최대 − 예측` 을 배수로 내림한다. 그래서 0 일 수 있다. 배수 0 은 내림하지 않는다.
- 자동 규칙은 **주문 확정, 주문 수량 증가, 줄 추가, 출고 전표 확정** 때 바로 요청한다. 재고 조정과 폐기는 스케줄러를 기다린다(폐기 `replenish` 제외).
- 명령 `replenish{qty, to_max}`, `snooze{until}`. 공급사가 없으면 사람의 요청은 `ERP_NO_VENDOR`, 스케줄러는 `last_error` 에 남긴다.
- `public.erp_run_scheduler()`, pg_cron 이 있으면 매일 `erp.stock_scheduler()`: 대기 전표 예약, 넘친 예약 정리, 자동 규칙 평가.

`stock_replenishment`(`number RR/00001`): 요청 한 건이 문서 하나다. `ReorderRequested` 는 이 스트림에 실린다. 그래서 주문 하나를 되돌릴 때 같은 제품의 뒤 주문이 함께 끌려오지 않는다. 규칙 없이 직접 만들 수도 있다(`create{variant_id, qty, vendor_id}`). 구매가 `PurchaseDraftQtyChanged.requests` 로 답하면 `acknowledged` 가 되고, 답이 없으면 하루 뒤 예측에서 빠져 규칙이 다시 묻는다(구매가 꺼져 있어도 동작해야 하기 때문이다).

`stock_rfq_watch`(숨김): 구매 문서마다 하나. 초안 수량을 효과 kind `stock_rfq` 로 `erp.stock_rfq_qty` 에 싣는다.

## 다른 모듈 이벤트

| 이벤트 | 하는 일 |
|---|---|
| `SalesOrderConfirmed`, `PurchaseOrderConfirmed` | 재화 줄로 전표 생성·확정. 전표 ID 는 이벤트 번호에서 나오므로 두 번 받아도 하나다. 예정일은 직접 정책이면 가장 이른 줄, 전량 정책이면 가장 늦은 줄 |
| `...LineAdded` | 열린 전표에 이동 추가, 없으면 새 전표 |
| `...LineQtyChanged` | `주문 − 처리 − 열림` 만큼 열린 이동을 조정한다. 열린 게 없으면 새 전표. 0 이 되면 취소. 전표를 취소한 뒤면 전체 수량으로 새 전표. 이동의 `source_seq` 로 늦게 온 옛 이벤트를 무시한다 |
| `PurchaseOrderLinePriceChanged` | 열린 입고의 단가 |
| `...Cancelled` | 열린 전표 취소, 끝난 전표는 그대로 |
| `PurchaseDraftQtyChanged` | 초안 수량, 요청 응답 |
| `ManufacturingPlanChanged` | 초안 구매 수량과 같은 합계에 넣고 요청에 답한다. 음수 줄이 있으면 그 제품의 자동 규칙을 평가한다 |
| `ManufacturingDone` | 재고 → 생산(자재), 생산 → 재고(완제품) 전표를 만들어 바로 처리한다. 아래 |
| `ManufacturingReversed` | 그 전표들을 실제 반품으로 되돌린다. 아래 |

주문이 켜기 전의 것이면 전표가 없다. 그런 주문의 수량 증가는 늘어난 만큼만 새 전표가 되고 감소는 무시한다.

### 제조에서 온 일

제조 모듈은 이벤트만 낸다. 재고는 제조의 함수와 표를 부르지 않고, 아는 것은 이벤트 이름 셋이다(`test/isolation.test.mjs`). 켜져 있는 제조가 없어도 재고는 그대로 동작한다.

- 전표 둘은 `picking_type: internal`, `origin_type: manufacturing_order` 이고 위치 한쪽이 시드 위치 `생산`(용도 `production`, 실물 위치가 아니라 재고 행이 없다)이다. 전표 ID 는 이벤트 번호에서 나오므로 두 번 받아도 하나다.
- 일반 전표와 같은 `picking_validate` 를 지나므로 재고 부족은 음수가 되고, 다른 전표의 예약은 최근 것부터 풀린다. 날짜는 이벤트의 `date_done` 이다. 사람이 `validate` 에 날짜를 넣어도 무시한다.
- 자재는 그때의 원가로 나간다. 그 합계가 `production_value` 다. `average` 제품은 합계 ÷ 수량으로 들어와 일반 입고처럼 평균을 옮기고, `standard` 제품은 표준 원가로 들어온다.
- 자재의 자동 재주문 규칙은 계획이 늘 때와 자재가 줄어든 뒤 평가한다.
- 자재 수량은 전표로 나갈 때 제품 기준 단위의 `rounding` 으로 반올림된다.
- 되돌리기는 일반 전표와 같다. 사가의 `ManufacturingReversed` 는 완제품, 자재 순으로 반품한다(`to_refund: false`, 단가 유지). `average` 면 평균도 되돌린다.

재주문 규칙의 `replenish_by` 는 제조 모듈이 카탈로그에 더하는 칸이다. 재고는 값이 `buy` 가 아니면 공급사를 묻지 않고 그 값을 `ReorderRequested` 에 실어 보낸다. 무슨 뜻인지는 모른다. 표시는 `erp_replenish_list.replenish_by`.

## 조회

- 뷰 `public.erp_stock`: `variant_id, product_id, location_id, lot_id, on_hand, reserved, available, incoming, outgoing, forecast, unit_cost, value, warehouse_id, category_id`. 입고·출고 예정은 로트 없는 행에 실린다.
- 뷰 `public.erp_stock_moves`: 이동 내역. 원장에서 바로 읽고 되돌려진 이벤트는 뺀다. `erp_stock_scrapped` 는 이것의 합계다.
- `public.erp_stock_forecast(variant_id, warehouse_id)`: 문서별 예정과 누적 잔량, 음수 표시.
- `public.erp_stock_overview()`: 창고·유형별 준비·대기·지연·백오더 건수.
- `public.erp_replenish_list()`: 규칙별 예측과 주문 수량, 납기, 멈춘 이유.
- `public.erp_stock_check_all(ids)`: 대기 전표 일괄 재고 확인.

## 손으로 적은 납품

재고를 켜기 전에 판매 주문에 손으로 적은 납품(`SalesOrderDelivered`, `manual: true`)은 `import_since` 재생에서 뒤따라온다. 앞서 만든 출고 전표의 요구 수량이 그만큼 줄고, 남은 것이 없으면 전표가 취소된다. 그래서 이미 나간 물건이 다시 나가지 않는다. 전표가 없는 주문의 손 납품은 무시한다.

## 조회 더

- `erp_stock_move_report(filters{from, to, picking_type, product_id, is_return}, group_by[])`: `rows[{<묶음>, moves, qty, value}]`. 묶음은 `picking_type, product_id, variant_id, location_from, location_to, document_id, is_return, category_id, day, month`.
- `erp_stock_availability(variant_ids[], warehouse_id)`: `[{variant_id, on_hand, reserved, available, incoming, outgoing, forecast, next_incoming_date, short, no_future_supply}]`. 주문 줄에 예약·가용을 보여 줄 때 쓴다.
- 재고 추적을 끈 제품에는 재주문 규칙을 둘 수 없다(`ERP_INVALID`).
- 재고 모듈이 꺼져 있으면 함수는 `ERP_MODULE_OFF` 다. 뷰(`erp_stock`, `erp_stock_moves`)는 쌓인 것을 그대로 보여 준다.
