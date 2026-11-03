# 회계 (`sql/65_accounting.sql`)

모듈 `accounting`, 정렬 50. 다른 모듈이 낸 이벤트로 복식 전표를 만들고 보고서를 낸다. 청구서와 입금 자체는 청구 모듈 몫이다([invoicing.md](invoicing.md)).

## 나중에 켜도 같은 장부

구독 `accounting.books` 는 `replay: true` 다. 켜면 원장 처음부터 읽는다. 처음부터 켠 회사와 전부 끝난 뒤 켠 회사의 시산표가 정확히 같아야 하므로(`test/rebuild-gl.test.mjs`) 처리기는 두 가지를 지킨다.

- **그때의 사실로만 판단한다.** 이벤트 자체와, 원장을 그 이벤트 번호까지 재생한 상태(`erp.books_state_at`)만 읽는다. 지금의 제품 분류 계정, 지금 켜진 모듈, 오늘 날짜, 지금의 시간대를 읽지 않는다. 뒤에 분류의 계정을 바꿔도 지난 전표는 움직이지 않는다.
- **같은 이벤트는 한 번만 반영한다.** 전표 id 를 이벤트 번호에서 만든다(`erp.seed_id('gl:' || seq)`). 두 번 와도 이미 있으면 끝이다. 취소·초안 복귀는 자기보다 앞선 전표만 건드리므로 다시 전달돼도 그 뒤의 재게시를 건드리지 않는다.

전표는 원본 이벤트의 correlation 을 이어받는다(버스가 해 준다). 되돌리면 전표도 함께 되돌아가고, 전달 전에 되돌린 이벤트는 건너뛴다.

다시 만들 수 없는 것: 청구 모듈이 없던 기간의 전표. 그 기간은 `journal_entry` 의 `kind: opening` 으로 기초 잔액을 넣는다.

## 어떤 사실이 어떤 분개가 되는가

| 이벤트 | 분개 | 날짜 |
|---|---|---|
| `InvoicePosted` 고객 청구서 | 차변 외상매출금 / 대변 매출, 세금 | `date` |
| `InvoicePosted` 고객 대변 메모 | 위의 반대 | `date` |
| `InvoicePosted` 공급사 청구서 | 차변 미착품 또는 비용, 세금 / 대변 외상매입금 | `date` |
| `InvoicePosted` 공급사 대변 메모 | 위의 반대 | `date` |
| `InvoiceResetToDraft`, `InvoiceCancelled`, `PaymentCancelled` | 그 문서의 열린 전표를 같은 날짜로 지운다 | 원 전표 |
| `PaymentPosted` 입금 | 차변 분개장 계정(없으면 보통예금 또는 현금), 탈락 계정 / 대변 외상매출금 또는 외상매입금 | `date` |
| `PaymentPosted` 지급 | 위의 반대 | `date` |
| `PickingValidated` 사내 → 고객 | 차변 상품매출원가 / 대변 상품 | `date_done` |
| `PickingValidated` 고객 → 사내 | 차변 상품 / 대변 상품매출원가 | `date_done` |
| `PickingValidated` 공급사 → 사내 | 차변 상품 / 대변 미착품 | `date_done` |
| `PickingValidated` 사내 → 공급사 | 차변 미착품 / 대변 상품 | `date_done` |
| `StockAdjusted` | 늘면 차변 상품 / 대변 재고자산감모손실, 줄면 반대 | 이벤트 시각 |
| `StockScrapped` | 차변 재고자산감모손실 / 대변 상품 | 이벤트 시각 |
| `BankLineBooked` | 들어온 돈이면 차변 분개장 계정 / 대변 고른 계정, 나간 돈이면 반대 | 거래일 |
| `BankLineUnbooked` | 그 은행 거래의 열린 전표를 같은 날짜로 지운다 | 원 전표 |

- 지우기는 음수 줄이다. 차변·대변 합계가 부풀지 않아 그 기간은 게시한 적 없는 것과 같다. 대변 메모는 진짜 반대 분개다.
- 전표 방향은 이동의 **위치 용도**로 정한다. 반품의 반품은 다시 고객에게 가는 출고라서 플래그만으로 알 수 없다. 위치를 알 수 없으면 `picking_type` 과 `is_return` 으로 판단한다. 사내 이동과 원가 0 은 전표가 없다.
- 평가 금액은 이벤트의 `unit_cost` × 수량이다. 입고 원가와 청구 단가의 차이는 미착품 잔액에 남는다.

### 계정 고르기

1. 줄에 `account_id` 가 있으면 그것(재고 모듈이 켜져 있어도).
2. 선금 줄: 선수금, 공급사 쪽은 선급금.
3. 공급사 문서의 저장되는 재화(`type=goods`, `is_storable` 이 꺼지지 않음) + 그 시점에 재고 모듈이 켜져 있었음: 미착품.
4. 제품 분류의 `income_account_id`·`expense_account_id`. 없으면 상위 분류.
5. 문서 분개장의 `account_id`(`InvoicePosted.journal_account_id`).
6. 시드: 상품매출, 상품매출원가.

4~6 으로 고른 계정은 문서의 세금 조정 `account_map` 을 거친다. 줄에 직접 적은 계정은 그대로다. 대응표는 이벤트 시점 값을 읽으므로 뒤에 고쳐도 지난 전표는 움직이지 않는다.

세금은 줄의 `taxes[].account_id`, 그 시점 세금 설정의 `account_id`, 시드(부가세예수금, 부가세대급금) 순이다. 세금 분배가 있으면 `repartition` 줄마다 그 계정으로 가고, 계정이 비면 줄의 계정으로 간다(공제 안 되는 매입세). 역과세는 차변과 대변이 함께 생기고 미지급금은 늘지 않는다. 신고 그리드는 `erp.gl_lines.grids` 에 남고 `erp_general_ledger` 에 보인다. `taxes` 없이 `tax_amount` 만 있어도 시드 계정으로 받는다. 탈락은 `writeoff_account_id`, 없으면 입금은 대손상각비, 지급은 잡이익이다. 조기 할인은 회사의 `early_discount_loss_account_id`·`early_discount_gain_account_id`, 없으면 잡손실·잡이익이고 `writeoff_taxes` 몫은 세금 계정으로 간다.

`재고 모듈이 켜져 있었음`은 지금 상태가 아니라 그 모듈의 원장 스트림을 그 시점까지 읽어서 판단한다. 등록되지 않은 모듈은 꺼진 것으로 본다.

새 시드 계정 `미착품`(코드 147, `asset_current`)은 이 파일이 `erp.default_seeds` 로 넣고, 이미 설치된 회사에는 설치 스크립트를 다시 돌릴 때 넣는다.

### 이벤트가 맞지 않을 때

줄의 합과 `amount_total` 이 다르면 `ERP_UNBALANCED` 로 그 이벤트에서 멈춘다. 발행 모듈은 영향받지 않고 관리자 화면에 원인이 보인다. 고쳐서 재시도하거나 사유를 남기고 건너뛴다. 전표를 지어내서 맞추지 않는다.

## `journal_entry`

`number(MISC/2026/00001), date, ref, narration, kind(manual/opening/auto), state(draft/posted/auto/cancelled), partner_id, origin_type, origin_id, origin_event, origin_seq, reversal_of, reversed_by, open, lines[{id, account_id, partner_id, name, debit, credit, due_date}], total_debit, total_credit`

자동 전표는 `kind=auto`, `state=auto` 이고 번호로 원 문서 번호를 쓴다. 명령은 전부 `ERP_AUTO_ENTRY` 로 거부되며 원본 문서에서 정정한다. 자동 전표는 원본을 따라 되돌아가야 하므로 `state` 가 `posted` 가 아니다.

수동 전표:

| 명령 | 뜻 |
|---|---|
| `create{..., post}` | 초안. 초안은 차대가 달라도 된다. 한 줄에 차변과 대변을 함께 넣거나 음수는 안 된다 |
| `update` | 초안만 |
| `post` | 차변·대변이 다르면 `ERP_UNBALANCED`, 금액 있는 줄이 없으면 `ERP_NO_LINES` |
| `reset_to_draft` | 효과를 음수로 지운다. 번호 유지 |
| `reverse{date, reason}` | 반대 전표를 게시하고 잇는다 |
| `cancel`, `delete` | 초안만. 번호가 있으면 삭제 불가 |

게시된 수동 전표는 `revert_blocked_states` 로 되돌리기가 막힌다.

## 파생 표 `erp.gl_lines`

`event_seq, move_id, date, account_id, partner_id, debit, credit, name, due_date`. 효과 kind `gl` 로만 바뀌고(`data.effects.gl`) `erp_rebuild` 로 다시 만들 수 있다. 뷰 `public.erp_gl_lines`, 회계 역할과 관리자만 읽는다. 할부가 둘 이상이면 채권·채무 줄을 할부별 `due_date` 로 나눈다.

## 보고서

모두 전표의 업무 날짜 기준이고 `accounting` 역할과 관리자만 읽는다.

| 함수 | 결과 |
|---|---|
| `erp_trial_balance(from, to)` | 계정별 `opening, debit, credit, closing` + `totals` |
| `erp_general_ledger(account, from, to)` | 줄별 `date, number, name, debit, credit, balance` + `opening, closing` |
| `erp_profit_loss(from, to)` | `income[], expense[], total_income, total_expense, net_income` |
| `erp_balance_sheet(at)` | `assets[], liabilities[], equity[], current_earnings, total_assets, total_liabilities, total_equity`. 아직 자본으로 옮기지 않은 손익은 `current_earnings` 로 보여 주고 `total_equity` 에 넣어 항상 맞는다 |
| `erp_account_groups(from, to)` | `groups[{id, name, code_prefix_start, code_prefix_end, opening, debit, credit, closing, accounts[]}], ungrouped[]`. 계정은 코드가 들어가는 가장 좁은 그룹에 들어간다 |

외상매출금 잔액은 `erp_aged('receivable')` 합계와, 외상매입금 잔액은 `erp_aged('payable')` 합계와 같아야 한다(시험한다).

회계 모듈이 꺼져 있으면 보고서는 `ERP_MODULE_OFF` 다.

외화는 받지 않는다(`ERP_CURRENCY`).

## 기간 잠금

닫은 기간의 숫자는 바뀌지 않는다. 회사 레코드에 잠금일을 둔다. 관리자만 고친다.

| 필드 | 막는 문서 |
|---|---|
| `lock_date_all` 전체 잠금일 | 청구서·입금·전표·은행 거래 전부 |
| `lock_date_tax` 세금 잠금일 | 세금이 있거나 증빙유형이 적힌 청구서. 신고 마감(`krtax.md`)이 이 날짜를 올린다 |
| `lock_date_sale` 판매 잠금일 | 고객 문서 |
| `lock_date_purchase` 구매 잠금일 | 공급사 문서 |
| `lock_date_hard` 되돌릴 수 없는 잠금일 | 전부. 앞당기거나 지울 수 없고, 예외도 없다 |

- 그 날짜까지 포함한다. 잠금일 이전 날짜의 문서는 게시·초안 복귀·취소·삭제가 `ERP_LOCKED` 로 거부된다. 초안도 같다. 날짜를 잠금일 뒤로 옮기면 다시 할 수 있으므로 멈추는 문서는 없다.
- 관찰은 잠긴 날짜의 문서를 게시할 때 회계일을 저절로 옮기고 초안 취소·삭제를 허용한다. 여기서는 거부한다. 회계일이 말없이 바뀌면 사람이 고른 날짜와 장부가 어긋난다. `erp_lock_status().next_open` 이 고를 수 있는 첫날을 알려 준다.
- 정정은 열린 기간으로 간다. 역분개·대변 메모의 날짜가 잠금일 뒤면 원본이 잠긴 기간에 있어도 된다. 날짜를 안 준 전표 역분개는 원본 날짜를 쓰므로 거부된다. 잠긴 청구서를 정정할 길이 없으면 안 되기 때문이다.
- 되돌리기도 넘지 못한다. 상태가 바뀌는 문서의 날짜가 잠겨 있거나(`lock_fn`), 전표 효과가 잠긴 날짜의 금액을 바꾸면(`gl_check_lock`) `blocked` 다. 같은 날 같은 계정에서 상쇄되면 막지 않는다. 회사 레코드는 되돌리기 대상이 아니므로 시점 되돌리기로 잠금을 풀 수도 없다.
- 전체·되돌릴 수 없는 잠금일을 올리려면 그 기간의 은행 거래가 모두 대사되어 있어야 한다(`ERP_LOCKED_BANK`). 되돌릴 수 없는 잠금일은 그 기간의 초안 청구서·전표도 없어야 한다(`ERP_LOCKED_DRAFTS`).
- 예외: `lock_exception{field, lock_date, member_id, reason, end_at}`. 관리자가 사유와 끝나는 때를 적어 준다. `lock_date` 를 비우면 그 기간 그 잠금일을 적용하지 않는다. `revoke` 로 거둔다. 기록은 지워지지 않는다.
- 버스 처리기는 잠금을 보지 않는다. 이벤트가 난 시각의 날짜로 전표를 쓴다. 잠금을 건 직후 전달되는 이벤트는 그 날짜로 들어갈 수 있다. 처리기가 지금 잠금을 읽으면 나중에 켠 회계의 시산표가 달라진다.

## 시험과의 대응

`test/accounting.test.mjs`, `test/rebuild-gl.test.mjs`. 재고·판매 이벤트는 `events.md` 모양대로 넣는다.
