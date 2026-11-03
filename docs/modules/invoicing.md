# 청구 (`sql/60_invoicing.sql`)

모듈 `invoicing`, 정렬 40. 청구서·공급사 청구서·대변 메모·입금·미수금을 다룬다. **전표를 만들지 않는다.** 사실을 이벤트로 남기면 끝이고, 분개는 회계 모듈이 그 이벤트를 받아 만든다. 판매·구매·재고·회계가 모두 꺼져 있어도 동작한다.

켤 때 옵션 `orders_since`: 이 날짜 이후의 판매 주문만 청구 대상으로 본다. `from_sales_order` 와 `erp_invoice_targets` 에서만 쓴다(구매 주문은 대상 조회에서만 걸러지고 `from_purchase_order` 는 막지 않는다). 주문의 청구 상태는 판매 모듈 몫이다. 모듈을 껐다 옵션 없이 다시 켜도 값은 유지된다.

## `account_move`

`move_type(out_invoice/out_refund/in_invoice/in_refund), number, partner_id, invoice_date, date, due_date, payment_term_id, fiscal_position_id, currency, ref, payment_reference, narration, incoterm, incoterm_place, partner_bank, should_be_paid(yes/no/exception), origin_type, origin_id, origin_name, auto_post, state(draft/posted/cancelled), payment_state(not_paid/in_payment/paid/partial/reversed), reversal_of, reversed_by, reversal_reason, debit_note_of, installments[{due_date, amount, discount_date, discount_amount, discount_mode}], applied[{id, payment_id, credit_move_id, amount, date, reversal}], amount_untaxed, amount_tax, amount_total, amount_residual, lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, account_id, subtotal, tax_amount, total, taxes, origin_line_id, is_downpayment, downpayment_line_id}]`

번호 형식: `INV/2026/00001`, `RINV/2026/00001`, `BILL/2026/10/0001`, `RBILL/2026/10/0001`. 회계일의 연·월로 게시할 때 붙고, 다시 초안으로 가도 유지된다.

| 명령 | 뜻 |
|---|---|
| `create` | 직접 작성. 또는 `{from_sales_order, method(regular/percentage/fixed), amount, deduct_downpayments, line_ids}`, `{from_purchase_order}`, `{from_move}`(줄 복사) |
| `update` | 초안만. 화면이 줄 전체를 보내도 `InvoiceLineAdded/Changed/Removed` 로 나뉜다. 바뀐 게 없으면 이벤트도 없다 |
| `post` | 초안 → 게시. 줄이 없으면 `ERP_NO_LINES`, 총액이 음수면 `ERP_NEGATIVE_TOTAL`. 총액 0 이면 바로 `paid`. 고객 청구서는 청구일이 비면 그날로 채우고, 공급사 문서는 청구일이 없으면 `ERP_REQUIRED` |
| `reset_to_draft` | 게시·취소 → 초안. 번호 유지. 맞물린 입금과 대변 메모는 떨어진다 |
| `cancel` | 초안·게시 → 취소. 번호 유지. 맞물린 입금과 대변 메모는 떨어진다 |
| `delete` | 번호가 붙은 적 없는 문서만. 번호가 있으면 `ERP_NUMBERED`(빈 번호를 만들지 않는다) |
| `reverse{mode, reason, date}` | `reverse` 는 대변 메모 초안. `reverse_and_create` 는 맞물린 것을 떼고 전액 대변 메모를 게시한 뒤 같은 내용의 새 초안을 만든다. 게시 문서만 |
| `debit_note{reason, date, copy_lines}` | 같은 거래처에 청구서 초안. 주문과의 연결은 끊는다 |
| `apply_credit{credit_move_id, amount}`, `remove_credit{credit_move_id}` | 대변 메모를 다른 청구서에 맞추거나 푼다 |

`date`(회계일)는 비우면 청구일을 따른다. 초안으로 돌아갈 때 청구일과 같았다면 다시 비워서 청구일을 고치면 함께 움직인다.

## 주문에서 만들기

`erp.peek` 로 주문을 읽는다. 판매 표나 함수를 부르지 않는다. 주문이 없거나 그 모듈이 꺼져 있으면 `ERP_NOT_FOUND`, 확정 전이면 `ERP_INVALID`.

- 청구 대상은 `주문 수량 - 이미 청구한 수량`(`invoice_policy=order`) 또는 `납품 수량 - 이미 청구한 수량`(`delivery`). 구매는 `bill_policy` 의 `order`, `receipt` 로 같다.
- **이미 청구한 수량은 이 모듈 자기 문서에서 센다.** 주문의 `qty_invoiced` 는 버스로 뒤늦게 움직이므로 믿으면 두 번 눌렀을 때 두 번 청구된다. 초안도 세고 대변 메모는 뺀다. 같은 주문의 동시 생성은 잠금으로 줄을 세운다.
- 청구할 것이 없으면 `ERP_NOTHING_TO_INVOICE`. 음수는 진짜다(반품 뒤). 합계가 음수면 줄의 수량 부호를 뒤집어 대변 메모로 만든다.
- 구역·메모 줄은 함께 옮긴다. 거래처는 `invoice_partner_id`, 없으면 `partner_id`. 결제 조건과 세금 조정은 주문, 없으면 거래처. 통화는 주문을 따른다.

## 선금

`method: percentage|fixed` 로 만든 청구서의 줄은 `is_downpayment: true`, `origin_line_id: null` 이다. 판매는 이 줄을 받아 주문에 선금 줄을 더한다.

- 비율은 세금별로 묶어 각 묶음의 공급가에 곱한다. 정액은 세금 포함 금액이고, 끝수는 첫 세금에 얹어 합계를 정확히 맞춘다(세금이 없으면 단가에). 0 이하는 거부, 100% 나 주문 총액을 넘는 것은 통과한다.
- 일반 청구서는 아직 차감되지 않은 선금을 모두 수량 -1 줄로 뺀다. 초안 선금도 뺀다. 차감 줄의 `origin_line_id` 는 주문의 선금 줄이고, 주문이 아직 그 줄을 모르면 선금 청구서의 줄 id 다(`null` 이면 새 선금으로 읽힌다). `downpayment_line_id` 는 언제나 선금 청구서의 줄 id 다.
- 주문에만 있고 이 모듈 문서에 없는 선금 줄도 `qty_invoiced` 만큼 뺀다.
- 합계가 음수가 되면 대변 메모로 만든다. 선금 100% 뒤의 최종 청구는 0원이고 게시하면 바로 `paid` 다. 선금에 대변 메모를 만들면(초안부터) 그 선금은 차감 대상에서 빠진다.

## 대변 메모

- 게시하면 원 문서의 남은 금액까지 자동으로 맞물린다. 전액이면 원 문서 `reversed`, 대변 메모 `paid`. 입금이 먼저 있었으면 원 문서는 `paid`, 대변 메모에 남은 금액은 `partial`. 완납 문서에는 맞물리지 않고 환불 지급 대상으로 남는다.
- `reset_to_draft` 를 하면 맞물림이 풀린다. 대변 메모를 다시 게시하면 다시 맞물리지만 원 청구서를 다시 게시해도 저절로 맞물리지 않는다.
- `reverse` 의 `date` 가 미래면 `auto_post=at_date` 가 붙는다. 그 전까지 `post` 는 `ERP_AUTO_POST` 로 거부되고, 그날 `erp.inv_auto_post_due()` 가 게시한다. pg_cron 이 있으면 매시간 돌고, 없으면 앱이 `erp_invoice_auto_post()` 를 부른다. 미래 날짜를 직접 넣은 일반 문서는 그대로 게시된다.

## `payment`

`number(PAY/2026/00001), payment_type(inbound/outbound), partner_type(customer/supplier), partner_id, amount, date, journal(bank/cash), memo, writeoff_amount, writeoff_account_id, writeoff_label, early_discount, state(draft/in_process/paid/rejected/cancelled), allocations[{id, move_id, amount}], unallocated`

| 명령 | 뜻 |
|---|---|
| `create` | `{allocations}` 가 있거나 `post: true` 면 바로 게시, 아니면 초안 |
| `create{from_moves, group, amount, date, ...}` | 문서에서 입금 등록. 기본은 문서마다 한 건. `group: true` 면 거래처별로 묶고, 대변 메모를 먼저 청구서에 맞춘 뒤 남은 금액만 낸다. 고객 문서와 공급사 문서를 섞으면 `ERP_INVALID`, 낼 것이 없으면 `ERP_NOTHING_TO_PAY` |
| `post` | 초안 → 처리 중. 배분은 이때 잠금 아래서 정한다 |
| `cancel` | 배분을 풀고 취소. 거기 맞물린 청구서가 다시 열린다 |
| `reset_to_draft` | 취소 → 초안 |
| `reject`, `validate` | 표시만 바꾼다. 청구서와 금액은 그대로이고 정말 되돌리려면 `cancel` 한다 |
| `allocate{move_id, amount}`, `unallocate{move_id}` | 미배분 금액을 문서에 맞추거나 푼다. 푼 돈은 미배분으로 남는다 |
| `delete` | 번호가 붙은 적 없는 초안·취소만 |

- 상태: 맞춘 문서가 전부 끝나면 `paid`, 아니면 `in_process`. 맞춘 문서가 없으면 `in_process`. 남은 미배분이 있어도 `paid` 일 수 있고, 그 돈을 새 문서에 맞추면 `in_process` 로 돌아간다.
- 초과 입금은 문서를 끝내고 나머지를 `unallocated` 로 둔다. 새 문서에 저절로 쓰이지 않는다. `erp_outstanding(partner_id, side)` 가 쓸 수 있는 미배분 입금과 대변 메모를 보여 준다.
- 초안 문서에 대한 입금은 받아 두되 맞추지 않는다.
- 거래처가 같아야 맞출 수 있다. 합쳐진 연락처는 같은 거래처로 본다. 문서의 `partner_id` 는 그대로다.
- 금액을 안 주면 다음 할부 금액이다. 여러 문서면 남은 금액 전부다. `erp_preview('payment', {from_moves, date})` 가 제안 금액을 돌려준다.
- 탈락: `writeoff_amount` 는 문서를 끝내는 데 쓰인 만큼만 넣을 수 있다.
- 조기 할인: 할부 한 줄이고 입금 전이고 결제일이 `discount_date` 안이면 제안 금액이 `discount_amount` 이고, 그 금액을 내면 차액이 `writeoff_amount`, `early_discount: true` 가 된다. `included` 면 `writeoff_taxes` 에 세금 몫을 싣는다. 기한이 지난 뒤 할인액만 내면 부분 입금이다.

## 이벤트

줄 공통과 `InvoicePosted` 등은 `events.md` 그대로다. 더한 것:

| 이벤트 | 더한 필드 |
|---|---|
| 줄 공통 | `downpayment_line_id`. `taxes[].account_id` |
| `InvoiceDrafted` | `reversal_of` |
| `InvoicePosted` | `invoice_date`, `installments` |
| `InvoicePaymentApplied` | `credit_move_id`(대변 메모가 맞물렸을 때 상대 문서, 이때 `payment_id` 는 없다). 맞물림을 풀면 같은 이벤트가 **음수 `amount`** 로 나간다. 합치면 지금 상태와 같다 |
| `PaymentPosted` | `partner_type`, `writeoff_label`, `early_discount`, `writeoff_taxes[{tax_id, name, account_id, amount}]` |
| `PaymentCancelled` | `partner_type`. 초안을 취소했으면 `allocations` 는 빈 목록이다 |

이 모듈 안에서만 쓰는 이벤트: `InvoiceCreated`, `InvoiceUpdated`, `InvoiceLineAdded/Changed/Removed`, `InvoiceReversalLinked`, `PaymentCreated`, `PaymentUpdated`, `PaymentStateChanged`, `PaymentAllocated`, `PaymentAllocationRemoved`, `PaymentRejected`, `PaymentValidated`, `PaymentResetToDraft`, `PaymentDeleted`. 번호 없는 초안 삭제는 `InvoiceCancelled` 로 나간다(그 초안을 세던 주문이 알아야 한다).

## 되돌리기

게시된 청구서와 게시된 입금은 `revert_blocked_states` 로 막는다. 대변 메모나 입금 취소로 정정한다. 초안 작성, 게시 뒤 초안 복귀는 되돌릴 수 있다.

## 조회

- `erp_aged(kind, at)`: `receivable`, `payable`. 거래처별 `not_due, d1_30, d31_60, d61_90, over_90, total`. 남은 금액을 오래된 할부부터 채워 할부별 만기로 나눈다. 대변 메모는 빼고 미배분 입금은 입금일 기준으로 뺀다. `at` 을 주면 그날 끝의 원장 상태로 계산한다. 합쳐진 연락처는 대상 거래처로 묶는다. `receivable` 은 `accounting`·`sales`, `payable` 은 `accounting`·`purchase` 가 읽는다.
- `erp_invoice_targets(kind, limit)`: `sales`, `purchase`. 원장의 주문 확정 이벤트로 주문을 찾고 `erp.peek` 로 읽어 청구할 것이 남은 주문을 돌려준다.
- `erp_outstanding(partner_id, side)`, `erp_invoice_number_gaps()`(취소된 번호와 빠진 번호).
- `erp_auto_reconcile(mode, partner_id)`: `same_amount` 는 금액이 같은 입금·대변 메모와 문서를 짝짓고, `all` 은 거래처의 크레딧을 오래된 문서부터 모두 쓴다.
- `erp_preview('account_move', ...)`: 저장 없이 줄과 합계를 계산한다.

## 시험과의 대응

`test/invoicing.test.mjs`. 판매·구매는 시험 안에서 만든 레코드와 이벤트로 흉내 낸다.

외화는 환산하지 않는다. `currency` 는 표시용이고 금액은 회사 통화로 본다.
