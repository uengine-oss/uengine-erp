# 모듈 사이의 이벤트 계약

모듈이 서로 아는 것은 이 문서뿐이다. 필드를 빼거나 뜻을 바꾸면 구독자가 깨지므로 먼저 이 문서를 고친다. 더하는 것은 괜찮다.

## 규칙

- 사실은 이벤트의 `data` 최상위에 싣는다. `set`, `col`, `effects`, `changes` 는 그 스트림 자신을 위한 것이므로 구독자가 읽지 않는다.
- 구독자는 `ev.stream_id` 를 원본 문서 ID 로 쓴다. 수량은 `uom_id` 단위다.
- 구독 처리기는 `fn(ev erp.events) returns void` 다. 같은 이벤트가 두 번 와도 결과가 같아야 한다(커서와 처리 결과는 한 트랜잭션이지만, 건너뛰기·재시도·재설치가 있다).
- 구독 처리기 안에서는 자기 모듈의 문서만 만들고 고친다(`erp.dispatch` 또는 `erp.emit`). 다른 모듈의 표를 읽지 않는다. 필요한 사실이 이벤트에 없으면 이 문서에 추가를 요청한다.
- 처리기는 자기가 만든 문서에 `origin_type`, `origin_id`, `origin_line_id` 를 남긴다.
- `Reverted` 는 요청한 구독자에게만 간다. 되돌려진 작업의 아직 전달되지 않은 이벤트는 커널이 건너뛴다.

## 사가

한 업무를 이루는 호출은 같은 `saga_id`(곧 correlation id)를 쓴다. 되돌리는 방식은 세 가지다.

| `mode` | 뜻 | 일어나는 일 |
|---|---|---|
| `rollback` | 막는 것이 없다 | 범위 전체가 `Reverted` 로 돌아간다 |
| `compensate` | 게시 문서처럼 지울 수 없지만 카탈로그에 `compensate` 가 있다 | 그 명령을 역순으로 실행한다. 구독자가 만든 문서는 그 이벤트를 듣고 따라온다. 출처는 `compensation` 이다 |
| `blocked` | 잠금, 합계 거부, `compensate` 없는 게시 문서 | 아무것도 하지 않고 이유를 돌려준다 |

유형의 카탈로그에 `"compensate": {"command": "...", "params": {...}, "label": "...", "warning": "..."}` 를 두면 된다. 커널은 다른 모듈을 모르고 그 명령을 호출자의 역할로 실행한다. 그래서 **구독자는 보상 명령이 내는 이벤트를 원래 이벤트처럼 처리해야 한다.** 한 번 되돌린 사가에는 새 호출이 합류할 수 없다(`ERP_SAGA_CLOSED`).

## 판매가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `SalesOrderConfirmed` | `number, partner_id, partner_name, delivery_partner_id, region, warehouse_id, shipping_policy, commitment_date, date_order, currency, amount_untaxed, amount_tax, amount_total, lines:[{line_id, product_id, variant_id, name, qty, uom_id, lead_days, unit_price, discount, subtotal, cost, type, invoice_policy}]` |
| `SalesOrderLineAdded` | 확정 뒤 추가. `line:{...위와 같은 줄}, warehouse_id, partner_id, number` |
| `SalesOrderLineQtyChanged` | 확정 뒤 수량 변경. `line_id, variant_id, product_id, from, to, uom_id, name, type, warehouse_id, partner_id, number` |
| `SalesOrderCancelled` | `number, partner_id, was, reason` |
| `SalesOrderDelivered` | 납품 수량이 바뀔 때. `lines:[{line_id, qty_delivered}]`. `manual: true` 는 사람이 적은 납품이고, 이때 줄에 `qty, uom_id, variant_id, product_id, name, type` 도 싣는다 |

`warehouse_id` 는 재고 모듈이 꺼져 있으면 `null` 이고, 그때는 기본 창고를 쓴다. `region` 은 납품처의 지역이고 없으면 거래처의 지역이다.

## 구매가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PurchaseOrderConfirmed` | `number, partner_id, partner_name, warehouse_id, date_order, date_planned, currency, amount_untaxed, amount_tax, amount_total, lines:[{line_id, product_id, variant_id, name, qty, uom_id, unit_price, discount, subtotal, type, bill_policy, date_planned, delay_days}]` |
| `PurchaseOrderLineAdded` | `line:{...}, warehouse_id, partner_id, number, date_order` |
| `PurchaseOrderLineQtyChanged` | `line_id, variant_id, product_id, from, to, uom_id, name, type, unit_price, discount, warehouse_id, partner_id, number` |
| `PurchaseOrderLinePriceChanged` | 입고 전 가격 변경. 입고 원가에 반영된다 |
| `PurchaseDraftQtyChanged` | 초안 수량. 재고 예측에 들어가고 보충 요청에 답한다 |
| `PurchaseOrderCancelled` | `number, partner_id` |

## 재고가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PickingStateChanged` | 전표 상태가 바뀔 때마다. `number, picking_type, origin_type, origin_id, state, is_return, partner_id, scheduled_date, lines:[{origin_line_id, variant_id, demand, done}]` |
| `PickingValidated` | `number, picking_type, origin_type, origin_id, is_return, to_refund, partner_id, warehouse_id, date_done, moves:[{move_id, origin_line_id, product_id, variant_id, name, qty_done, uom_id, location_from, location_to, lot_id, unit_cost, cost_method}]` |
| `StockAdjusted` | `variant_id, product_id, location_id, warehouse_id, lot_id, delta, unit_cost, counted_qty, accounting_date` |
| `StockScrapped` | `variant_id, product_id, location_id, warehouse_id, lot_id, qty, unit_cost` |
| `ReorderRequested` | 요청별 문서 스트림(되돌릴 때 같은 제품의 다른 요청이 끌려오지 않게). `rule_id, variant_id, product_id, location_id, warehouse_id, qty, uom_id, vendor_id, origin, replenish_by`. `replenish_by` 는 구매면 `buy` 이고 `vendor_id` 가 있다. 그 밖의 값은 재고가 뜻을 모른 채 싣는 말이고 `vendor_id` 는 `null` 이다. 듣는 모듈이 자기 값만 처리한다 |

재고 수량 변화는 전부 `data.effects.quant = [{variant_id, location_id, lot_id, qty, reserved}]` 에 실린다. 분석은 이것을 읽는다.

제조에서 온 전표는 `origin_type` 이 `manufacturing_order` 이고 `picking_type` 이 `internal` 이며 위치 한쪽이 용도 `production` 이다. 완제품 쪽 전표의 `PickingValidated` 에는 `production_value`(자재비 합계)가 더 있고 그 이동의 `origin_line_id` 는 `finished` 다.

## 청구가 내는 것

줄 공통: `lines:[{line_id, origin_line_id, product_id, variant_id, name, qty, uom_id, price_unit, discount, subtotal, tax_amount, total, taxes:[{tax_id, name, amount, base, account_id, vat_class}], is_downpayment, downpayment_line_id, account_id, fixed_asset}]`. `vat_class` 는 `taxable`, `zero`, `exempt` 또는 없음이다. 게시 시점의 값이 실리므로 뒤에 세금 설정을 고쳐도 지난 칸은 움직이지 않는다.

| 이벤트 | `data` 의 사실 |
|---|---|
| `InvoiceDrafted` | 초안이 생기거나 바뀔 때. `move_type, origin_type, origin_id, partner_id, reversal_of, lines` |
| `InvoicePosted` | `move_type, number, origin_type, origin_id, partner_id, partner_name, partner_tax_id, region, date, invoice_date, due_date, installments, currency, fiscal_position_id, journal_id, journal_account_id, amount_untaxed, amount_tax, amount_total, reversal_of, lines, evidence, stock_reflect, stock_warehouse_id` |
| `InvoiceResetToDraft` | `move_type, number, origin_type, origin_id, partner_id, lines, stock_reflect` |
| `InvoiceCancelled` | 초안 또는 게시 취소. `move_type, number, origin_type, origin_id, partner_id, lines, stock_reflect` |
| `InvoiceEvidenceSet` | 게시 뒤에 증빙을 적었을 때. `posted, move_type, number, date, invoice_date, partner_id, partner_name, partner_tax_id, amount_untaxed, amount_tax, amount_total, reversal_of, lines, evidence`. 금액은 움직이지 않는다 |
| `PaymentPosted` | `payment_type, partner_type, number, partner_id, amount, date, journal, journal_id, journal_account_id, payment_method_id, allocations:[{move_id, amount}], unallocated, writeoff_amount, writeoff_account_id, writeoff_label, early_discount, writeoff_taxes` |
| `PaymentCancelled` | `payment_type, partner_type, number, partner_id, amount, date, journal, allocations` |
| `InvoicePaymentApplied` | 청구서 스트림. `payment_id, credit_move_id, amount, residual, payment_state, partner_id, due_date, date`. 맞물림을 풀면 같은 이벤트가 음수 `amount` 로 나간다 |
| `BankLineBooked` | 은행 거래 스트림. 문서 없이 계정으로 처리한 돈. `date, amount, account_id, journal_account_id, journal_id, partner_id, name`. `amount` 는 들어온 돈이 양수다 |
| `BankLineUnbooked` | 그 처리를 풀었을 때. `date, journal_id` |

세금 분배가 있는 세금은 줄의 `taxes[]` 에 `gross, repartition:[{account_id, amount, grids, factor_percent}], base_grids` 를 더 싣는다. `amount` 는 줄에 남는 세액이다(역과세면 0). `account_id` 가 비면 그 몫은 줄의 계정으로 간다. `InvoicePosted` 의 대변 메모는 대변 메모 분배로 나간다.

청구는 초안일 때부터 `qty` 를 알린다. 판매와 구매의 `qty_invoiced`·`qty_billed` 는 초안 시점에 움직인다.

### 증빙과 재고 반영

`evidence` 는 `{type, approval_no, deductible, non_deduct_reason, card_kind, amend_reason, original_date, original_approval_no}` 이고 없는 칸은 빠진다. 증빙이 없는 문서는 `{}` 다. `type` 은 `tax_invoice`, `exempt_invoice`, `credit_card`, `cash_receipt`, `other_receipt`, `none` 이다.

**이 필드가 생기기 전의 이벤트에는 `evidence` 가 없다.** 구독자는 없는 것을 빈 것과 같게 읽고 추정하지 않는다. 사람이 `set_evidence` 를 부르면 `InvoiceEvidenceSet` 이 전체 사실과 함께 나온다.

공제받지 않는 세금은 `taxes[]` 에 `non_deductible: true` 와 계정이 빈 `repartition` 을 싣는다. 회계는 기존 규칙대로 그 몫을 줄의 계정으로 보낸다.

`stock_reflect: true` 면 줄의 제품이 움직여야 한다는 뜻이다. 재고 구독자가 매입(`in_invoice`)은 입고, 매출(`out_invoice`)은 출고를 만들어 곧바로 처리한다. `reversal_of` 가 있는 대변 메모와 `InvoiceResetToDraft`, `InvoiceCancelled` 는 그 문서가 만든 전표를 줄의 수량만큼 되돌린다. 처리할 수 없으면(재고 부족, 로트 미지정, 잠긴 날) 전표가 사람을 기다리고 구독자는 멈추지 않는다.

### 선금

청구가 `method: percentage|fixed` 로 만든 선금 청구서는 `InvoiceDrafted` 줄에 `is_downpayment: true`, `origin_line_id: null` 을 싣고 `line_id` 를 고정한다. 판매는 이 줄을 받아 주문에 `is_downpayment` 줄을 하나 더하되, `invoice_line_id` 로 중복을 막는다. 일반 청구서를 만들 때 청구는 `erp.peek` 로 주문의 선금 줄을 읽어 음수 줄(`origin_line_id` = 주문의 선금 줄)로 차감한다.

## 세금 신고가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `VatFiled` | `vat_return` 스트림. `year, term, kind, from, to, cells, totals`. 칸 번호와 뜻은 `krtax.md` 다. `totals` 는 `{ga, na, da, prior_refund, payable, payable_rounded}` 이다 |

자기 집계 `vat_entry` 의 `VatEntryRecorded`, `VatEntryWithdrawn` 은 계약이 아니다.

## 회계가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `JournalEntryPosted` | 전표 스트림. 효과 `gl = [{account_id, partner_id, date, debit, credit}]`. 분석의 기간은 `occurred_at` 이 아니라 효과의 `date` 로 거른다(회계를 늦게 켜면 전표 시각은 다시 만든 시점이다) |

## 인사가 내는 것

직원 이벤트의 공통 사실: `employee_no, name, hire_date, department_id, department_name, department_since, job_title, manager_id, manager_name, manager_user_id, member_id, user_id`. 직원 ID 는 `ev.stream_id` 다. `user_id` 는 ERP 계정이 있는 직원의 사용자 ID 이고 없으면 `null` 이다. 날짜는 `YYYY-MM-DD` 다.

| 이벤트 | `data` 의 사실 |
|---|---|
| `EmployeeHired` | 공통 사실. 입사일이 앞날일 수 있다. 다시 입사는 새 직원 ID 의 `EmployeeHired` 다 |
| `EmployeeChanged` | `changed:{칸:{from, to}}` + 바뀐 뒤의 공통 사실. `changed` 칸은 `employee_no, name, hire_date, department_id, department_since, job_title, manager_id, member_id, user_id` |
| `EmployeeLeft` | `leave_date` + 공통 사실. 퇴사일이 오늘이거나 지난 날짜다. 앞날의 퇴사는 이벤트가 되지 않는다. 사유는 없다 |
| `EmployeePrivateChanged` | `employee_id, name, fields:[칸 이름]`. **값은 없다.** `stream_id` 는 직원이 아니라 기록 스트림이므로 `employee_id` 를 쓴다 |
| `EmployeePrivateErased` | `employee_id, name, fields:[칸 이름], erased_at`. 사유는 이벤트의 `reason` 이다 |
| `DepartmentCreated`, `DepartmentArchived`, `DepartmentUnarchived`, `DepartmentDeleted` | `name` |
| `DepartmentChanged` | `name, changed:{칸:{from, to}}` |

연락처, 생년월일, 계좌 같은 개인정보는 어떤 이벤트에도 없다. 원장은 지울 수 없기 때문이다. 필요한 모듈은 패턴을 따른다(`docs/modules/hr.md`). **이름과 입퇴사일은 원장에 남고 지워지지 않는다.**

## 급여가 내는 것

**한 사람의 금액, 계좌, 가족 수는 어떤 이벤트에도 없다.** 회사 합계와 전표·원천세 집계에 필요한 합계만 있다. 대장에 사람이 한 명이면 합계가 그 사람의 금액이라는 한계는 `docs/modules/payroll.md` 에 적었다. `payroll_run` 스트림은 `hr`, `payroll`, `admin` 만 읽는다. 구독자는 RLS 와 무관하게 받는다.

| 이벤트 | `data` 의 사실 |
|---|---|
| `PayrollRunDrafted` | `number, kind(regular, bonus, correction, reversal), period_month, pay_month, pay_date, reversal_of, corrects`. 금액 없음. 초안의 합계는 원장에 쓰지 않는다 |
| `PayrollPosted` | `number, kind, period_month, pay_month, pay_date, date(회계일), reversal_of, corrects, headcount, gross_total, nontaxable_total, taxable_total, deduction_total, net_total, statutory:{income_tax, local_tax, pension, health, ltc, employment, other}, by_income:[{income_code, label, people, people_delta, gross, nontaxable, income_tax, local_tax}], entry:[{key, name, account_id, amount}], rates:{id, name, valid_from, source, source_url, checked_on, 요율 값}, tax_table:{id, name, valid_from, source, source_url, checked_on, sha256, rows_count}`. 취소 대장은 같은 이벤트에 음수다 |
| `PayrollPaid` | `number, period_month, pay_month, date, amount, account_id, reversal_of, entry:[{key, name, account_id, amount}]`. 취소 대장은 음수다 |
| `PayrollRunReversed` | 원래 대장 스트림. `set.reversed_by` 만 있다. 취소 대장의 `PayrollPosted` 가 사실을 싣는다 |
| `PayrollRunCancelled` | 초안 취소. 사실 없음 |
| `PayrollTransferExported` | `number, format_id, format_name, rows`. 값 없음 |
| `WithholdingFiled` | 지급 월별 스트림. `number, pay_month, sheets:[{period_month, pay_month, lines, total, local}], revision, previous_sheets` |
| `WithholdingReopened` | `pay_month, revision`. 사유는 이벤트의 `reason` 이다 |
| `PayrollProfileChanged`, `PayrollProfileErased` | `employee_id, name, fields:[칸 이름]`, 지운 때는 `erased_at`. **값 없음** |
| `PayrollSlipChanged`, `PayrollSlipAdded`, `PayrollSlipRemoved`, `PayrollSlipErased` | 대장별 기록 스트림. `run_id, employee_id, name`, 고친 때는 `fields:[칸 이름]`. **값 없음** |

`entry` 의 `key` 는 `wages`, `withheld`, `payable`, `bank` 다. `amount` 는 양수가 차변이다. 합은 0 이다. `account_id` 가 비면 회계가 `key` 로 계정을 고른다. `people_delta` 는 이 대장으로 그 귀속·지급 월의 그 소득 구분 인원이 달라진 수다. 합하면 서식의 인원이 된다.
## 제조가 내는 것

지시 이벤트의 공통 사실: `number, variant_id, product_id, name, qty, uom_id, warehouse_id, bom_id, origin, date_planned, components:[{line_id, variant_id, product_id, name, qty, qty_done, uom_id}]`. 지시 ID 는 `ev.stream_id` 다. `qty` 는 계획이고 `qty_done` 은 실제다. 수량은 각자의 `uom_id` 단위다.

| 이벤트 | `data` 의 사실 |
|---|---|
| `BomCreated`, `BomChanged` | `name, variant_id, product_id, output_qty, uom_id, lines:[{line_id, variant_id, product_id, name, qty, uom_id}]`. 줄이 `output_qty` 만큼 만드는 데 드는 양이다 |
| `ManufacturingOrderCreated`, `ManufacturingOrderChanged`, `ManufacturingConfirmed`, `ManufacturingResetToDraft` | 공통 사실 |
| `ManufacturingStarted` | `date_started` + 공통 사실 |
| `ManufacturingDone` | `qty_done, date_done, date_confirmed, date_started` + 공통 사실. **재고가 듣고 자재를 줄이고 완제품을 늘린다.** 효과를 싣지 않는다 |
| `ManufacturingCancelled` | `was` + 공통 사실 |
| `ManufacturingReversed` | 공통 사실. 사가가 완료한 지시를 상쇄할 때. 재고가 듣고 실제 반품으로 되돌린다 |
| `ManufacturingPlanChanged` | `number, warehouse_id, lines:[{line_id, variant_id, product_id, name, qty, uom_id}], requests:[요청 ID]`. 수량은 제품 기준 단위이고 지금 열린 전체다. 완제품은 양수(`line_id: "finished"`), 자재는 음수이며 끝나면 빈 목록이다. 초안에는 자재가 없다 |
| `ManufacturingStockApplied` | `number, picking_id, picking_number, is_return`. 재고가 움직였음을 지시에 남긴 것 |

## 기초데이터가 내는 것

| 이벤트 | `data` 의 사실 |
|---|---|
| `PartnerMerged` | `into`(대상 거래처) |
| `ProductCostChanged` | `variant_id, product_id, from, to, reason`. 재고 모듈이 기초데이터 명령으로 일으킨다 |

## 구독 관계

발행자는 이 표를 모른다. 어느 칸이 비어도 동작해야 한다.

| 구독자 | 듣는 이벤트 | 하는 일 |
|---|---|---|
| 재고 | `SalesOrderConfirmed`, `SalesOrderLineAdded`, `SalesOrderLineQtyChanged`, `SalesOrderCancelled`, `SalesOrderDelivered`(`manual` 만) | 출고 전표. 손으로 납품한 만큼 열린 전표가 줄고, 남은 것이 없으면 취소된다 |
| 재고 | `PurchaseOrderConfirmed`, `PurchaseOrderLineAdded`, `PurchaseOrderLineQtyChanged`, `PurchaseOrderLinePriceChanged`, `PurchaseOrderCancelled`, `PurchaseDraftQtyChanged` | 입고 전표, 예측 |
| 재고 | `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled`(`stock_reflect` 만) | 전표 입력의 입출고와 그 반품 |
| 재고 | `ManufacturingPlanChanged`, `ManufacturingDone`, `ManufacturingReversed` | 예측 합계와 요청 응답, 자재와 완제품 전표, 반품. 제조는 이것을 모른다 |
| 제조 | `ReorderRequested`(`replenish_by` 가 `make` 인 것만) | 지시 초안 |
| 제조 | `PickingValidated`(`origin_type` 이 `manufacturing_order` 인 것만) | 재고 반영 여부, 자재비, 완제품 단가 |
| 판매 | `PickingStateChanged`, `PickingValidated` | 납품 상태, `qty_delivered` |
| 판매 | `InvoiceDrafted`, `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled` | 청구 상태, `qty_invoiced` |
| 판매 | `ModuleEnabled` | 재고·청구가 켜진 시점을 기록해 그 뒤의 주문만 추적 대상으로 본다 |
| 구매 | `ReorderRequested` | 견적 요청 초안 |
| 구매 | `PickingStateChanged`, `PickingValidated` | 입고 상태, `qty_received` |
| 구매 | `InvoiceDrafted`, `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled` | 청구 상태, `qty_billed` |
| 회계 | `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled`, `PaymentPosted`, `PaymentCancelled`, `BankLineBooked`, `BankLineUnbooked` | 분개(처음부터 다시 읽는다) |
| 회계 | `PickingValidated`, `StockAdjusted`, `StockScrapped` | 재고 평가 분개(처음부터 다시 읽는다) |
| 세금 신고 | `InvoicePosted`, `InvoiceResetToDraft`, `InvoiceCancelled`, `InvoiceEvidenceSet` | 신고서 칸(처음부터 다시 읽는다) |
| 회계 | `PayrollPosted`, `PayrollPaid` | 급여와 예수금, 지급 분개(처음부터 다시 읽는다) |
| 급여 | `EmployeeHired`, `EmployeeChanged`, `EmployeeLeft` | 직원 사본, 입퇴사 목록(처음부터 다시 읽는다) |
| 급여 | `AttendanceClosed` | 명세서의 근무 시간. 근태가 없으면 사람이 적는다 |
| 급여 | `Reverted` | 되돌린 입퇴사와 근태 마감을 지운다 |
| 인사 | 없음 | 아무 이벤트도 듣지 않는다 |
| 분석 | 원장 전체 | 구독하지 않고 직접 읽는다 |
