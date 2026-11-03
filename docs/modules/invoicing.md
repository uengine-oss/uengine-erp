# 청구 (`sql/60_invoicing.sql`, `sql/62_bank.sql`)

모듈 `invoicing`, 정렬 40. 청구서·공급사 청구서·대변 메모·입금·미수금을 다룬다. **전표를 만들지 않는다.** 사실을 이벤트로 남기면 끝이고, 분개는 회계 모듈이 그 이벤트를 받아 만든다. 판매·구매·재고·회계가 모두 꺼져 있어도 동작한다.

켤 때 옵션 `orders_since`: 이 날짜 이후의 판매 주문만 청구 대상으로 본다. `from_sales_order` 와 `erp_invoice_targets` 에서만 쓴다(구매 주문은 대상 조회에서만 걸러지고 `from_purchase_order` 는 막지 않는다). 주문의 청구 상태는 판매 모듈 몫이다. 모듈을 껐다 옵션 없이 다시 켜도 값은 유지된다.

## `account_move`

`move_type(out_invoice/out_refund/in_invoice/in_refund), number, partner_id, invoice_date, date, due_date, payment_term_id, fiscal_position_id, currency, ref, payment_reference, narration, incoterm, incoterm_place, partner_bank, should_be_paid(yes/no/exception), origin_type, origin_id, origin_name, auto_post, state(draft/posted/cancelled), payment_state(not_paid/in_payment/paid/partial/reversed), reversal_of, reversed_by, reversal_reason, debit_note_of, installments[{due_date, amount, discount_date, discount_amount, discount_mode}], applied[{id, payment_id, credit_move_id, amount, date, reversal}], amount_untaxed, amount_tax, amount_total, amount_residual, lines[{id, sequence, display_type, product_id, variant_id, name, qty, uom_id, price_unit, discount, tax_ids, account_id, subtotal, tax_amount, total, taxes, origin_line_id, is_downpayment, downpayment_line_id}]`

증빙 칸: `evidence_type(tax_invoice/exempt_invoice/credit_card/cash_receipt/other_receipt/none), approval_no, deductible, non_deduct_reason, card_kind(business/other), amend_reason, original_date, original_approval_no, stock_reflect, stock_warehouse_id, voucher, payment_way(credit/cash/bank/card), voucher_payment_id, compensation`. 줄에 `fixed_asset`, `tax_override`(증빙에 적힌 세액), `worked_tax`(세율로 계산한 값) 가 더 있다.

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
| `change_number{number}` | 번호가 붙었다가 초안으로 돌아온 문서의 번호를 바꾼다. 그 묶음의 마지막 문서만 된다. 번호에서 연·월을 찾아 분개장의 형식으로 삼고, 뒤 문서가 그 형식을 잇는다. 변경은 분개장에 `JournalNumberFormatChanged` 로 남는다 |
| `fill_from_order{from_sales_order 또는 from_purchase_order}` | 손으로 시작한 초안에 주문의 남은 줄을 채운다. 거래처가 같아야 한다 |
| `create{voucher: true, ...}` | 전표 입력. 아래 「증빙과 전표 입력」 |
| `compensate{amend_reason, date, reason}` | 게시 문서를 대변 메모로 상쇄한다. 아래 「게시 문서를 상쇄한다」 |
| `set_evidence{evidence_type, approval_no, non_deduct_reason, card_kind, amend_reason}` | 게시 뒤에도 증빙을 적는다. 금액은 그대로다. 공제 여부는 장부가 이미 받았으므로 게시 뒤에 바꾸지 않는다 |

`date`(회계일)는 비우면 청구일을 따른다. 초안으로 돌아갈 때 청구일과 같았다면 다시 비워서 청구일을 고치면 함께 움직인다.

결제 조건이 없는 문서의 기일은 청구일이다. 관찰된 동작은 만든 날인데, 그러면 소급 청구서의 미수금 연령이 틀어지고 미래 청구서의 기일이 청구일보다 앞선다. 그래서 따르지 않는다(`docs/plan.md` 결정 12).

## 증빙과 전표 입력

**새 문서 종류가 아니다.** `account_move.create{voucher: true}` 한 번이 문서를 만들고 게시하고 결제까지 한 트랜잭션, 한 correlation 으로 한다. 어디서 실패해도 문서도 번호도 남지 않는다.

```
erp_create { type: "account_move", saga_id: "...", values: {
  voucher: true, move_type: "in_invoice" | "out_invoice", partner_id, invoice_date, evidence_type,
  approval_no?, deductible?, non_deduct_reason?, card_kind?, payment_way: "credit" | "cash" | "bank" | "card", payment_date?, payment_journal_id?,
  stock_reflect?, stock_warehouse_id?, allow_duplicate?, lines: [{ variant_id | name, account_id?, qty, price_unit, tax_ids?, tax_override?, fixed_asset? }] } }
```

돌려주는 값: `id`(문서), `state`(`number`, `amount_total`, `voucher_payment_id` 포함), `correlation_id`, `events[{stream_id, type}]`.

- 줄에 세금을 안 주면 증빙이 정한다. 계산서는 면세, 매입의 그 밖의 영수증과 없음은 세금 없음, 제품 줄은 제품의 세금, 그 밖은 회사 기본 세금이다.
- 공제 기본값과 증빙으로 할 수 없는 조합(`ERP_EVIDENCE`)의 근거는 `krtax.md` 다.
- 카드 결제는 신용카드 분개장을 쓴다. 없으면 처음 쓸 때 만든다. 매출을 카드로 받는 경우도 같은 분개장에 입금한다. 카드사 정산은 은행 거래로 맞춘다.
- `erp_preview('account_move', {voucher: true, ...})` 는 줄, 합계, `problem`, `duplicate_of`, `tax_gap`, `facts{invoice, payment}` 를 준다. 화면이 `facts` 를 `erp_preview('journal_entry', facts)` 에 넘기면 회계가 자기 코드로 분개를 보여 준다. 회계가 꺼져 있으면 그렇다고 말한다.

**중복.** 같은 승인번호(같은 `move_type`, 대소문자와 구분 기호 무시)는 초안에도 게시에도 `set_evidence` 에도 `ERP_DUPLICATE_VOUCHER` 다. 승인번호가 없는 전표 입력은 거래처·증빙 일자·합계가 같으면 거부하고, `allow_duplicate: true` 로 넘어간다. 메시지에 있는 문서의 번호와 id 가 들어 있다. 대변 메모가 게시되어 상쇄된 문서는 없는 것으로 보므로 같은 파일을 다시 올릴 수 있다. 같은 값을 동시에 올려도 잠금으로 줄을 세운다.

## 게시 문서를 상쇄한다

게시한 청구서는 되돌리기(`Reverted`)로 막혀 있다. 그 규칙은 그대로다. `compensate` 는 반대 거래를 남기는 명령이다.

1. 전표 입력이 만든 입금이 살아 있으면 취소한다. 다른 돈은 떼어 거래처의 크레딧으로 남긴다.
2. 전액 대변 메모를 만들어 게시한다. 원 문서는 `reversed` 가 되고 대변 메모는 `compensation: true`, `amend_reason`, `reversal_reason`(`reason` 또는 명령의 사유), `original_date`, `original_approval_no` 를 갖는다.
3. 날짜는 사유가 정한다(`krtax.md`). `input_error` 가 기본값이고 처음 날짜를 따른다. 그래서 신고서 칸이 그 기간 안에서 상쇄된다. 미래 날짜는 거부한다.

다시 부르면 이미 게시된 상쇄 문서를 돌려주고 아무것도 하지 않는다. 사람이 쓴 대변 메모가 이미 있으면 `ERP_STATE` 다. 전액을 또 빼면 과하기 때문이다.

사가에서: 카탈로그의 `compensate` 가 `account_move` 는 `compensate`, `payment` 는 `cancel` 을 가리킨다. 커널이 역순으로 부르므로 입금이 먼저 취소된다. 잠긴 기간이면 `lock_fn` 이, 물건을 이미 내보냈으면 재고 `check_fn` 이 사가를 `blocked` 로 만든다.

## 파일에서 전표 후보로

사람이 내려받은 파일만 받는다. 스크래핑, 금융 ID·비밀번호·인증서 저장은 하지 않는다.

- `erp_voucher_candidates(move_type, evidence, rows)`: 읽기만 한다. 행 `{date, partner_name, partner_tax_id, supply, tax, total, approval_no, item}` 에 대해 `partner_id, partner_by(tax_id/name), new_partner, duplicate_of{id, number, by(approval_no/partner_date_amount/same_file)}, suggested_account_id, supply, tax, total, problems[]` 를 돌려준다. 합계만 있으면 공급대가 ÷ 1.1 로 나눈다.
- 계정 추천은 그 거래처의 같은 쪽 전표에서 사람이 마지막에 고른 계정이다. 따로 규칙 표가 없다.
- 쓰기는 `erp_import('account_move', rows, 'commit', {keep_good: true})` 로 전표 입력과 같은 명령을 부른다.
- 열 배치는 회사의 레코드 `voucher_import_profile{name, source, columns, verified}` 다. **앱에 들어 있는 양식은 없다.** 실제 파일 표본을 보지 못했으므로 열 이름을 추측하지 않고, 화면이 모든 자료에 "확인 안 됨"이라고 표시한다.
- `erp_tax_invoice_rows(from, to)`: 기간의 매출 세금계산서. 화면이 CSV 로 내보낸다. 홈택스 일괄 발급 양식과 대조하지 못했다고 화면이 말한다. 전자 발행은 하지 않는다.

## 분개장

유형 `journal`: `name, code(unique), journal_type(sale/purchase/bank/cash/credit/general), currency, account_id, loss_account_id, profit_account_id, allowed_account_ids, payment_reference_model(invoice/partner), bank_account_number, bank_id, number_formats`. 새 회사에는 `INV`, `BILL`, `MISC`, `BNK1`(보통예금), `CSH1`(현금)이 있다.

- 은행·현금·신용카드 분개장은 코드(`BNK2`, `CSH2`, `CCD1`)와 전용 계정을 비워 두면 만들어 주고, 수기 수금·지급 수단을 둘 만든다. 회계가 꺼져 있어도 계정은 만든다. 장부를 나중에 켜도 그 자리에 가야 한다.
- 고객 문서는 판매, 공급사 문서는 구매 분개장에만 들어간다. 안 고르면 `INV`, `BILL` 이다. 번호 앞머리는 코드이고 대변 메모는 앞에 `R` 을 붙인다(`EXP/2026/00001`, `REXP/2026/00001`).
- `allowed_account_ids` 가 있으면 그 분개장의 수동 전표는 게시할 때, 은행 거래 분개는 처리할 때 다른 계정을 거부한다.
- `payment_reference_model` 은 비어 있으면 아무것도 쓰지 않는다. `invoice` 는 번호, `partner` 는 거래처 참조 번호를 게시할 때 채운다.

유형 `payment_method`: `name, journal_id, direction(inbound/outbound), code(manual/check/file), requires_trusted_bank`. `file` 은 기본으로 신뢰한 계좌에만 보낸다. 지급을 게시할 때 그런 수단이면 수취 계좌가 있어야 하고(`ERP_REQUIRED`) 신뢰 표시가 있어야 한다(`ERP_UNTRUSTED_BANK`). 수기 수단은 막지 않는다. 보내는 것이 없다.

입금의 `journal`(bank/cash)은 예전 그대로 받는다. `journal_id` 나 `payment_method_id` 를 주면 그쪽을 따르고, 아무것도 안 주면 거래처의 선호 수단을 쓴다. 분개는 `PaymentPosted` 의 `journal_account_id` 로 간다.

## 은행 거래와 대사

입금 분개는 지금처럼 게시할 때 예금으로 간다. 미결 계정을 끼우지 않는다. 기존 전표 계약과 나중에 켠 회계의 동일성을 건드리지 않는 가장 작은 설계이고, 대신 맞춰 보는 것은 원장 밖에서 한다. `bank_line` 은 은행이 말한 사실이고 그 자체로는 아무것도 분개하지 않는다.

| 명령 | 뜻 |
|---|---|
| `bank_line.create` | `journal_id, date, amount, statement_id, payment_ref, partner_id, partner_name, account_number, transaction_type, import_id`. 들어온 돈이 양수. `import_id` 는 분개장 안에서 한 번뿐이다. 0원 거래는 곧바로 `matched` |
| `match{payment_ids}`, `unmatch{payment_id}` | 게시된 입금을 맞춘다. 분개장과 부호가 같고 남은 금액 안이어야 한다. 입금 하나는 거래 하나에만. 맞춘 입금은 취소할 수 없고(`ERP_MATCHED`) `is_matched`, `bank_line_id` 가 붙는다 |
| `pay{move_ids}` | 입금이 없는 문서에 은행 날짜로 입금을 만들어 바로 맞춘다. 한 거래처의 문서만 |
| `book{account_id, name, amount}`, `unbook` | 문서 없는 돈(수수료, 이자). `BankLineBooked` 를 내고 회계가 분개한다. 회계가 꺼져 있어도 나중에 켜면 같은 전표가 된다 |
| `bank_statement.create{journal_id, name, date, balance_start, balance_end_real, attachment_url, line_ids}`, `assign{line_ids}` | 거래를 묶는다. 잔액이 안 맞아도 저장한다 |

문서의 `payment_state` 는 대사와 무관하다. 대사가 끝나도 `paid` 그대로이고 입금의 `is_matched` 만 바뀐다(관찰과 같다).

조회는 모두 `accounting` 역할이다.

| 함수 | 결과 |
|---|---|
| `erp_bank_statements(journal_id)` | `[{id, name, date, balance_start, balance_end, balance_end_real, lines, first_date, last_date, is_complete, is_valid, problems[]}]`. `balance_start` 를 안 넣으면 앞 명세서의 종료 잔액 |
| `erp_bank_lines(journal_id, from, to, only_open, limit, offset)` | 거래별 `running_balance` 포함 |
| `erp_bank_reconciliation(journal_id, at)` | `statement_total, book_total, difference, unmatched_lines[], unmatched_lines_total, unmatched_payments[], unmatched_payments_total` |
| `erp_bank_match_candidates(line_id)` | `payments[{id, number, date, amount, exact}], documents[{id, number, residual, exact, named}], accounts[]`. `accounts` 는 `reconcile` 이 켜진 계정만 |
| `erp_bank_auto_match(journal_id)` | 금액이 같은 입금이 하나뿐일 때만 맞춘다. `{matched}` |

파일은 화면이 열로 풀어 `erp_import('bank_line', rows, mode)` 로 보낸다(같은 `import_id` 는 건너뛴다). CAMT·OFX·QIF 해석은 SQL 에 없다.

## 세금 신고

- `erp_tax_report(from, to)`: 회계일 기준 게시 문서로 낸다. 회계가 꺼져 있어도 답한다. `rows[{tax_id, name, scope, amount_type, rate, base, tax, base_refund, tax_refund, discount_tax}], grids[{grid, base, tax}], totals{output_tax, input_tax, payable}`. 대변 메모는 빼고, 입금할 때 세금까지 줄인 조기 할인은 입금일 기간에서 뺀다. 장부의 부가세 계정 움직임과 같다(시험한다).
- `erp_tax_periods(year)`: 회사 설정 `tax_periodicity`, `tax_due_day`, `tax_reminder_days`, `lock_date_tax` 로 `periods[{from, to, due, remind_on, state(open/to_file/due_soon/overdue/closed)}]` 를 낸다. 신고를 마치면 세금 잠금일을 넣는다.

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
- `reverse` 의 `date` 가 미래면 `auto_post=at_date` 가 붙는다. 그 전까지 `post` 는 `ERP_AUTO_POST` 로 거부되고, 그날 `erp.inv_auto_post_due()` 가 게시한다. pg_cron 이 있으면 매시간 돌고, 없어도 앱이 명령 뒤에 부르는 `erp_bus_tick` 이 한 시간에 한 번 돌린다(`erp.periodic_register`). `erp_invoice_auto_post()` 로 바로 돌릴 수도 있다. 미래 날짜를 직접 넣은 일반 문서는 그대로 게시된다.

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
- `discount_mode: mixed`(항상)는 할인 여부와 무관하게 할인 후 금액에 세금을 매긴다. 줄의 공급가는 그대로이고 세액만 낮아진다. 100, 21%, 2% 면 합계 120.58, 기한 안에 내면 118.58 이고 세금 계정은 다시 움직이지 않는다. 그 조건으로 만든 판매 주문의 세액도 같다. 구매 주문의 세액은 줄지 않는다(관찰과 같다).

## 이벤트

줄 공통과 `InvoicePosted` 등은 `events.md` 그대로다. 더한 것:

| 이벤트 | 더한 필드 |
|---|---|
| 줄 공통 | `downpayment_line_id`. `taxes[].account_id` |
| `InvoiceDrafted` | `reversal_of` |
| `InvoicePosted` | `invoice_date`, `installments`, `evidence`, `partner_tax_id`, `stock_reflect`, `stock_warehouse_id` |
| `InvoicePaymentApplied` | `credit_move_id`(대변 메모가 맞물렸을 때 상대 문서, 이때 `payment_id` 는 없다). 맞물림을 풀면 같은 이벤트가 **음수 `amount`** 로 나간다. 합치면 지금 상태와 같다 |
| `PaymentPosted` | `partner_type`, `writeoff_label`, `early_discount`, `writeoff_taxes[{tax_id, name, account_id, amount}]` |
| `PaymentCancelled` | `partner_type`. 초안을 취소했으면 `allocations` 는 빈 목록이다 |

이 모듈 안에서만 쓰는 이벤트: `InvoiceCreated`, `InvoiceUpdated`, `InvoiceLineAdded/Changed/Removed`, `InvoiceReversalLinked`, `PaymentCreated`, `PaymentUpdated`, `PaymentStateChanged`, `PaymentAllocated`, `PaymentAllocationRemoved`, `PaymentRejected`, `PaymentValidated`, `PaymentResetToDraft`, `PaymentDeleted`. 번호 없는 초안 삭제는 `InvoiceCancelled` 로 나간다(그 초안을 세던 주문이 알아야 한다).

## 되돌리기

게시된 청구서와 게시된 입금은 `revert_blocked_states` 로 막는다. 대변 메모나 입금 취소로 정정한다. 초안 작성, 게시 뒤 초안 복귀는 되돌릴 수 있다.

## 조회

- `erp_aged(kind, at)`: `receivable`, `payable`. 거래처별 `not_due, d1_30, d31_60, d61_90, over_90, total`. 남은 금액을 오래된 할부부터 채워 할부별 만기로 나눈다. 대변 메모는 빼고 미배분 입금은 입금일 기준으로 뺀다. `at` 을 주면 그날 끝의 원장 상태로 계산한다. 합쳐진 연락처는 대상 거래처로 묶는다. `receivable` 은 `accounting`·`sales`, `payable` 은 `accounting`·`purchase` 가 읽는다.
- `erp_invoice_targets(kind, limit)`: `sales`, `purchase`. 원장의 주문 확정 이벤트로 주문을 찾고 `erp.peek` 로 읽어 청구할 것이 남은 주문을 돌려준다.
- `erp_outstanding(partner_id, side)`, `erp_invoice_number_gaps()`(취소된 번호와 빠진 번호). 청구 모듈이 꺼져 있으면 `erp_aged` 와 함께 `ERP_MODULE_OFF` 다.
- `erp_auto_reconcile(mode, partner_id)`: `same_amount` 는 금액이 같은 입금·대변 메모와 문서를 짝짓고, `all` 은 거래처의 크레딧을 오래된 문서부터 모두 쓴다.
- `erp_preview('account_move', ...)`: 저장 없이 줄과 합계를 계산한다.

## 시험과의 대응

`test/invoicing.test.mjs`. 판매·구매는 시험 안에서 만든 레코드와 이벤트로 흉내 낸다.

외화는 환산하지 않는다. 회사 통화와 다른 `currency` 는 가격표·주문·구매·청구서·입금·분개장에서 `ERP_CURRENCY` 로 거부한다.

## 기간 잠금

회사 설정의 잠금일(`docs/modules/accounting.md`)을 따른다. 고객 문서는 판매 잠금일, 공급사 문서는 구매 잠금일, 세금이 있는 문서는 세금 잠금일도 함께 본다. 입금은 전체 잠금일만 본다. 대사와 맞물림은 금액을 움직이지 않으므로 막지 않는다.
