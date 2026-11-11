# 제조 (`sql/67g_mrp.sql`)

모듈 `mrp`(sort 70). 자재 명세와 제조 지시를 다룬다. **재고가 켜져 있어야 켤 수 있다**(`requires: ["inventory"]`, 아니면 `ERP_MODULE_REQUIRED`). 제조는 일어난 일을 알릴 뿐이고 재고 표를 만지지 않는다. 재고 모듈이 이벤트를 듣고 자재를 줄이고 완제품을 늘린다. 재고는 제조를 모른다. 시나리오는 S15 다.

**파일 번호.** 재고(40)와 회계(65) 뒤, 분석(70) 앞이다. 재주문 규칙과 구성원의 카탈로그에 칸과 역할을 더하려면 그쪽 파일 다음이어야 하고, 90(REST)과 99(권한)는 여기서 만든 카탈로그와 함수를 봐야 한다.

## 자재 명세 `bom`

`name(자동), product_id, variant_id, code, output_qty, uom_id, sequence, consumption(allow/ask/block), active, lines[{id, variant_id, product_id, name, qty, uom_id}]`

- 쓰기는 `mrp` 역할과 관리자, 읽기는 모든 구성원이다.
- **기준 수량.** 줄의 수량은 `output_qty` 만큼 만들 때 드는 양이다. 단위는 기존 규칙을 따른다. 분류가 다른 단위는 `ERP_UOM` 이고, 줄은 적은 그 단위로 남고, 재고로 넘어갈 때 제품 기준 단위로 바뀐다.
- **고를 수 없는 것.** 완제품과 자재는 재고를 추적하는 재화여야 한다. 서비스, 재고 추적을 끈 제품, 로트·일련번호 제품은 거부한다. 재고까지 가서 거부되면 구독자만 멈추기 때문에 여기서 먼저 막는다.
- **순환.** 완제품이 자기 자재를 따라가다 다시 나오면 거부하고 경로를 말한다. 깊이에 상관없고, 다시 사용(보관 해제)할 때도 검사한다. 사용 중인 명세만 따진다. 명세 변경은 `erp.mrp_lock()` 으로 한 번에 하나씩 지나간다.
- **여럿일 때.** 한 제품에 명세가 여럿이면 `sequence` 가 낮은 것을 먼저 쓴다. 보관한 명세는 새 지시에 쓰이지 않는다.
- **바꿔도 열린 지시는 그대로다.** 지시는 만들 때 자재를 자기 문서에 옮겨 적는다.
- 쓰인 명세는 지울 수 없고 보관한다.

### 다단계의 범위

자재가 다시 명세를 가져도 된다. **읽을 때만 펼친다**(`erp_mrp_explode`). 각 단계는 자기 제조 지시로 만든다. 부모 지시가 자식 지시를 만들지 않는다. 반제품에 재주문 규칙을 두고 보충 방식을 제조로 하면, 부모 지시를 확정할 때 반제품의 예측이 내려가 초안이 한 단계 아래에 저절로 생긴다.

## 제조 지시 `manufacturing_order`

`number(MO/00001), variant_id, product_id, name, qty, uom_id, bom_id, warehouse_id, date_planned, origin, backorder_of, consumption, qty_done, date_confirmed, date_started, date_done, stock_state, material_cost, unit_cost, note, state, components[{id, variant_id, product_id, name, qty, uom_id, qty_done}]`

| 명령 | 언제 | 뜻 |
|---|---|---|
| `create` | | 초안. 명세를 말하지 않으면 그 제품의 첫 명세를 쓴다. 자재는 명세 비율로 계산하고, `components` 를 주면 그 값을 쓴다 |
| `update` | 초안 | 제품·수량·단위·명세가 바뀌면 자재를 다시 계산한다. 같은 요청에 `components` 가 있으면 그 값을 쓴다 |
| `update` | 확정·진행 | 예정일과 메모만 |
| `confirm` | 초안 | 자재가 하나도 없으면 거부 |
| `start` | 확정 | 제조 기간을 재는 시작점 |
| `done{qty_done, components:[{id, qty_done}], accept_difference, backorder}` | 확정·진행 | 완료. 아래 규칙 |
| `cancel` | 초안·확정·진행 | 완료된 지시는 취소할 수 없다 |
| `set_draft` | 취소 | |
| `delete` | 초안·취소 | |
| `compensate` | 사가 | 아래 되돌리기 |

상태: `draft → confirmed → progress → done`, `cancelled`, `reversed`(사가가 상쇄한 경우).

### 부족해도 막지 않는다

서버는 자재 부족으로 확정, 시작, 완료를 막지 않는다. 기록이 늦었을 뿐 자재가 실제로 있는 일이 있고, 재고 모듈의 일상 운영도 음수를 허용한다(`docs/modules/inventory.md`). 제조는 재고 표를 읽지 않으므로 애초에 판단할 수도 없다. **지시는 자재를 예약하지 않는다.** 대신 화면이 `erp_mrp_need` 와 재고의 `erp_stock_availability` 를 나란히 보여 준다. 필요, 현재고, 가용, 부족, 다음 입고를 줄마다 보여 주고, 완료하면 음수가 된다고 미리 말한다. 재고 쪽에서 보면 자재가 줄어드는 순간 다른 전표의 예약이 최근 것부터 풀리는 기존 규칙을 탄다.

MCP 로는 지시와 명세를 다루지만 재고 수량을 묻는 도구는 없다. 에이전트는 부족을 미리 모르고, 완료 뒤 사가 상태의 `net` 으로 무엇이 움직였는지 확인한다.

### 실제가 계획과 다를 때

`done` 은 실제로 만든 수량과 쓴 양을 받는다.

- 자재를 적지 않으면 `계획 × 완료 수량 / 계획 수량` 을 쓴 것으로 본다.
- 적은 값이 그 값과 다르면 명세의 `consumption` 을 따른다. 지시를 만들 때 옮겨 적은 값이다. `allow` 는 그대로 받고, `ask`(기본값)는 `ERP_CONSUMPTION_DIFF` 로 어느 자재가 얼마나 다른지 말하고 `accept_difference: true` 를 기다리며, `block` 은 `ERP_CONSUMPTION_BLOCKED` 로 막는다.
- 계획보다 적게 만들면 `ERP_BACKORDER_CHOICE` 로 묻는다. `backorder: true` 면 남은 수량으로 새 지시를 확정 상태로 만들고(`backorder_of`), `false` 면 버린다.
- 계획보다 많이 만들어도 묻지 않는다. 자재는 비율을 따른다.
- 0 이하는 거부한다. 쓴 양이 0 인 자재는 된다.

자재 칸의 `qty` 는 계획으로 남고 `qty_done` 이 실제다. 둘 다 이벤트에 실린다.

## 재고와 만나는 곳

| 제조가 내는 것 | 재고가 하는 일 |
|---|---|
| `ManufacturingPlanChanged` | 구매 초안 수량과 같은 합계(`stock_rfq`)에 넣는다. 초안부터 완제품은 `+`, 확정부터 자재는 `-` 다. 그래서 규칙이 같은 부족을 두 번 묻지 않고, 자재의 규칙은 확정 때 바로 반응한다. 요청에 답한다 |
| `ManufacturingDone` | 전표 둘을 만들어 바로 처리한다. 재고 → 생산(자재), 생산 → 재고(완제품). `picking_type` 은 `internal`, `origin_type` 은 `manufacturing_order` 다 |
| `ManufacturingReversed` | 그 전표들을 실제 반품으로 되돌린다 |

재고가 멈춰도 제조는 멈추지 않는다. 지시는 `done` 이 되고 `stock_state` 는 `pending` 으로 남으며, 화면이 그렇게 말한다. 고치면 이어서 한 번만 반영한다. 전표 ID 는 이벤트 번호에서 나오므로 같은 이벤트가 두 번 와도 하나다. 재고가 처리하면 제조가 `PickingValidated` 를 듣고 `stock_state` 를 `applied` 로, `material_cost` 와 `unit_cost` 를 채운다.

재고를 켠 뒤 끌 수는 있다. 그동안 제조는 계속 완료되고 재고는 듣지 못한다. 다시 켤 때 밀린 일을 처리하면 이어 가고, 건너뛰면 그 지시는 `pending` 으로 남는다.

재고의 일자는 일이 끝난 날이다. 재고가 늦게 처리해도 전표와 분개의 날짜는 `ManufacturingDone.date_done` 이다. 잠긴 기간은 `done` 에서 먼저 막는다.

## 재주문 규칙

제조를 켜면 재주문 규칙에 **보충 방식**(`replenish_by`: 구매 `buy`, 제조 `make`) 칸이 생긴다. 칸은 제조가 켜져 있는 동안만 보이고 받는다. 재고는 `buy` 만 안다. 그 밖의 값이면 공급사 없이 요청을 내고 값을 이벤트에 그대로 싣는다(`ReorderRequested.replenish_by`). 공급사를 적어 두어도 싣지 않으므로 구매는 움직이지 않는다.

제조는 `make` 만 듣는다. 그 규칙이 모으는 초안에 더하고(`auto_created`), 없으면 만든다. 사람이 만들던 초안은 건드리지 않는다. 명세가 없어도 요청을 잃지 않는다. 자재 없는 초안이 생기고 확정할 때 이유를 말한다. 한 번 들은 요청은 다시 처리하지 않는다.

제조가 꺼져 있으면 요청이 쌓이고, 재고 쪽 규칙은 하루 뒤 다시 묻는다. 구매가 꺼져 있을 때와 같다. 켤 때 밀린 일을 처리하면 한 초안으로 모인다. 납기 칸은 공급사에서 오므로 `make` 규칙의 예측일은 오늘이다.

규칙을 쓰는 사람은 지금처럼 `inventory`, `purchase` 역할이다. `mrp` 역할은 규칙을 만들 수 없다.

## 원가

**범위는 자재비다.** 노무비, 제조 경비, 배부, 작업장 비용은 넣지 않는다.

- 자재는 재고가 처리하는 순간의 원가로 나간다. 재고 모듈의 일반 출고와 같다.
- 분류가 `average` 면 완제품은 `자재비 합계 / 기준 단위 수량` 으로 들어오고 일반 입고처럼 평균을 옮긴다(소수 6자리).
- 분류가 `standard` 면 완제품은 표준 원가 그대로다. 차이는 회계의 제조원가차이 계정이 받는다. 새 제품의 기본 분류가 표준이고 표준 원가가 0 이면 자재비 전부가 차이로 가므로, 지시 폼이 미리 경고한다.
- `erp_stock` 의 재고 금액은 위에서 정해진 `standard_price` 를 쓴다. 평가 규칙을 새로 만들지 않았다.
- 계획 시점의 예상 자재비는 `erp_mrp_explode` 의 `material_cost` 다. 표준 원가를 자동으로 고치지 않는다.

## 회계

회계 구독은 원래 `PickingValidated` 를 듣는다. 위치 용도로 두 줄을 더했다. 나중에 켠 회계도 같은 전표가 나온다(`test/rebuild-gl.test.mjs`, `test/mrp.test.mjs`).

| 사실 | 전표 |
|---|---|
| 사내 → 생산 | 차변 재공품 / 대변 상품 |
| 생산 → 사내 | 차변 상품 / 대변 재공품 |
| 완제품 전표의 `production_value` 가 위 금액과 다를 때 | 그 차이를 제조원가차이와 재공품 사이에 적어 재공품을 0 으로 맞춘다 |

재고 계정은 지금처럼 `상품` 하나다. 자재와 완제품을 나누면 출고 분개가 함께 바뀌어야 해서 나누지 않았다. 그래서 평균 원가 제조는 `상품` 잔액을 바꾸지 않는다. 재공품은 전표 사이에만 잠깐 있고 지시마다 0 으로 끝난다. 작업 중 재공품 잔액을 월말에 보여 주지 않는다.

새 시드: 계정 `재공품`(169, 유동자산), `제조원가차이`(459, 비용), 위치 `생산`(용도 `production`). 제조를 켜지 않아도 있고, 이미 설치된 회사에는 설치 스크립트를 다시 돌릴 때 들어간다.

## 되돌리기

**일반 되돌리기.** 완료한 작업의 correlation 을 되돌리면 지시가 확정·진행으로 돌아가고, 재고 전표, 평균 원가 변경, 자동 전표, 예측 합계가 모두 함께 돌아간다. 원장에는 처음 일과 `Reverted` 가 모두 남는다. 재고가 아직 듣지 못했으면 커널이 그 이벤트를 건너뛰어 재고는 움직인 적이 없다.

**이미 팔렸으면 막힌다.** 완제품을 되돌리면 재고가 음수가 되는 경우 `quant` 효과의 검사가 막고 어느 제품이 얼마가 되는지 말한다(`ERP_ROLLBACK_BLOCKED`). 일상의 음수는 막지 않아도 되돌리기는 막는 기존 규칙 그대로다. 사가도 마찬가지다.

**사가.** 막는 것이 없으면 `rollback` 이다. 같은 사가에 게시 문서처럼 지울 수 없는 것이 있으면 `compensate` 가 되고, 카탈로그의 `compensate` 명령이 돈다. 끝나지 않은 지시는 취소하고, 완료한 지시는 `ManufacturingReversed` 를 낸다. 재고가 듣고 완제품을 먼저, 자재를 다음에 실제 반품으로 되돌린다. 단가는 나갈 때와 같고 재공품과 제조원가차이도 원래대로 돌아간다. 완제품의 평균 원가는 `(재고 × 평균 − 수량 × 단가) / (재고 − 수량)` 으로 되돌린다. 남는 재고가 없으면 그대로 둔다. 원장과 전표에는 일과 상쇄가 모두 남는다.

`compensate` 는 사가 안에서만 돈다. 완료한 지시에 직접 부르면 거부한다. 사가는 먼저 재고가 받을 수 있는지 묻지만, 직접 부르면 그 검사를 건너뛰기 때문이다.

## 예측과 what-if

원장만 읽는다(M8). 함수는 `sql/70_analytics.sql` 에 있고 모듈을 꺼도 답한다. 되돌렸거나 상쇄한 지시는 빠진다.

| 모델 | 필요한 모듈 | 근거 | 답 |
|---|---|---|---|
| `mrp_lead_time` 실측 제조 기간 | 제조 | 제조 완료 10건 | `erp_mrp_lead_times(p_as_of)`: 제품별 건수와 10·50·90 백분위 일수. 시작(없으면 확정)부터 완료까지 |
| `mrp_materials` 자재 소요 전망 | 제조, 재고 | 제조 완료 10건 | `erp_mrp_materials(p_weeks, p_as_of)`: 현재고, 확정 지시가 쓸 양, 주 평균, 기간 소요와 80% 구간, 이 속도면 소진일 |
| `whatif_production` 생산량 변경 | 제조, 재고 | 제조 완료 10건 | `erp_mrp_whatif(p_variant_id, p_factor, p_as_of)`: 자재마다 주 사용량 변화, 소진일 변화, 효과의 80% 구간 |

- **근거 10건은 판단이다.** 다른 모델처럼 정답을 아는 가상 회사로 재서 정하지 않았다. 입고 10건과 같은 수준으로 두었다. 실제 회사의 정확도는 모른다.
- **주간 집계.** 최근 26주까지 보고, 아무것도 만들지 않은 주는 0 으로 센다. 구간은 평균 ± 1.28 × 표준오차다. 기록이 4주 안 되면 구간이 실제보다 좁다고 화면이 말한다.
- **한 개에 드는 양**은 명세가 아니라 지시들이 실제로 쓴 양이다. 그래서 명세와 달리 낭비가 있으면 what-if 가 그것을 반영한다.
- **오는 입고는 세지 않는다.** 소진일은 "지금 재고가 이 속도로 언제까지 가는가"이고 부족 예측이 아니다. 구매 주문을 원장에서 따라가 더하는 일은 하지 않았다.
- **효과를 구분할 수 없음.** 소진일 변화의 구간이 0 을 포함하면 이렇게 말한다. 배수가 1 이거나, 이 제품을 만드는 속도가 0 일 수도 있을 만큼 들쭉날쭉하면 나온다.
- 꺼져도 이력으로 계산하는 것은 `mrp_lead_time` 이고 `stale_modules` 에 적는다. 나머지 둘은 지금 재고를 알아야 하므로 잠긴다.

## 작업장 `work_center`

`name, code(유일), note`, 그리고 설비 보전이 켜져 있을 때만 보이는 `maintenance_state(available 가동 / maintenance 보전 중), maintenance_note, maintenance_open`. 쓰기는 `mrp` 역할과 관리자다. 지금은 설비가 놓이는 곳을 뜻할 뿐, 지시에 작업장을 고르거나 능력과 일정을 따지지 않는다.

구독 `mrp.maintenance`(`erp.mrp_on_maintenance`)가 설비 보전의 `MaintenanceStarted`, `MaintenanceDone`, `MaintenanceScrapped`, `MaintenanceCancelled` 를 듣는다. 시작이면 그 이벤트의 `work_center_id` 작업장에 요청을 더하고, 끝나면 그 요청을 들고 있던 작업장에서 뺀다. 열린 것이 있으면 보전 중이다. 두 번 들어도 같다. **제조는 설비 보전이 없어도 동작한다**(`requires` 는 여전히 재고 하나다). 설비 보전이 없으면 이 구독은 아무것도 듣지 않는다. 자세한 것은 `docs/modules/maintenance.md`.

## 하지 않는 것

라우팅, 작업장 능력과 일정, 공정별 작업 지시, 제품 수명 주기, 부산물, 키트(가상 BOM), 외주 가공, 일정 계획(MPS), 분해 전용 문서, 부분 진행 수량 보고, 자동 자식 지시, 로트·일련번호 제품, 재고 추적을 끈 소모품 자재, 자재 예약, 노무비·경비 배부, 재공품 잔액 보고. 잘못 완료한 것은 분해 문서 대신 되돌리기로 처리한다.

## 조회

- `erp_mrp_explode(p_variant_id, p_qty, p_uom_id, p_bom_id)`: `{lines:[{depth, variant_id, name, qty, uom_id, has_bom, unit_cost, cost}], material_cost}`.
- `erp_mrp_need(p_components)`: 자재 줄을 재고 기준 단위로 바꾼다. 재고의 답과 나란히 놓기 위한 것이다.

## 이벤트

계약은 `events.md` 에 있다. `BomCreated`, `BomChanged`, `BomArchived`, `BomUnarchived`, `BomDeleted`, `ManufacturingOrderCreated`, `ManufacturingOrderChanged`, `ManufacturingOrderDeleted`, `ManufacturingConfirmed`, `ManufacturingStarted`, `ManufacturingDone`, `ManufacturingCancelled`, `ManufacturingResetToDraft`, `ManufacturingReversed`, `ManufacturingPlanChanged`, `ManufacturingReorderLinked`, `ManufacturingStockApplied`.

## 나중에 켜기, 끄기

- **M6.** 켜기 전의 제조는 원장에 없다. 그 전에 만든 완제품은 재고 조정이나 입고로 넣는다. 켤 때 묻는 것은 없다.
- **M7.** 끄면 메뉴와 명령이 막힌다. 문서, 이력, 보충 방식 값, 쌓인 분석은 남는다. 재고가 지금까지 받은 계획 수량은 남고, 끄는 동안 완료할 방법이 없으므로 그대로 예측에 든다. 필요하면 다시 켜서 지시를 취소한다.

## REST 와 MCP

카탈로그에서 자동으로 나온다. `erp_api_bom`, `erp_api_manufacturing_order` 가 생기고 MCP 도구 4개의 `type` 에 두 유형이 더해진다. 상태 변경은 `erp_update` 의 `values.state`, 완료 수량은 `values.qty_done` 이다. 규칙 거절은 도구 결과로 돌아오므로 에이전트가 그대로 판단한다(`ERP_BACKORDER_CHOICE` 등).

## 화면

메타데이터 화면을 쓴다. 전용 화면은 둘이다. `MrpOrderPanel`: 지시 폼 아래 자재 가용 상태와 단계 펼침, 재고 반영 대기 안내. `MrpOutlookView`(`/mrp/outlook`): 세 모델을 한 화면에.

## 시험과 데모

시험은 `test/mrp.test.mjs`, `test/isolation.test.mjs`, `test/rebuild-gl.test.mjs`, `e2e/tests/mrp.spec.mjs`. 데모는 `web/src/lib/demo/making.ts` 가 자기 난수열과 자기 제품으로 만들어 날짜별로 끼워 넣는다. 그 단계를 뺀 나머지는 이 모듈이 생기기 전 생성기와 바이트 단위로 같고, 판매와 기존 제품의 재고, 손익 계정도 같다(시험이 해시와 실제 DB 로 확인한다).
