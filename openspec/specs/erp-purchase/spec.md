# 구매

## Purpose

구매 담당자가 공급사에 견적을 요청하고 구매 주문으로 확정한 뒤, 입고와 청구가 어디까지 왔는지 주문 한 장에서 본다. 재고 모듈이 꺼져 있어도 입고 수량을 직접 입력해 동작하고, 재고와 청구 모듈이 켜져 있으면 그 소식을 이벤트로 받아 같은 주문에 반영한다. 입고 전표 자체의 동작은 `erp-inventory`, 청구서 자체의 동작은 `erp-invoicing` 이 다룬다.

## Requirements

### Requirement: 견적 요청은 금액을 계산하되 확정 전에는 입고·청구 대상이 아니다

시스템은 구매 문서를 `draft`(견적 요청), `sent`(보냄), `to_approve`(승인 대기), `purchase`(구매 주문), `cancelled`(취소) 상태로 다루고 번호를 `P` 와 다섯 자리 숫자로 매겨야 한다(SHALL). 확정 전 문서의 `billing_status` 는 `no`, 줄의 `qty_to_bill` 은 0 이다. `보냄 표시` 는 상태만 바꾸며 메일을 보내지 않는다. `date_order`(주문 마감일)는 확정해도 바뀌지 않고 확정 시각은 `date_confirmed` 에 남는다.

#### Scenario: 견적 요청 초안을 만든다

- **WHEN** 최구매가 바람부품을 공급사로 제습기 10개, 단가 600원, 세금 `부가세 10% 매입` 으로 견적 요청을 저장한다
- **THEN** 상태는 `draft` 이고 번호는 `P` 와 다섯 자리 숫자다
- **AND** `amount_untaxed` 는 6,000, `amount_tax` 는 600, `amount_total` 은 6,600 이고 `currency` 는 회사 통화 `KRW` 다
- **AND** `receipt_status` 와 `billing_status` 는 `no`, 줄의 `qty_to_bill` 은 0 이다
- **AND** 원장에 `RfqCreated`, `RfqLineAdded`, `PurchaseDraftQtyChanged` 가 차례로 남는다

#### Scenario: 보냄 표시를 하고 주문을 확정한다

- **WHEN** 최구매가 그 문서에서 `보냄 표시` 를 누른 뒤 `주문 확정` 을 누른다
- **THEN** 상태는 `sent` 를 거쳐 `purchase` 가 된다
- **AND** `date_order` 는 그대로이고 `date_confirmed` 가 채워진다
- **AND** `PurchaseOrderConfirmed` 이벤트에 `number`, `partner_id`, `currency`, `amount_total` 6,600 이 실린다
- **AND** 그 이벤트의 줄에 `line_id`, `variant_id`, `qty` 10, `uom_id`, `unit_price` 600, `discount` 0, `subtotal` 6,000, `type` `goods`, `bill_policy` `receipt`, `date_planned` 가 실린다

### Requirement: 초안의 줄은 바뀐 것만 기록하고 잘못된 입력은 거부한다

시스템은 화면이 줄 전체를 보내도 바뀐 줄만 이벤트로 남겨야 한다(SHALL). 초안에서 목록에 없는 줄은 지운 것으로 본다. 바뀐 것이 없으면 이벤트를 남기지 않는다. 구역 줄은 금액과 다른 모듈에 알리는 사실에 들어가지 않는다.

#### Scenario: 초안의 줄을 고치면 바뀐 것만 남는다

- **WHEN** 최구매가 원가 500원인 에어서큘레이터 1개 초안에서 수량을 3개로 고치고, 원가가 같은 제습기 2개를 더하고, `vendor_ref` 에 `V-1` 을 넣어 저장한다
- **THEN** 줄은 2개이고 `amount_untaxed` 는 2,500 이다
- **AND** 원장에 `RfqLineChanged`, `RfqLineAdded`, `RfqUpdated` 가 남는다
- **AND** 같은 내용으로 다시 저장하면 이벤트가 늘지 않는다
- **AND** 제습기 줄을 빼고 저장하면 줄은 1개, `amount_untaxed` 는 1,500 이고 `RfqLineRemoved` 가 남는다

#### Scenario: 잘못된 입력은 저장되지 않는다

- **WHEN** 최구매가 구매 문서에 잘못된 값을 넣어 저장한다
- **THEN** 없는 항목을 넣으면 `ERP_UNKNOWN_FIELD` 로 거부된다
- **AND** 제품을 고르지 않은 줄은 `ERP_REQUIRED` 로 거부된다
- **AND** 수량 -1 은 `ERP_INVALID` 로 거부된다
- **AND** 할인 101% 는 `ERP_INVALID` 로 거부된다

#### Scenario: 구역 줄은 금액과 이벤트에 들어가지 않고 줄 없는 문서도 확정된다

- **WHEN** 최구매가 구역 줄 하나와 원가 500원인 제품 1개로 문서를 만들어 확정한다
- **THEN** 줄은 2개이고 `amount_untaxed` 는 500 이다
- **AND** `PurchaseOrderConfirmed` 의 `lines` 에는 제품 줄 1개만 실린다
- **AND** 줄이 하나도 없는 문서도 `주문 확정` 하면 `purchase` 가 된다

### Requirement: 공급사 단가와 납기는 그 공급사의 유효한 줄에서 정한다

시스템은 제품의 공급사 목록에서 그 공급사의 줄 중 `date_order` 날짜에 기간이 맞고 최소 수량이 맞는 줄을 골라야 한다(SHALL). 최소 수량이 가장 큰 줄을 고르고, 같으면 가격이 낮은 줄을 고르며, 목록 순서는 영향이 없다. 할인과 공급사 제품 코드도 그 줄에서 온다. 맞는 줄이 없으면 단가는 제품 원가이고, 납기는 기간이 맞는 그 공급사 줄 중 최소 수량이 가장 작은 줄의 값이며, 그런 줄도 없으면 0 이다. 줄의 `date_planned` 는 줄을 처음 만들 때 `date_order` 에 납기를 더한 날이고, 머리글 `date_planned` 는 줄 중 가장 이른 날이다.

#### Scenario: 맞는 줄 중 최소 수량이 가장 큰 줄을 고른다

- **WHEN** 최구매가 바람부품 줄이 1개 이상 450원·납기 7일, 10개 이상 400원·납기 14일, 100개 이상 300원·납기 21일(2020년 안에만 유효)인 제품을 1개, 5개, 10개, 100개로 각각 넣는다
- **THEN** 단가와 납기는 차례로 450원·7일, 450원·7일, 400원·14일, 400원·14일이다
- **AND** 목록 순서를 10개 줄, 1개 줄로 바꾼 제품도 1개는 450원, 10개와 100개는 400원이다
- **AND** 최소 수량이 같은 1개 이상 470원·납기 7일과 1개 이상 440원·납기 9일이 있으면 어느 순서든 440원·9일이다

#### Scenario: 맞는 줄이 없으면 제품 원가를 쓴다

- **WHEN** 최구매가 원가 500원이고 바람부품 줄이 10개 이상 400원·납기 14일뿐인 제품을 5개 넣는다
- **THEN** 단가는 500원, 납기는 14일이다
- **AND** 10개로 넣으면 400원, 14일이다
- **AND** 다른 공급사 줄(1원, 납기 3일)만 있는 원가 500원 제품을 바람부품 문서에 넣으면 단가는 500원, 납기는 0일이다

#### Scenario: 입고 예정일은 주문 마감일에 납기를 더한 날이고 머리글은 가장 이른 줄을 따른다

- **WHEN** 최구매가 납기 14일인 공급사 줄에 맞는 수량으로 새 줄을 넣는다
- **THEN** 줄의 `date_planned` 는 `date_order` 에 14일을 더한 날이다
- **AND** 확정 주문의 두 줄 입고 예정일을 2031-01-01 과 2030-06-01 로 고치면 머리글 `date_planned` 는 이른 쪽인 2030-06-01 이다

#### Scenario: 수량이 바뀌어 납기가 달라져도 정해진 입고 예정일은 그대로다

- **WHEN** 최구매가 1개 이상 납기 7일, 10개 이상 납기 14일 줄이 있는 제품의 초안 줄을 1개에서 10개로 고친다
- **THEN** 줄의 `delay_days` 는 14 가 된다
- **AND** 줄의 `date_planned` 는 처음 정해진 날 그대로다

### Requirement: 자동 단가는 수량을 따르고 직접 넣은 단가는 유지한다

시스템은 자동으로 정해진 단가를 수량에 따라 다시 정하고, 사람이 직접 넣은 단가는 `price_manual` 로 표시해 수량이 바뀌어도 유지해야 한다(SHALL). 저장하기 전에도 같은 규칙으로 금액을 계산해 돌려준다.

#### Scenario: 자동 단가는 수량을 따르고 직접 넣은 단가는 남는다

- **WHEN** 최구매가 바람부품 줄이 1개 이상 450원·납기 7일·할인 10%·제품 코드 `VC`, 10개 이상 400원·납기 14일인 제품을 1개 넣는다
- **THEN** `discount` 는 10, `subtotal` 은 405, `vendor_code` 는 `VC` 다
- **AND** 수량을 10개로 고치면 단가는 400원, `discount` 는 0, `delay_days` 는 14 다
- **AND** 단가를 777원으로 직접 넣으면 `price_manual` 이 true 가 된다
- **AND** 수량을 1개로 되돌려도 단가는 777원으로 남는다

#### Scenario: 저장하지 않고 금액을 미리 본다

- **WHEN** 최구매가 입력하는 동안 화면이 `erp_preview` 에 구매 문서 유형과 바람부품, 바람부품 줄이 10개 이상 400원인 제품 10개 줄을 보낸다
- **THEN** 응답의 `amount_untaxed` 는 4,000 이다
- **AND** 응답 줄의 `price_unit` 은 400 이다

### Requirement: 줄의 기본 단위는 구매 단위다

시스템은 단위를 고르지 않은 줄에 제품의 구매 단위를 쓰고, 분류가 다른 단위는 거부해야 한다(SHALL). 공급사 단가와 최소 수량은 구매 단위 기준이고, 줄 단위가 다르면 환산한다. 다른 모듈에 알리는 초안 수량은 제품의 기준 단위로 환산한다.

#### Scenario: 구매 단위가 기본이고 분류가 다른 단위는 거부된다

- **WHEN** 최구매가 구매 단위가 다스이고 원가가 개당 6원인 제품을 단위를 고르지 않고 수량 2로 넣는다
- **THEN** 줄의 단위는 다스, 단가는 72원, `subtotal` 은 144 다
- **AND** `PurchaseDraftQtyChanged` 의 줄에는 기준 단위인 개로 `qty` 24 가 실린다
- **AND** 단위로 kg 을 고르면 `ERP_UOM` 으로 거부된다

#### Scenario: 공급사 단가와 최소 수량은 구매 단위 기준이다

- **WHEN** 최구매가 구매 단위가 다스, 원가가 개당 6원, 바람부품 줄이 1다스 이상 720원·납기 3일인 제품을 바람부품 문서에 넣는다
- **THEN** 1다스로 넣으면 단가는 720원이다
- **AND** 24개로 넣으면 단가는 60원, `subtotal` 은 1,440 이다
- **AND** 6개로 넣으면 최소 수량에 못 미쳐 단가는 원가인 6원이고 납기는 3일이다

### Requirement: 결제 조건·세금 조정·담당자는 문서를 만들 때 채운다

시스템은 문서를 만들 때 결제 조건(`payment_term_id`)과 세금 조정(`fiscal_position_id`)을 공급사에서, 구매 담당자(`buyer_id`)를 요청자에서 채우고, 세금 조정이 있으면 제품의 매입 세금을 그에 따라 바꿔야 한다(SHALL).

#### Scenario: 공급사 조건과 요청자가 문서에 채워진다

- **WHEN** 최구매가 구매 결제 조건이 `30일` 이고 `부가세 10% 매입` 을 `영세율 매입` 으로 바꾸는 세금 조정이 있는 공급사에게, 세금이 `부가세 10% 매입` 인 제품 1개를 단가 100원으로 넣어 문서를 만든다
- **THEN** `payment_term_id` 는 `30일`, `fiscal_position_id` 는 그 세금 조정이다
- **AND** 줄의 세금은 `영세율 매입` 이 되어 `amount_tax` 는 0 이다
- **AND** `buyer_id` 가 채워진다
- **AND** 세금 조정이 없는 공급사에게 같은 줄을 넣으면 `amount_tax` 는 10 이다

### Requirement: 한도 이상 주문은 관리자 승인을 기다린다

시스템은 회사 설정 `po_double_validation` 이 `two_step` 이고 세금 포함 합계가 `po_approval_limit` 이상이며 확정하는 사람이 관리자가 아니면 `주문 확정` 을 `to_approve` 로 보내야 한다(SHALL). 승인 전에는 `PurchaseOrderConfirmed` 가 나가지 않으므로 입고 전표도 없다. 구매 역할을 가진 사람이 `승인` 을 눌러도 관리자가 아니면 아무것도 바뀌지 않고 오류도 없다.

#### Scenario: 한도 이상이면 승인을 기다리고 입고 전표가 없다

- **WHEN** 재고와 구매를 켜고 김대표가 `구매 승인 단계` 를 2단계로, `구매 승인 한도` 를 1,000 으로 정한 회사에서 최구매가 999원, 1,000원, 1,001원 주문을 각각 확정한다
- **THEN** 999원 주문은 `purchase` 이고 입고 전표가 1건 생긴다
- **AND** 1,000원과 1,001원 주문은 `to_approve` 이고 1,001원 주문의 입고 전표는 없다
- **AND** 김대표가 5,000원 주문을 확정하면 승인 없이 `purchase` 가 된다

#### Scenario: 승인 대기는 관리자만 풀 수 있다

- **WHEN** 최구매가 승인 대기 중인 1,001원 주문에서 `승인` 을 누른다
- **THEN** 오류 없이 상태는 `to_approve` 그대로다
- **AND** 김대표가 `승인` 을 누르면 `purchase` 가 되고 `date_confirmed` 가 채워지며 입고 전표가 1건 생긴다
- **AND** 이미 확정된 그 주문에 김대표가 승인 명령을 보내면 `ERP_INVALID` 로 거부된다

#### Scenario: 한도는 세금 포함 합계로 보고 승인 대기 문서는 되돌릴 수 있다

- **WHEN** 같은 회사에서 최구매가 단가 950원, 세금 `부가세 10% 매입` 으로 합계 1,045원인 주문을 확정한다
- **THEN** 상태는 `to_approve` 다
- **AND** 최구매가 `취소` 를 누르면 `cancelled`, `초안으로` 를 누르면 `draft` 가 된다
- **AND** 김대표가 `구매 승인 단계` 를 1단계로 되돌린 뒤 최구매가 확정하면 `purchase` 가 된다

### Requirement: 확정된 주문은 입고와 청구가 따라갈 수 있는 변경만 받는다

시스템은 확정된 주문에서 줄 삭제, 제품 교체, 공급사 변경을 `ERP_INVALID` 로 거부해야 한다(SHALL). 줄을 없애려면 수량을 0 으로 한다. 입고된 수량 아래로 줄이면 `ERP_BELOW_RECEIVED` 다. 가격 변경과 새 줄은 받으며, 변경마다 다른 모듈이 읽을 수 있는 이벤트를 남긴다.

#### Scenario: 확정된 주문의 줄 삭제와 제품·공급사 교체는 거부된다

- **WHEN** 최구매가 에어서큘레이터 10개를 확정한 주문을 고친다
- **THEN** 줄을 모두 빼고 저장하면 `ERP_INVALID` 로 거부된다
- **AND** 줄의 제품을 제습기로 바꾸면 `ERP_INVALID` 로 거부된다
- **AND** 공급사를 바꾸면 `ERP_INVALID` 로 거부된다

#### Scenario: 확정된 주문의 수량·가격·새 줄은 각각 이벤트로 남는다

- **WHEN** 최구매가 10개, 100원으로 확정한 줄을 15개, 77원으로 고치고 제습기 3개, 50원 줄을 더한다
- **THEN** `amount_untaxed` 는 1,305 다
- **AND** `PurchaseOrderLineQtyChanged` 에 `from` 10, `to` 15, `unit_price` 77 이 실린다
- **AND** `PurchaseOrderLinePriceChanged` 에 `from` 100, `unit_price` 77 이 실린다
- **AND** `PurchaseOrderLineAdded` 의 `line` 에 `qty` 3, `unit_price` 50 이 실린다
- **AND** 이어서 15개 줄의 수량을 0 으로 고치면 줄은 남고 `amount_untaxed` 는 150 이다

#### Scenario: 입고량 아래로 줄이면 거부된다

- **WHEN** 10개 주문에 10개가 입고된 뒤 최구매가 수량을 3개로 줄인다
- **THEN** `ERP_BELOW_RECEIVED` 로 거부된다
- **AND** 재고가 켜진 회사에서 3개가 입고된 주문을 2개로 줄여도 같은 오류로 거부된다

### Requirement: 재고가 켜져 있으면 확정 뒤 변경이 입고 전표로 이어진다

시스템은 확정 뒤 수량·가격·새 줄을 이벤트로 알려 열린 입고 전표가 따라오게 해야 한다(SHALL). 입고량과 같게 줄이면 남은 입고는 취소된다. 전표 쪽의 자세한 동작은 `erp-inventory` 가 정한다.

#### Scenario: 수량과 가격이 열린 입고 전표로 따라간다

- **WHEN** 재고가 켜진 회사에서 최구매가 10개, 100원 주문을 확정한 뒤 수량을 15개, 8개로 차례로 고치고 단가를 77원으로 고친다
- **THEN** 입고 전표의 요구 수량은 15, 8 로 따라간다
- **AND** 입고 전표의 단가는 77원이다
- **AND** 이재고가 3개만 받고 나머지를 백오더로 남기면 `qty_received` 는 3, `receipt_status` 는 `partial` 이다
- **AND** 원가 0 이던 평균 원가 제품의 원가는 입고 가격인 77원이 된다

#### Scenario: 입고량과 같게 줄이면 남은 입고가 닫히고 다시 늘리면 새 전표가 생긴다

- **WHEN** 8개 주문에 3개가 입고된 뒤 최구매가 수량을 3개로 줄인다
- **THEN** 완료된 전표는 `done` 으로 남고 남은 전표는 요구 수량 0 으로 `cancelled` 가 된다
- **AND** `receipt_status` 는 `full` 이다
- **AND** 수량을 다시 5개로 늘리면 요구 수량 2 인 새 전표가 생기고 `receipt_status` 는 `partial` 이다
- **AND** 그 상태에서 새 줄을 더하면 열린 전표에 함께 들어간다

### Requirement: 잠긴 주문은 숫자와 취소를 막는다

시스템은 확정된 주문만 잠그고 풀 수 있어야 한다(SHALL). 잠가도 상태는 `purchase` 다. 잠긴 주문은 줄 변경과 취소를 `ERP_LOCKED` 로 막고 머리글은 `note` 와 `vendor_ref` 만 받는다.

#### Scenario: 잠긴 주문은 숫자와 취소가 막히고 메모는 받는다

- **WHEN** 최구매가 10개 확정 주문에서 `잠금` 을 실행한다
- **THEN** `locked` 는 true, 상태는 `purchase` 다
- **AND** 수량이나 단가를 고치면 `ERP_LOCKED` 로 거부된다
- **AND** 결제 조건을 바꾸면 `ERP_LOCKED` 로 거부된다
- **AND** `취소` 는 `ERP_LOCKED` 로 거부된다
- **AND** `note` 와 `vendor_ref` 는 저장된다
- **AND** `잠금 해제` 를 실행하면 `locked` 는 false 가 되고 수량을 11개로 고칠 수 있다
- **AND** 초안 문서에 잠금 명령을 보내면 `ERP_INVALID` 로 거부된다

### Requirement: 공급사가 확인한 일시를 남긴다

시스템은 `공급사 확인 기록` 으로 공급사 확인 일시를 `confirmed_by_vendor_at` 에 남겨야 한다(SHALL). 일시를 주면 그 값을, 주지 않으면 현재 시각을 쓴다.

#### Scenario: 공급사 확인 일시를 기록한다

- **WHEN** 최구매가 확정 주문에서 일시를 넣지 않고 `공급사 확인 기록` 을 실행한다
- **THEN** `confirmed_by_vendor_at` 이 채워진다

### Requirement: 취소와 삭제는 입고와 청구를 넘지 못한다

시스템은 입고가 끝난 전표가 있거나 재화 줄에 직접 입력한 입고 수량이 있으면 `ERP_RECEIVED` 로, 게시된 청구서가 있으면 `ERP_BILLED` 로 취소를 거부해야 한다(SHALL). 초안 청구서는 취소를 막지 않는다. 취소된 문서는 고칠 수 없고 `초안으로` 되돌리거나 지울 수 있으며, 취소되지 않은 문서는 지울 수 없다.

#### Scenario: 취소하지 않은 문서는 지울 수 없다

- **WHEN** 최구매가 초안, 보낸 문서, 구매 주문 상태의 문서를 각각 지우려 한다
- **THEN** 모두 `ERP_INVALID` 로 거부된다

#### Scenario: 취소한 문서는 초안으로 되돌리거나 지울 수 있다

- **WHEN** 최구매가 확정 주문을 `취소` 한다
- **THEN** 상태는 `cancelled`, `receipt_status` 와 `billing_status` 는 `no` 이고 `PurchaseOrderCancelled` 에 `number` 가 실린다
- **AND** 그 문서를 고치거나 다시 확정하면 `ERP_INVALID` 로 거부된다
- **AND** `초안으로` 를 누르면 `draft` 가 된다
- **AND** 다시 취소한 뒤 지우면 문서는 삭제된 것으로 표시된다
- **AND** 지운 문서를 `초안으로` 되돌리려 하면 `ERP_NOT_FOUND` 로 거부된다

#### Scenario: 입고된 주문은 취소할 수 없다

- **WHEN** 최구매가 재화 줄에 입고 수량을 직접 입력한 주문을 취소하려 한다
- **THEN** `ERP_RECEIVED` 로 거부된다
- **AND** 재고가 켜진 회사에서 입고 전표가 완료된 주문을 취소하려 해도 `ERP_RECEIVED` 로 거부된다

#### Scenario: 게시된 청구서는 취소를 막고 초안 청구서는 막지 않는다

- **WHEN** 정회계가 10개 주문의 공급사 청구서를 게시한 뒤 최구매가 그 주문을 취소하려 한다
- **THEN** `ERP_BILLED` 로 거부된다
- **AND** 청구서가 초안뿐인 다른 주문은 취소되어 `cancelled` 가 되고 `billing_status` 는 `no` 다

#### Scenario: 입고 전에 취소하면 입고 전표도 취소되고 다시 확정하면 새 전표가 생긴다

- **WHEN** 재고가 켜진 회사에서 최구매가 2개 주문을 확정한 뒤 입고 전에 취소한다
- **THEN** 입고 전표는 `cancelled`, `receipt_status` 는 `no` 다
- **AND** `초안으로` 되돌려 다시 확정하면 `ready` 인 새 입고 전표가 생겨 전표는 2건이 되고 `receipt_status` 는 `pending` 이다

### Requirement: 전표가 없는 입고 수량은 직접 입력한다

시스템은 확정된 주문에서 `입고 수량 입력`(`receive`, `lines:[{id, qty_received}]`)으로 서비스 줄과 입고 전표가 없는 재화 줄의 입고 수량을 받아야 한다(SHALL). 입고 전표 소식을 들은 주문의 재화 줄은 전표에서 수량이 정해지므로 직접 입력을 거부한다. 어느 모듈이 켜져 있는지가 아니라 전표 소식을 들었는지로 판단한다.

#### Scenario: 재고 없이 입고 수량을 직접 입력한다

- **WHEN** 구매만 켠 회사에서 최구매가 10개, 100원 확정 주문의 입고 수량을 4개로 입력한다
- **THEN** 입력 전 `receipt_status` 와 `billing_status` 는 `no` 였고, 입력 뒤 `qty_received` 는 4, `receipt_status` 는 `partial` 이다
- **AND** `qty_to_bill` 은 4, `billing_status` 는 `to_bill` 이다
- **AND** 10개로 다시 입력하면 `receipt_status` 는 `full`, `qty_to_bill` 은 10 이다

#### Scenario: 잘못된 입고 수량 입력은 거부된다

- **WHEN** 최구매가 입고 수량을 잘못된 곳에 입력한다
- **THEN** 음수 수량은 `ERP_INVALID` 로 거부된다
- **AND** 확정되지 않은 초안에 입력하면 `ERP_INVALID` 로 거부된다
- **AND** 입고 전표가 있는 주문의 재화 줄에 입력하면 `ERP_INVALID` 로 거부된다

#### Scenario: 서비스 줄은 직접 입력하고 입고 상태에 들어가지 않는다

- **WHEN** 최구매가 청구 기준이 `receipt` 인 서비스 2개 확정 주문의 입고 수량을 1로 입력한다
- **THEN** `qty_to_bill` 은 1, `billing_status` 는 `to_bill` 이다
- **AND** 서비스 줄은 입고 대상이 아니므로 `receipt_status` 는 `no` 그대로다
- **AND** 재고가 켜진 회사에서 입고 전표가 있는 주문의 서비스 줄도 입력되고 `receipt_status` 는 전표를 따라 `pending` 이다

#### Scenario: 입고 수량 입력 창은 줄마다 수량을 묻는다

- **WHEN** 김대표가 구매 주문에서 `더 보기` 의 `입고 수량 입력` 을 연다
- **THEN** 창에 글 상자는 없다
- **AND** 줄 이름 에어서큘레이터 로 표시된 수량 칸이 보인다

### Requirement: 입고 상태는 전표 소식으로 정한다

시스템은 전표 소식을 들은 주문의 `receipt_status` 를 전표 상태로 정해야 한다(SHALL). 전표가 없거나 전부 취소되면 `no`, 완료가 없으면 `pending`, 일부 완료면 `partial`, 취소를 뺀 전부가 완료면 `full` 이다. 전표 소식을 들은 적이 없으면 재화 줄의 직접 입력 수량으로 정한다. 전표 단위로 기억하므로 같은 소식을 두 번 들어도 결과가 같다. 출처가 구매 주문이 아니거나 문서가 없는 소식은 무시한다.

#### Scenario: 입고 전표 상태를 따라 입고 상태가 바뀐다

- **WHEN** 10개 주문의 입고 전표가 `ready` 가 된다
- **THEN** `receipt_status` 는 `pending` 이다
- **AND** 그 전표에서 4개가 완료되고 나머지가 다른 전표로 `ready` 이면 `qty_received` 는 4, `receipt_status` 는 `partial` 이고 `date_received` 가 채워진다
- **AND** `qty_to_bill` 은 4, `billing_status` 는 `to_bill` 이다

#### Scenario: 취소된 전표는 입고 상태에서 빠진다

- **WHEN** 4개가 입고된 10개 주문의 남은 전표가 취소된다
- **THEN** 받은 것이 전부이므로 `receipt_status` 는 `full` 이다
- **AND** 새 전표가 열리면 `partial` 이 되고, 그 전표에서 6개가 완료되면 `qty_received` 는 10, `receipt_status` 는 `full` 이다
- **AND** 전표가 전부 취소된 다른 주문의 `receipt_status` 는 `no` 다

#### Scenario: 같은 소식을 다시 받아도 한 번만 세고 남의 소식은 무시한다

- **WHEN** 구매 모듈이 4개 입고 소식을 처음부터 다시 받는다
- **THEN** `qty_received` 는 4 그대로이고 주문에 새 이벤트가 남지 않는다
- **AND** 출처가 판매 주문이거나, 없는 문서이거나, 비어 있는 전표 소식은 주문을 바꾸지 않는다
- **AND** 유형이 `out_invoice` 인 청구서 소식도 주문을 바꾸지 않는다
- **AND** 구매 모듈의 구독은 멈추지 않는다

### Requirement: 입고 수량은 줄 단위로 환산하고 환불 반품만 뺀다

시스템은 `qty_received` 를 완료된 전표 수량의 합을 줄 단위로 환산해 정해야 한다(SHALL). `to_refund` 인 반품은 빼고, 환불 없는 반품은 수량을 바꾸지 않는다. 반품 전표가 열려 있으면 `receipt_status` 는 `partial` 이다.

#### Scenario: 환불 반품은 입고 수량을 줄이고 환불 없는 반품은 그대로 둔다

- **WHEN** 5다스 주문에 입고 전표로 60개가 들어온다
- **THEN** `qty_received` 는 5 다
- **AND** 반품 전표가 열려 있는 동안 `receipt_status` 는 `partial` 이다
- **AND** `to_refund` 반품으로 24개가 나가면 `qty_received` 는 3, `receipt_status` 는 `full` 이다
- **AND** 환불 없는 반품으로 12개가 더 나가도 `qty_received` 는 3 이다
- **AND** 재고가 켜진 회사에서 5개를 받은 주문의 반품 전표로 2개를 돌려보내면 `qty_received` 는 3, `receipt_status` 는 `full`, 재고는 3개다

### Requirement: 청구 대상 수량과 청구 상태는 청구 기준을 따른다

시스템은 `qty_billed` 를 그 주문을 가리키는 공급사 청구서의 합으로 정하되 초안부터 세고, `in_refund` 는 빼고, 취소된 청구서는 빼야 한다(SHALL). 청구서 단위로 기억하므로 초안을 고치면 값이 바뀐다. `qty_to_bill` 은 확정된 주문에서 `bill_policy` 가 `order` 면 `qty - qty_billed`, `receipt` 면 `qty_received - qty_billed` 이고 음수도 그대로 둔다. 확정되지 않은 문서는 0 이다. `billing_status` 는 확정된 주문에서 대상이 0 이 아닌 줄이 있으면 `to_bill`, 없고 취소되지 않은 청구서가 있으면 `billed`, 나머지는 `no` 다.

#### Scenario: 주문 기준 줄은 확정하면 바로 청구 대상이고 청구서 초안부터 센다

- **WHEN** 최구매가 `bill_policy` 가 `order` 인 제품 10개, 600원 주문을 확정한다
- **THEN** `billing_status` 는 `to_bill`, `qty_to_bill` 은 10 이다
- **AND** 정회계가 10개 청구서 초안을 만들면 `qty_billed` 는 10, `qty_to_bill` 은 0, `billing_status` 는 `billed` 다
- **AND** 그 청구서를 게시해도 `billing_status` 는 `billed` 다
- **AND** 그 청구서를 초안으로 되돌려 취소하면 `qty_billed` 는 0, `qty_to_bill` 은 10, `billing_status` 는 `to_bill` 이다

#### Scenario: 입고 기준 줄은 들어온 만큼만 청구 대상이고 음수도 그대로 둔다

- **WHEN** `bill_policy` 가 `receipt` 인 제품 10개 주문에 4개가 입고된다
- **THEN** 입고 전 `no` 이던 `billing_status` 는 `to_bill` 이 된다
- **AND** 4개 청구서 초안이 생기면 주문이 끝나지 않았어도 `billing_status` 는 `billed`, `qty_to_bill` 은 0 이다
- **AND** 그 초안을 9개로 고치면 `qty_billed` 는 9, `qty_to_bill` 은 -5, `billing_status` 는 `to_bill` 이다
- **AND** 4개로 고쳐 게시하면 `billing_status` 는 `billed` 다
- **AND** 4개짜리 `in_refund` 초안이 생기면 `qty_billed` 는 0, `qty_to_bill` 은 4, `billing_status` 는 `to_bill` 이고 소식을 처음부터 다시 받아도 `qty_billed` 는 0 이다

#### Scenario: 서비스 줄도 청구 기준을 따른다

- **WHEN** 최구매가 `bill_policy` 가 `order` 인 서비스 2개, 50원 주문을 확정한다
- **THEN** `billing_status` 는 `to_bill`, `qty_to_bill` 은 2, `receipt_status` 는 `no` 다
- **AND** `bill_policy` 가 `receipt` 인 서비스를 같은 수량으로 확정하면 `billing_status` 는 `no`, `qty_to_bill` 은 0 이다

### Requirement: 처음 산 공급사는 제품의 공급사 목록에 더한다

시스템은 주문을 확정할 때 그 제품의 공급사 목록에 없는 공급사를 `min_qty` 1, `delay_days` 0, 줄의 할인과 구매 단위로 환산한 가격으로 더해야 한다(SHALL). 이미 있는 공급사의 줄은 바꾸지 않는다.

#### Scenario: 처음 산 공급사는 제품의 공급사 목록에 더해진다

- **WHEN** 최구매가 공급사 목록에 없는 바람부품에게서 제습기 7개를 777원에 확정한다
- **THEN** 제습기의 공급사 목록에 바람부품 줄이 `price` 777, `min_qty` 1, `delay_days` 0 으로 더해진다
- **AND** 바람부품 앞으로 제습기 1개를 새로 넣으면 단가는 777원이다
- **AND** 구매 단위가 개인 다른 제품을 2다스, 다스당 720원으로 확정하면 그 제품에 더해진 `price` 는 개당 60 이다

#### Scenario: 이미 있는 공급사의 조건은 바꾸지 않는다

- **WHEN** 최구매가 목록에 777원으로 올라 있는 바람부품에게서 제습기 7개를 111원에 확정한다
- **THEN** 제습기의 바람부품 줄은 1개이고 `price` 는 777 그대로다

### Requirement: 재주문 요청은 요청으로 만든 초안에 모은다

시스템은 재고 모듈의 `ReorderRequested` 를 받아 그 공급사·창고의 요청으로 만든 초안에 줄을 더하고, 그런 초안이 없으면 새 초안을 만들어야 한다(SHALL). 같은 변형·단위 줄이면 수량을 늘린다. 사람이 만든 초안과 이미 보낸 문서에는 넣지 않는다. 요청을 기억하므로 같은 요청을 두 번 받아도 한 번만 더한다.

#### Scenario: 부족이 견적 요청이 되고 입고까지 이어진다

- **WHEN** 재고가 5개이고 재주문 규칙이 최소 10·최대 30·자동이며 바람부품 줄이 50원·납기 0일인 제품에서 스케줄러가 돈다
- **THEN** 바람부품 앞으로 `draft` 문서가 생기고 그 줄은 25개, 50원이다
- **AND** 규칙의 `rfq_qty` 는 25, `forecast` 는 30, `qty_to_order` 는 0 이고 스케줄러가 다시 돌아도 줄은 25개 그대로다
- **AND** 최구매가 `주문 확정` 을 누르면 `ready` 인 입고 전표가 단가 50원으로 생기고 `rfq_qty` 는 0, `incoming` 은 25, `forecast` 는 30, `receipt_status` 는 `pending` 이다
- **AND** 이재고가 전표를 완료하면 `qty_received` 는 25, `receipt_status` 는 `full`, `billing_status` 는 `to_bill`, `qty_to_bill` 은 25 이고 재고는 30개다
- **AND** 원가 0 인 재고 5개와 평균을 내어 제품 원가는 41.666667 이 된다

#### Scenario: 같은 공급사 요청은 요청으로 만든 초안에 모이고 같은 줄은 수량이 는다

- **WHEN** 최구매가 사람이 만든 4개 초안이 있는 제품(최대 30)과 다른 제품(최대 20)의 재주문 규칙에서 차례로 `지금 주문` 을 실행한다
- **THEN** 사람이 만든 초안은 4개 그대로이고 새 초안 한 장에 26개 줄과 20개 줄이 생긴다
- **AND** 수량 3 으로 `지금 주문` 을 다시 실행하면 26개 줄이 29개가 된다
- **AND** 그 초안에 `보냄 표시` 를 한 뒤 들어온 20개 요청은 다른 새 초안으로 간다
- **AND** 그 요청을 다시 받아도 새 초안의 줄은 20개 그대로다

#### Scenario: 구매를 켜고 재주문에서 입고까지 화면으로 진행한다

- **WHEN** 김대표가 모듈 화면에서 구매를 켠 회사에서, 구매·재고 역할을 가진 최구매가 에어서큘레이터에 최소 200·최대 400·자동·공급사 바람부품(50,000원, 납기 10일)인 재주문 규칙을 만들고 박영업이 주문을 확정해 예측 수량이 최소 아래로 내려간다
- **THEN** 구매 주문 목록에 1건이 보이고 번호는 `P00001`, 상태 표시는 `견적 요청` 이다
- **AND** `주문 확정` 을 누르면 상태 표시는 `구매 주문` 이고 `picking_type` 이 `incoming` 인 입고 전표가 생긴다
- **AND** 입고 전표를 완료하면 재고가 그 수량만큼 늘고 전표의 원 문서로 돌아가면 `입고 상태` 는 `입고 완료` 다
- **AND** 예측 화면의 `lead_time` 은 입고 1건으로는 `근거 부족` 이고 `입고 10건 필요` 를 안내한다

### Requirement: 초안 수량은 재고 예측에 들어간다

시스템은 `draft`, `sent`, `to_approve` 문서의 재화 수량이 바뀔 때마다 제품 기준 단위로 `PurchaseDraftQtyChanged`(`number`, `warehouse_id`, `lines`, `requests`)를 내야 한다(SHALL). 재고 모듈은 이 수량을 주문한 것으로 세어, `erp_replenish_list` 의 `rfq_qty`, `forecast`, `qty_to_order` 에 반영한다. 서비스 줄은 알리지 않는다.

#### Scenario: 사람이 만든 초안도 주문한 것으로 센다

- **WHEN** 재고가 없는 제품을 최구매가 4개 초안으로 만들고 그 제품에 최소 10·최대 30 인 재주문 규칙을 둔다
- **THEN** 규칙의 `forecast` 는 4, `qty_to_order` 는 26 이다

#### Scenario: 예측은 초안이 바뀌는 대로 따라간다

- **WHEN** 재고 5개, 최소 10·최대 30 인 규칙에서 `지금 주문` 으로 25개 초안이 생긴 뒤 최구매가 `보냄 표시` 를 한다
- **THEN** 보낸 문서도 세므로 `forecast` 는 30 이다
- **AND** 수량을 5개로 고치면 `forecast` 는 10 이다
- **AND** 문서를 취소하면 `forecast` 는 5, `qty_to_order` 는 25 다
- **AND** `초안으로` 되돌리면 `forecast` 는 10 이다

### Requirement: 재고 없이도 동작하고 재고를 나중에 켜도 옛 주문을 건드리지 않는다

시스템은 재고 모듈 없이 구매를 동작시키고, 재고를 켠 뒤에 확정한 주문부터 입고 전표를 받게 해야 한다(SHALL). 켜기 전에 확정한 주문에는 전표를 만들지 않으며 그 주문은 계속 직접 입력한다.

#### Scenario: 구매만 켠 회사는 입고 전표 없이 확정된다

- **WHEN** 구매만 켠 회사에서 최구매가 4개, 500원 주문을 확정한다
- **THEN** 상태는 `purchase` 이고 입고 전표는 없으며 멈춘 구독도 없다
- **AND** `PurchaseOrderConfirmed` 의 `warehouse_id` 는 `null` 이다
- **AND** 재고도 켠 회사에서는 입고 전표가 1건 생기고, 완료하면 `receipt_status` 는 `full` 이다

#### Scenario: 재고를 나중에 켜면 옛 주문은 직접 입력하고 새 주문은 전표를 받는다

- **WHEN** 구매만 쓰던 회사에서 5개 주문을 확정한 뒤 김대표가 재고를 켠다
- **THEN** 옛 주문에는 입고 전표가 생기지 않는다
- **AND** 옛 주문의 입고 수량을 5개로 직접 입력하면 `receipt_status` 는 `full` 이다
- **AND** 새로 확정한 5개 주문에는 입고 전표가 1건 생긴다
- **AND** 모든 문서의 상태는 원장을 다시 읽은 결과와 같다

### Requirement: 확정을 되돌리면 입고 전표도 함께 되돌아간다

시스템은 관리자가 주문 확정을 되돌릴 때 그 확정으로 생긴 입고 전표까지 미리 보여 주고 함께 되돌려야 한다(SHALL). `RfqSent` 와 `PurchaseOrderConfirmed` 는 이미 외부에 알려진 일이므로 미리보기에 경고를 낸다. 쌓인 이벤트로 전부 다시 만들어도 숫자가 같아야 한다.

#### Scenario: 확정을 되돌리면 입고 전표도 사라지고 다시 확정할 수 있다

- **WHEN** 재고가 켜진 회사에서 김대표가 5개 주문의 확정을 되돌리는 미리보기를 연다
- **THEN** 되돌아갈 문서에 입고 전표가 들어 있다
- **AND** 적용하면 주문은 `draft` 가 되고 입고 전표는 남지 않는다
- **AND** 다시 확정하면 입고 전표가 1건 생긴다
- **AND** 모든 문서의 상태는 원장을 다시 읽은 결과와 같다

#### Scenario: 확정을 되돌리는 미리보기는 공급사에게 따로 알리라고 경고한다

- **WHEN** 김대표가 확정된 주문을 되돌리는 미리보기를 연다
- **THEN** `warnings` 에 `PurchaseOrderConfirmed` 와 함께 "외부에 이미 알려진 일입니다. 시스템만 되돌아가니 상대방에게 따로 알려야 합니다" 가 실린다

#### Scenario: 전부 다시 만들어도 숫자가 같다

- **WHEN** 구매와 재고가 함께 일한 회사에서 김대표가 `erp_rebuild` 로 원장에서 전부 다시 만든다
- **THEN** 재고 수량, 열린 입출고 수량, 초안 수량은 전과 같다
- **AND** 모든 문서의 상태는 원장을 다시 읽은 결과와 같다
- **AND** 멈춘 구독은 없다

### Requirement: 구매 문서는 구매·회계 역할과 관리자만 읽는다

시스템은 구매 문서와 구매 보고서를 `purchase`, `accounting` 역할과 관리자에게만 보여 주고, 만들고 고치는 명령은 `purchase` 역할과 관리자에게만 허용해야 한다(SHALL). `erp_purchase_dashboard` 는 `purchase`, `accounting`, 관리자가, `erp_vendor_catalog` 는 `purchase` 와 관리자가 부를 수 있다.

#### Scenario: 구매·회계 역할이 아니면 구매 문서가 보이지 않는다

- **WHEN** 영업 역할만 가진 박영업이 구매 문서를 읽거나 만들려 한다
- **THEN** `erp_records` 와 `erp_purchase_report` 의 구매 행은 0건이다
- **AND** 문서를 만들려 하면 `ERP_FORBIDDEN` 으로 거부된다
- **AND** `erp_purchase_dashboard` 를 부르면 `ERP_FORBIDDEN` 으로 거부된다

#### Scenario: 회계 역할은 구매 문서를 읽기만 한다

- **WHEN** 회계 역할만 가진 정회계가 구매 문서를 읽거나 만들려 한다
- **THEN** `erp_records` 와 `erp_purchase_report` 에서 구매 문서가 보이고 `erp_purchase_dashboard` 도 답한다
- **AND** 문서를 만들려 하면 `ERP_FORBIDDEN` 으로 거부된다
- **AND** `erp_vendor_catalog` 를 부르면 `ERP_FORBIDDEN` 으로 거부된다

### Requirement: 구매 현황을 공개 조회로 돌려준다

시스템은 줄 단위 보고서 `erp_purchase_report`, 현황 집계 `erp_purchase_dashboard()`, 공급사별 카탈로그 `erp_vendor_catalog(partner_id)` 를 돌려주어야 한다(SHALL). 이 셋을 쓰는 화면은 없고 공개 뷰와 함수로만 읽는다. 보고서는 수량·입고·청구 수량, 단가, 금액, `avg_cost`, `days_to_confirm`, `days_to_receive`, `weight`, `volume`, `is_late` 를 낸다. 집계는 `to_send`, `waiting_reply`, `to_approve`, `late`, `mine_to_send`, `mine_waiting`, `mine_late`, `amount_7d`, `lead_days_7d`, `sent_7d` 를 낸다. 카탈로그는 제품별 `product_id`, `name`, `vendor_code`, `min_qty`, `price`, `discount`, `delay_days`, `date_start`, `date_end` 를 낸다.

#### Scenario: 줄 단위 구매 보고서를 읽는다

- **WHEN** 최구매가 바람부품 줄 40원인 제품 5개를 확정한 뒤 `erp_purchase_report` 에서 그 주문을 읽는다
- **THEN** 행은 1개이고 `number` 는 주문 번호, `state` 는 `purchase`, `qty` 는 5, `subtotal` 은 200, `avg_cost` 는 40 이다

#### Scenario: 구매 현황 집계를 읽는다

- **WHEN** 200원 주문을 확정하고 주문 마감일이 2020-01-01 인 문서에 `보냄 표시` 를 한 뒤 최구매가 `erp_purchase_dashboard` 를 부른다
- **THEN** `waiting_reply`, `late`, `sent_7d` 는 1 이상이다
- **AND** `amount_7d` 는 200 이상이다

#### Scenario: 공급사 카탈로그를 읽는다

- **WHEN** 최구매가 바람부품으로 `erp_vendor_catalog` 를 부른다
- **THEN** 바람부품 줄이 있는 제품의 `product_id` 와 함께 `vendor_code` `X1`, `delay_days` 3 이 돌아온다

### Requirement: 구매가 꺼지면 명령이 막히고 문서는 남는다

시스템은 구매 모듈이 꺼져 있으면 구매 명령을 `ERP_MODULE_OFF` 로 거부하고 메뉴를 숨기되 문서는 지우지 않아야 한다(SHALL). 구매 문서의 칸 중 입고 창고는 재고, 청구 상태와 청구 수량은 청구 모듈이 켜져 있을 때만 보인다.

#### Scenario: 구매를 끄면 명령이 막히고 문서는 남는다

- **WHEN** 구매가 꺼진 회사에서 김대표가 구매 문서를 만들려 한다
- **THEN** `ERP_MODULE_OFF` 로 거부된다
- **AND** 구매를 켜서 문서를 만든 뒤 다시 끄면 그 문서의 `send` 는 `ERP_MODULE_OFF` 로 거부된다
- **AND** 문서는 남아 있다

#### Scenario: 구매가 꺼지면 메뉴가 없고 켜면 나타난다

- **WHEN** 판매만 켠 회사에서 김대표가 모듈 화면을 연다
- **THEN** 구매 카드는 `꺼짐` 이고 메뉴에 구매가 없다
- **AND** 구매 카드에서 켜기를 누르고 `구매 모듈 켜기` 창에서 확인하면 메뉴에 구매가 나타난다

#### Scenario: 재고나 청구가 꺼지면 그 칸이 보이지 않는다

- **WHEN** 구매만 켠 회사에서 최구매가 `erp_catalog` 로 구매 문서의 칸을 받는다
- **THEN** `warehouse_id`, `billing_status`, 줄의 `qty_billed`, `qty_to_bill` 은 없다
- **AND** `receipt_status` 는 있다
