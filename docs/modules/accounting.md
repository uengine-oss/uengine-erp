# 회계 (`sql/60_accounting.sql`)

`account_move`: `move_type(out_invoice/out_refund/in_invoice/in_refund/entry), number(INV/2026/00001, RINV/.., BILL/.., RBILL/.., MISC/..), partner_id, invoice_date, due_date, payment_term_id, fiscal_position_id, origin_type, origin_id, origin_name, ref, payment_reference, narration, state(draft/posted/cancelled), payment_state(not_paid/in_payment/paid/partial/reversed), should_be_paid(yes/no/exception), amount_untaxed, amount_tax, amount_total, amount_residual, reversal_of, reversed_by, installments[{due_date, amount}], lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, subtotal, tax_amount, total, account_id, origin_line_id, is_downpayment}]`

명령: `create update post reset_to_draft cancel reverse delete`.
- `create{from_sales_order, method(regular/percentage/fixed), amount}`: 주문에서 청구서 생성. 선금은 주문에 `is_downpayment` 줄을 만들고, 일반 청구서가 음수 줄로 차감한다.
- `create{from_purchase_order}`: 주문에서 공급사 청구서 생성.
- `reverse{mode(reverse/reverse_and_create), reason, date}`: 대변 메모.

| 이벤트 | 계약 |
|---|---|
| `InvoiceCreated`, `InvoiceUpdated`, `InvoiceLine*`, `InvoiceResetToDraft`, `InvoiceCancelled` | |
| `InvoicePosted` | `{move_type, number, origin_type, origin_id, partner_id, date, lines:[{line_id, origin_line_id, qty, subtotal, is_downpayment}], gl:[{account_id, partner_id, debit, credit, name}]}` |
| `InvoicePaymentApplied` | `{payment_id, amount, residual, payment_state}` |
| `PaymentPosted`, `PaymentCancelled`, `PaymentAllocated` | `gl` 포함 |

- `payment`: `payment_type(inbound/outbound), partner_id, amount, date, journal(bank/cash), memo, state(draft/posted/cancelled), allocations[{id, move_id, amount}], unallocated, writeoff_amount, writeoff_account_id`. 부분 결제 후 "완납 처리"는 차액 대손·에누리 분개로 처리한다. 미배분 금액은 고객 크레딧으로 남고 나중에 배분한다.
- 파생 표 `erp.gl_lines(event_seq, move_id, date, account_id, partner_id, debit, credit, name)`. 차변과 대변이 다르면 게시 불가(`ERP_UNBALANCED`).
- 보고서 함수: `erp_trial_balance(from, to)`, `erp_aged(kind, at)`, `erp_general_ledger(account, from, to)`, `erp_profit_loss(from, to)`, `erp_balance_sheet(at)`.
- 게시된 청구서는 `reset_to_draft` 뒤에만 고친다(번호 유지). `reversed` 이면 `payment_state='reversed'`.
- 판매 쪽 react: `InvoicePosted`(`origin_type='sales_order'`) → 줄 `qty_invoiced`, 대변 메모는 감소. 구매도 같다.

