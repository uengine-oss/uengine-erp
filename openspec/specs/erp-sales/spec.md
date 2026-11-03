# 판매

## Purpose

견적을 만들어 보내고 주문으로 확정하고, 그 주문의 납품·청구 진행을 보여 준다. 판매 모듈은 다른 모듈이 없어도 혼자 동작하고, 재고·청구와는 이벤트로만 만나므로 납품 상태와 청구 상태는 그 모듈들이 알린 사실로만 움직인다. 시나리오의 회사는 가상의 가온가전이고, 금액은 소수 자리 없는 원 단위이며, 따로 말하지 않으면 제품은 정가 1,000원·원가 600원에 10% 별도 세금이 붙어 있다.

## Requirements

### Requirement: 판매 모듈만으로 견적에서 주문까지 끝난다

시스템은 재고·구매·청구·회계 모듈이 모두 꺼져 있어도 견적을 만들고 보내고 주문으로 확정할 수 있어야 한다(SHALL). 재고·청구가 없는 주문의 `delivery_status` 와 `invoice_status` 는 `no`(카탈로그 라벨 「해당 없음」)로 남아야 한다(MUST). 꺼진 모듈 소속의 칸은 카탈로그와 화면에서 사라지고, 입력할 수 있는 칸(`warehouse_id`, `shipping_policy`)에 값을 넣으면 `ERP_MODULE_OFF` 로 거부한다.

#### Scenario: 판매만 켜진 회사에서 견적을 보내고 주문으로 확정한다

- **WHEN** 박영업이 판매만 켜진 회사의 새 견적에 고객 가온마트와 에어서큘레이터(정가 89,000원) 3개를 넣는다
- **THEN** 저장하기 전에 단가 89,000, 공급가액 267,000, 합계 293,700 이 보인다
- **AND** 저장하면 번호 `S00001` 의 「견적」이 되고, 「견적 보내기」를 누르면 「보낸 견적」, 「주문 확정」을 누르면 「주문」이 된다
- **AND** 주문 화면에 납품 상태·청구 상태 칸과 줄의 청구 수량 칸이 없다
- **AND** 메뉴의 판매 아래에 「견적·주문」, 「견적 양식」, 「연락처」, 「제품」, 「가격표」가 있고 재고·구매·청구·회계 메뉴는 없다
- **AND** 출고 전표를 만드는 명령을 직접 보내면 `ERP_MODULE_OFF` 로 거부된다

#### Scenario: 재고와 청구가 없으면 두 상태는 해당 없음이다

- **WHEN** 재고·청구가 꺼진 회사에서 박영업이 제습기 10개를 할인 10% 로 견적을 만들어 보내고 확정한다
- **THEN** 합계는 9,900 이고 상태는 `sale` 이며 `delivery_status` 와 `invoice_status` 는 `no` 이고, 구독이 다 돈 뒤에도 `delivery_status` 는 `no` 다
- **AND** 출고 전표는 생기지 않고 `SalesOrderConfirmed` 의 `warehouse_id` 는 `null` 이다
- **AND** 창고(`warehouse_id`)를 넣어 견적을 만들려 하면 `ERP_MODULE_OFF` 로 거부된다
- **AND** 이 회사의 카탈로그에는 `warehouse_id`, `shipping_policy`, `delivery_status`, `invoice_status`, `amount_invoiced`, `invoices`, `pickings` 와 줄의 `qty_invoiced`, `qty_to_invoice` 가 없고 줄의 `qty_delivered` 는 있다

#### Scenario: 청구 모듈을 나중에 켜면 고른 날짜 이후의 주문만 청구 상태가 뜻을 갖는다

- **WHEN** 제습기 10개 주문이 확정되어 있는 회사에서 김대표가 청구 모듈을 `orders_since` `2000-01-01` 로 켠다
- **THEN** 그 주문의 `invoice_status` 는 `to_invoice` 가 되고 카탈로그에 `invoice_status` 가 나타난다
- **AND** 꺼져 있는 동안에도 줄의 `qty_to_invoice` 는 10 으로 계산되어 있다
- **AND** 다른 회사에서 `orders_since` 를 `2999-01-01` 로 켜면 확정 주문의 `invoice_status` 는 `no` 로 남는다

### Requirement: 견적은 번호와 합계·마진·예상 납품일을 스스로 계산한다

시스템은 견적을 만들 때 `S00001` 형식의 번호를 정하고, 줄과 머리글의 공급가액·세액·합계, 마진(공급가액 - 원가 × 수량), 마진율(공급가액 대비), `expected_date`(주문일 + 납기 일수, `direct` 면 가장 빠른 줄, `one` 이면 가장 늦은 줄), `shipping_weight` 를 계산해야 한다(SHALL). 저장할 때 화면이 줄 전체를 보내도 원장에는 바뀐 것만 이벤트로 남아야 한다(MUST).

#### Scenario: 번호와 합계와 마진과 예상 납품일이 줄에서 계산된다

- **WHEN** 박영업이 납기 5일·무게 2 인 제습기 2개를 할인 10% 로, 납기 9일·무게 1 인 가습기 1개를 한 견적에 넣는다
- **THEN** 번호는 `S` 와 숫자 다섯 자리이고 다음 견적의 번호는 1 크다
- **AND** 첫 줄은 공급가액 1,800, 원가 600, 마진 600, 마진율 0.333333 이다
- **AND** 견적은 공급가액 2,800, 세액 280, 합계 3,080, 마진 1,000, `shipping_weight` 5 다
- **AND** `expected_date` 는 주문일 + 5일이고, 배송 정책을 「한 번에」(`one`)로 바꾸면 주문일 + 9일이 된다

#### Scenario: 구역과 메모 줄은 금액 없이 줄 사이에 놓인다

- **WHEN** 박영업이 구역 「본체」, 제습기 1개, 메모 「주의」 순서로 줄을 넣고 저장한다
- **THEN** 구역과 메모의 수량과 공급가액은 0 이고 `sequence` 는 차례로 10, 20, 30 이다
- **AND** 줄 순서를 바꿔 저장하면 `QuotationLinesReordered` 가 남고 `sequence` 는 새 순서로 10, 20, 30 이 된다
- **AND** 구역 줄에 제품을 넣으면 `ERP_INVALID`, 내용 없는 메모 줄은 `ERP_REQUIRED` 로 거부된다

#### Scenario: 저장하면 바뀐 것만 이벤트로 남는다

- **WHEN** 제습기 1개와 2개 두 줄이 있는 견적에 같은 줄 전체를 그대로 다시 저장 요청한다
- **THEN** 이벤트는 `QuotationCreated` 하나뿐이다
- **AND** 메모를 고치면 `QuotationUpdated`, 첫 줄 수량을 3 으로 고치면 합계 5,500 과 함께 `QuotationLineChanged` 가 남는다
- **AND** 줄을 더하면 `QuotationLineAdded`, 첫 줄만 남기면 합계 3,300 과 함께 `QuotationLineRemoved` 가 남는다

### Requirement: 견적·주문 목록은 실제 문서를 보여 준다

시스템은 「견적·주문」 목록에 주문을 한 줄씩 보여 주고, 열은 번호, 고객, 주문일, 유효기간, 담당 영업, 켜진 모듈의 청구 상태·납품 상태, 합계, 상태여야 한다(SHALL).

#### Scenario: 견적·주문 목록에 주문이 보인다

- **WHEN** 주문이 있는 회사에서 김대표가 「견적·주문」 목록을 연다
- **THEN** 표에 주문이 한 줄 이상 보인다
- **AND** 표의 열은 번호, 고객, 주문일, 유효기간, 담당 영업, 켜진 모듈의 청구 상태·납품 상태, 합계, 상태다

### Requirement: 고객을 고르면 그 조건이 함께 온다

시스템은 고객을 필수로 받고, 소속 회사(최상위 연락처)의 가격표·결제 조건·세금 조정·담당 영업을 가져와야 한다(SHALL). 가격표가 없으면 「기본 가격표」, 세금 조정이 없으면 납품처 국가의 `auto_apply` 조정, 담당 영업이 없으면 견적을 쓴 사람이다. 청구지와 배송지는 그 연락처, 하위 연락처, 상위 연락처 순서로 해당 유형의 주소를 찾고 없으면 그 연락처 자신이다. 견적의 고객을 바꾸면 이 값들이 함께 바뀌어야 하고 이전 고객의 값이 남아서는 안 된다(MUST).

#### Scenario: 고객을 고르면 소속 회사의 조건과 주소가 오고 없으면 기본값을 쓴다

- **WHEN** 회사 거래처 바른유통에 가격표(10% 할인), 결제 조건 「30일」, 세금 조정(10% 를 0% 로), 담당 영업과 청구지·배송지·담당자 연락처가 있고, 박영업이 회사 또는 담당자 연락처로 제습기 2개 견적을 만든다
- **THEN** 두 경우 모두 청구지와 배송지는 그 연락처들이고 가격표, 결제 조건, 세금 조정, 담당 영업은 회사의 것이다
- **AND** 줄은 단가 1,000, 할인 10, 합계 1,800 이고 세금은 0% 세금이다
- **AND** 아무 조건도 없는 고객이면 가격표는 「기본 가격표」, 청구지는 그 고객, 담당 영업은 견적을 쓴 사람이다
- **AND** 국가가 `US` 인 고객이면 `US` 에 걸린 `auto_apply` 세금 조정이 온다
- **AND** 고객 없이 견적을 만들면 `ERP_REQUIRED` 로 거부된다

#### Scenario: 견적의 고객을 바꾸면 조건이 함께 바뀐다

- **WHEN** 박영업이 결제 조건 없는 고객의 견적을 결제 조건 「15일」인 고객으로 바꾼다
- **THEN** 결제 조건은 「15일」이 되고 청구지와 배송지도 새 고객이 된다
- **AND** 다시 처음 고객으로 바꾸면 결제 조건은 `null` 로 비워진다

### Requirement: 유효 기한은 기본값을 갖고 만료는 상태를 바꾸지 않는다

시스템은 `validity_date` 를 호출자가 준 값, 양식의 `validity_days`, 회사의 「기본 견적 유효 일수」(`quotation_validity_days`, 없으면 30) 순서로 정하고, 0 일이나 `null` 이면 기한 없음으로 두어야 한다(SHALL). `require_signature` 기본값은 켜짐, `require_payment` 는 꺼짐, `prepayment_percent` 는 100 이다. 만료는 오늘에 달렸으므로 상태로 저장하지 않고, 공개 함수 `erp_sales_expired`, 미리보기와 포털의 `is_expired` 로 답해야 한다(MUST). 앱 화면에는 만료 표시가 없다. 만료된 견적, 줄 없는 견적, 판매 불가 제품의 줄은 사람이 확정할 수 있고, 제품 없는 줄은 저장은 되지만 확정이 거부된다.

#### Scenario: 새 견적의 유효 기한과 서명·결제 기본값

- **WHEN** 박영업이 유효기간을 넣지 않고 새 견적을 만든다
- **THEN** `validity_date` 는 오늘 + 30일이고 `require_signature` 는 `true`, `require_payment` 는 `false`, `prepayment_percent` 는 100 이다
- **AND** `validity_date` 를 `null` 로 주면 기한이 없다

#### Scenario: 만료된 견적도 상태는 그대로이고 사람이 확정할 수 있다

- **WHEN** 유효기간이 2020-01-01 인 견적을 `erp_sales_expired` 와 미리보기로 묻는다
- **THEN** `erp_sales_expired` 는 그 견적의 ID 를 돌려주고 미리보기의 `is_expired` 는 `true` 이며 상태는 `draft` 그대로다
- **AND** 박영업이 「주문 확정」을 누르면 `sale` 이 되고 `erp_sales_expired` 는 빈 목록을 돌려준다

#### Scenario: 줄 없는 견적은 확정되고 제품 없는 줄은 확정이 거부된다

- **WHEN** 박영업이 줄 없는 견적을 확정한다
- **THEN** `sale` 이 되고 `invoice_status` 는 `no` 다
- **AND** 설명 「배송비」, 단가 5, 수량 1 인 제품 없는 줄은 합계 5 로 저장되지만 확정은 `ERP_INVALID` 로 거부된다
- **AND** 판매 가능을 끈 제품(`sale_ok: false`)의 줄은 확정된다
- **AND** 제품도 설명도 없는 줄은 저장이 `ERP_REQUIRED` 로 거부된다

### Requirement: 견적 양식은 비운 값을 채운다

시스템은 양식을 고른 견적에서 호출자가 비운 줄·선택 제품·약관·유효 기한·서명·결제 값을 양식으로 채워야 한다(SHALL). 있는 견적에서 양식을 새로 고르면 줄과 선택 제품을 양식 것으로 바꾼다. 양식의 유효 일수 0 은 기한 없음이다. 양식에 제품 없는 줄, 0~100 밖의 선결제 비율, 음수 유효 일수를 넣으면 거부해야 한다(MUST).

#### Scenario: 양식이 줄과 선택 제품과 조건을 채우고 직접 넣은 값이 먼저다

- **WHEN** 유효 일수 7, 약관 「양식 약관」, 서명·결제 요구, 선결제 50%, 구역 「기본」과 제습기 2개, 선택 제품 가습기(정가 50원) 3개인 양식으로 박영업이 고객만 골라 견적을 만든다
- **THEN** 유효기간은 오늘 + 7일, 약관은 「양식 약관」, `require_signature` 와 `require_payment` 는 `true`, `prepayment_percent` 는 50 이다
- **AND** 줄은 구역과 제습기 2개이고 공급가액 2,000, 세액 200, 합계 2,200 이며 선택 제품은 수량 3, 단가 50, `added: false` 다
- **AND** 같은 양식에 메모 「직접」, 유효기간 2030-01-01, 제습기 9개 줄을 직접 넣으면 그 값들이 저장되고 줄은 그 한 줄이다
- **AND** 유효 일수 0 인 양식의 견적은 `validity_date` 가 `null` 이다

#### Scenario: 있는 견적에서 양식을 고르면 줄이 바뀌고 양식의 잘못된 값은 거부된다

- **WHEN** 줄이 하나인 견적에서 박영업이 위 양식을 고른다
- **THEN** 줄은 양식의 두 줄이 되고 유효기간은 오늘 + 7일이 된다
- **AND** 양식 줄에 제품이 없으면 `ERP_REQUIRED`, 선결제 비율 150 이나 유효 일수 -1 은 `ERP_INVALID` 로 거부된다

### Requirement: 단가는 가격표를 따르고 입력한 값은 입력한 대로 남는다

시스템은 줄 단가를 가격표로 계산하고 입력하지 않은 단가는 수량을 따라 다시 계산해야 한다(SHALL). 입력한 단가는 소수 자릿수까지 그대로 저장하고(`price_manual`) 수량이 바뀌어도 유지하되, 할인은 수량이 바뀌면 규칙 값으로 돌아온다. 이미 청구된 줄의 단가는 수량이 바뀌거나 「가격 다시 계산」(`update_prices`)을 해도 그대로여야 한다(MUST). 제품이나 단위를 바꾸면 입력한 단가도 잊고 처음부터 계산한다. 가격표나 세금 조정을 바꿔도 줄은 「가격 다시 계산」, 「세금 다시 계산」(`update_taxes`) 전까지 그대로다. 수량은 단위의 반올림으로, 할인은 소수 둘째 자리로 저장하며 100 을 넘는 할인, 음수 할인, 음수 수량도 받는다.

#### Scenario: 계산된 단가는 수량을 따르고 입력한 단가는 남는다

- **WHEN** 10개 이상이면 10% 할인하는 가격표의 제습기 1개 줄을 10개로 바꾼다
- **THEN** 단가 1,000 에 할인은 0 에서 10 이 된다
- **AND** 단가 777, 할인 5 를 입력하면 `price_manual` 이 `true` 가 되고, 수량을 11 로 바꾸면 단가 777 은 남고 할인은 10 으로 돌아온다
- **AND** 「더 보기」의 「가격 다시 계산」을 누르면 단가 1,000, 할인 10, `price_manual` `false` 가 된다

#### Scenario: 확정 줄도 수량을 따라 단가가 바뀌지만 청구된 단가는 그대로다

- **WHEN** 10개 이상이면 고정 가격 500 인 가격표의 제습기 1개 주문을 확정하고 수량을 10, 다시 2 로 바꾼다
- **THEN** 단가는 500, 다시 1,000 으로 따라간다
- **AND** 그 줄이 청구서 초안에 2개 올라간 뒤에는 수량을 10 으로 바꿔도 「가격 다시 계산」을 눌러도 단가는 1,000 이다

#### Scenario: 가격표나 세금 조정을 바꿔도 줄은 요청 전까지 그대로이고 다른 제품은 처음부터 계산한다

- **WHEN** 제습기 2개, 단가 777, 할인 3 인 견적의 가격표를 고정 가격 123 인 것으로, 세금 조정을 10% 를 5% 로 바꾸는 것으로 고른다
- **THEN** 줄의 단가 777 과 10% 세금은 그대로다
- **AND** 「세금 다시 계산」을 누르면 세금은 5% 가 되고 단가 777 은 그대로이며 세액은 75 다
- **AND** 그 줄의 제품을 가습기(정가 500원, 5% 세금, 판매 설명 있음)로 바꾸면 단가 123, 할인 0, 세금 5% 이고 설명은 제품 이름과 판매 설명 두 줄이다
- **AND** 설명을 직접 쓴 줄은 그 설명이 저장된다

#### Scenario: 세금 조정은 전부 포함 세금인 줄의 단가만 바꾼다

- **WHEN** 정가 1,100원에 10% 포함 세금만 있는 제품을 10% 포함을 0% 별도로 바꾸는 세금 조정으로 견적에 넣는다
- **THEN** 단가, 공급가액, 세액, 합계는 1,000, 1,000, 0, 1,000 이다
- **AND** 5% 포함으로 바꾸는 조정이면 1,050, 1,000, 50, 1,050, 세금을 없애는 조정이면 1,000, 1,000, 0, 1,000 이다
- **AND** 10% 포함과 5% 별도 세금이 함께 있는 제품은 단가가 1,100 그대로이고, 포함 세금을 없애는 조정이면 1,100, 1,100, 55, 1,155, 5% 포함으로 바꾸는 조정이면 1,100, 1,048, 104, 1,152 이다

#### Scenario: 수량과 할인은 소수 둘째 자리로 단가는 입력한 그대로 저장된다

- **WHEN** 박영업이 수량 1.23456, 단가 1234.56789, 할인 12.34567 을 입력한다
- **THEN** 수량 1.23, 단가 1234.56789, 할인 12.35, 공급가액 1,331, 세액 133, 합계 1,464 가 된다
- **AND** 할인 150 은 공급가액 -500, 할인 -10 은 공급가액 1,100 으로 저장된다
- **AND** 수량 -2 는 합계 -2,200 으로 저장된다

### Requirement: 다른 단위로 팔 수 있다

시스템은 같은 분류의 다른 단위로 줄을 받으면 단가와 원가를 그 단위로 환산하고, 전표가 다른 단위로 알린 수량도 줄의 단위로 환산해야 한다(SHALL). 다른 분류의 단위는 `ERP_UOM` 으로 바로 거부하고, 확정 뒤에는 단위를 바꿀 수 없다(MUST).

#### Scenario: 다스로 팔면 단가와 원가와 출고 수량이 환산된다

- **WHEN** 박영업이 정가 10원·원가 6원에 세금 없는 제품을 다스 단위로 2개 넣는다
- **THEN** 단가 120, 원가 72, 공급가액 240, 마진 96 이다
- **AND** 단위를 「개」로 바꾸면 단가는 10 으로 다시 계산되고, `kg` 으로 바꾸면 `ERP_UOM` 으로 거부된다
- **AND** 다스 2개로 확정한 주문에 「개」 단위 24개 출고 이벤트가 오면 `qty_delivered` 는 2 다
- **AND** 확정 뒤 단위를 「개」로 바꾸면 `ERP_INVALID` 로 거부된다

### Requirement: 줄은 변형을 쓴다

시스템은 줄에 `variant_id` 를 쓰고, `product_id` 만 주면 그 제품의 유일한 변형이나 `value_ids` 가 가리키는 조합을 찾아야 한다(SHALL). `dynamic` 속성의 조합은 처음 주문할 때 변형이 생긴다. `no_variant` 값의 추가 금액은 정가에 더하고 값은 설명 끝에 붙인다. 어느 변형인지 정할 수 없으면 `ERP_INVALID` 로 거부해야 한다(MUST). 앱 화면의 줄에는 속성값을 고르는 칸이 없어 `value_ids` 는 명령으로만 줄 수 있다.

#### Scenario: 속성 방식에 따라 변형이 정해지고 값이 단가에 더해진다

- **WHEN** 박영업이 `dynamic` 속성 값 A, B 를 가진 정가 100원·세금 없는 제품을 `value_ids` 로 값 A 를 골라 2개 넣는다
- **THEN** 변형이 없던 제품에 변형이 하나 생기고 합계는 200 이며, 같은 값의 다음 견적은 같은 변형을 쓴다
- **AND** 값을 고르지 않고 제품만 넣으면 `ERP_INVALID` 로 거부된다
- **AND** `no_variant` 값 Yes(추가 25원)를 고른 정가 100원 제품 2개는 단가 125, 공급가액 250 이고 설명 끝에 「속성 이름: Yes」가 붙으며, 고정 가격 50 인 가격표에서는 단가 50 이다
- **AND** `always` 속성 값 R(추가 10원), G 를 가진 정가 100원 제품은 변형이 둘이고 R 변형의 단가는 110 이며, 변형 없이 제품만 넣으면 `ERP_INVALID` 로 거부된다

### Requirement: 콤보는 금액 없는 줄과 고른 항목 줄로 팔린다

시스템은 콤보 제품 줄에 `combo_items`(항목 ID 목록)를 받으면 콤보 줄(단가 0, 세금 없음)과 고른 항목 줄(`linked_line_id`, `combo_item_id`, 항목 자신의 세금)을 함께 만들어야 한다(SHALL). 앱 화면에는 항목을 고르는 칸이 없어 명령으로만 줄 수 있다. 항목은 따로 수량을 주지 않으면 콤보 줄의 수량을 따르고, 콤보 줄을 지우면 함께 지워진다. 콤보 줄은 주문의 청구 상태 계산에서 빠져야 한다(MUST).

#### Scenario: 콤보는 단가 0 인 줄과 몫대로 값이 매겨진 항목 줄이 되고 항목은 콤보 줄을 따른다

- **WHEN** 정가 1,200원 세트(메인: 제습기 또는 정가 500원·5% 세금·추가 50원인 가습기, 사이드: 정가 300원 전기히터)를 가습기와 전기히터로 골라 2개 넣는다
- **THEN** 콤보 줄은 단가 0, 공급가액 0, `product_type` `combo`, 세금 없음이다
- **AND** 가습기 줄은 단가 800, 수량 2, 5% 세금에 `linked_line_id` 가 콤보 줄이고 전기히터 줄은 단가 450, 수량 2 이며, 견적은 공급가액 2,500, 세액 170, 합계 2,670 이다
- **AND** 메인을 제습기로 고르면 단가는 750 이다
- **AND** 10% 할인 가격표에서 가습기 줄은 단가 800, 할인 10, 공급가액 720 이다
- **AND** 세트에 없는 항목을 주면 `ERP_INVALID` 로 거부된다
- **AND** 세트 줄의 수량을 3 으로 바꾸면 세 줄 모두 3 이 되고, 항목 하나를 빼고 저장하면 두 줄이 남으며, 줄을 모두 비우면 줄이 없다
- **AND** 세트 1개 주문을 확정하면 `SalesOrderConfirmed` 의 줄 `type` 은 `combo`, `goods`, `goods` 이고 항목 줄의 `linked_line_id` 는 콤보 줄이다
- **AND** 두 항목 줄만 청구서 초안에 올라오면 `invoice_status` 는 `invoiced` 다
- **AND** 그 주문을 복제하면 세 줄이 그대로 오고 항목 줄은 새 콤보 줄에 연결된다

### Requirement: 일괄 할인은 세 방식으로 주문 전체에 걸린다

시스템은 「더 보기」의 「일괄 할인」(`apply_discount{type, value}`)에서 「줄마다 할인율」(`line`), 「할인 줄(비율)」(`order`), 「할인 줄(금액)」(`amount`)을 제공해야 한다(SHALL). `order` 는 세금 조합마다 그 조합 공급가액의 비율만큼, `amount` 는 세금 포함 합계를 그 금액만큼 줄이도록 조합의 세금 포함 합계 비율로 나눠 음수 줄을 하나씩 더한다. 음수 줄은 서비스 제품이고 주문이 나중에 바뀌어도 그대로다. 확정·잠긴 주문에도 되고, 값 0 이나 줄 없는 주문은 아무 일도 하지 않으며, 비율 100 초과와 모르는 방식은 `ERP_INVALID`, 값이 없으면 `ERP_REQUIRED`, 취소된 주문은 `ERP_STATE` 로 거부해야 한다(MUST).

#### Scenario: 세금이 하나인 주문의 세 가지 일괄 할인

- **WHEN** 제습기 2개와 정가 50원 가습기 1개 견적에 박영업이 「줄마다 할인율」 10 을 준다
- **THEN** 두 줄의 할인은 10 이 되고 공급가액 1,845, 세액 185, 합계 2,030 이다
- **AND** 같은 견적에 「할인 줄(비율)」 10 을 주면 수량 1, 단가 -205, `product_type` `service`, `invoice_policy` `order`, 설명 「할인 10%」, 10% 세금인 줄이 더해지고 1,845, 184, 2,029 이며, 나중에 수량을 바꿔도 그 줄의 단가는 -205 다
- **AND** 같은 견적에 「할인 줄(금액)」 500 을 주면 단가 -454.545455, 설명 「할인」인 줄이 더해지고 1,595, 159, 1,754 다
- **AND** 다른 모듈이 모두 꺼진 회사에서도 제습기 2개에 「할인 줄(비율)」 10 을 주면 합계 1,980 이고 더해진 줄은 `service` 다

#### Scenario: 세금 조합마다 음수 줄이 하나씩 더해진다

- **WHEN** 제습기 2개(10%), 정가 500원 가습기 1개(5%), 정가 300원 전기히터 1개(세금 없음) 견적에 「할인 줄(비율)」 10 을 준다
- **THEN** 단가, 공급가액, 세액이 -200, -200, -20 과 -50, -50, -3 과 -30, -30, 0 인 줄 셋이 더해지고 공급가액 2,520, 세액 202, 합계 2,722 이다
- **AND** 줄 설명은 「대상」으로 끝나고 세금 없는 조합의 설명에는 「세금 없음」이 있다
- **AND** 같은 견적에 「할인 줄(금액)」 500 을 주면 단가는 -330.578512, -82.644628, -49.586777 이고 2,336, 188, 2,524 다

#### Scenario: 확정되거나 잠긴 주문에도 일괄 할인이 되고 잘못된 값은 거부된다

- **WHEN** 제습기 2개 확정 주문에 「할인 줄(비율)」 10 을 준다
- **THEN** 합계는 1,980 이고 `SalesOrderLineAdded` 가 남으며 할인 줄의 `qty_to_invoice` 는 1 이다
- **AND** 이어서 「줄마다 할인율」 20 을 주면 할인 줄을 포함한 두 줄의 할인이 20 이 된다
- **AND** 잠근 뒤에도 「줄마다 할인율」 30 과 「할인 줄(비율)」 5 가 된다
- **AND** 제습기 1개 견적에 비율 150 이나 모르는 방식을 주면 `ERP_INVALID`, 값을 주지 않으면 `ERP_REQUIRED` 로 거부된다
- **AND** 값 0 이나 줄 없는 견적은 버전이 그대로이고, 비율 -10 은 인상이라 합계가 1,210 이 된다

#### Scenario: 가격 다시 계산은 할인 줄도 0 으로 돌리고 취소된 주문은 다시 계산을 거부한다

- **WHEN** 제습기 2개 견적에 「할인 줄(비율)」 10 을 넣어 합계가 1,980 이 된 뒤 「가격 다시 계산」을 누른다
- **THEN** 할인 줄의 단가는 -200 에서 0 이 되고 합계는 2,200 으로 돌아간다
- **AND** 취소된 주문에 「일괄 할인」, 「가격 다시 계산」, 「세금 다시 계산」을 요청하면 모두 `ERP_STATE` 로 거부된다

### Requirement: 선택 제품은 합계 밖에 있다가 요청하면 줄이 된다

시스템은 `optional_lines` 를 줄처럼 값을 매기되 합계에 넣지 않아야 한다(SHALL). 「선택 제품 추가」(`add_optional{option_id, qty}`)는 새 줄을 만들고 `added` 를 표시한다. 화면의 선택 목록에는 아직 더하지 않은 것만 나오고, 명령으로 같은 선택 제품을 다시 보내면 줄이 하나 더 생긴다. 확정 주문의 선택 제품은 더하거나 바꿀 수 없어야 한다(MUST).

#### Scenario: 선택 제품은 값이 매겨지고 추가하면 새 줄이 된다

- **WHEN** 10% 할인 가격표의 제습기 1개 견적에 선택 제품 가습기(정가 50원) 3개와 단가 60 을 입력한 전기히터 1개를 넣는다
- **THEN** 가습기는 단가 50, 할인 10, `added: false`, 전기히터는 단가 60 이고 견적의 공급가액은 900 이다
- **AND** 박영업이 「선택 제품 추가」로 가습기를 더하면 수량 3, 단가 50, 할인 10, 공급가액 135, `price_manual` `false` 인 줄이 생기고 `added` 는 `true`, 공급가액은 1,035 가 된다
- **AND** 전기히터를 수량 2 로 더하면 단가 60, `price_manual` `true` 인 줄이 된다
- **AND** 명령으로 가습기를 또 보내면 줄이 하나 더 생기고, 없는 선택 제품은 `ERP_NOT_FOUND` 로 거부된다
- **AND** 확정한 뒤 「선택 제품 추가」를 요청하거나 `optional_lines` 를 바꿔 저장하면 `ERP_STATE` 로 거부된다
- **AND** 제품 없는 선택 제품으로 견적을 만들면 `ERP_REQUIRED` 로 거부된다

### Requirement: 미리보기는 저장할 값을 보여 주고 아무것도 저장하지 않는다

시스템은 공개 함수 `erp_preview('sales_order', ...)` 로 저장하면 나올 값을 돌려주고 원장에는 아무것도 남기지 않아야 한다(MUST). `id` 를 주면 그 문서 위에서 계산한다. 결과에는 `is_expired` 와 `suggested_options`(줄 제품이 권하는 제품 중 아직 없는 것)가 더 있다. 앱은 입력할 때마다 이 값으로 줄과 합계를 채우지만 `is_expired`, `suggested_options` 는 표시하지 않는다.

#### Scenario: 미리보기는 저장 없이 합계와 고객의 조건을 돌려준다

- **WHEN** 결제 조건 「30일」인 고객과 제습기 10개, 할인 10% 를 미리보기로 묻는다
- **THEN** 공급가액 9,000, 세액 900, 합계 9,900, 마진 3,000, 단가 1,000, 결제 조건 「30일」이 돌아오고 원장의 이벤트 수는 그대로다
- **AND** 저장된 제습기 1개 견적의 `id` 와 수량 3 을 주면 합계 3,300 이 돌아오고 저장된 합계는 1,100 그대로다
- **AND** 아직 아무도 주문하지 않은 `dynamic` 조합을 물어도 원장의 이벤트 수는 그대로다
- **AND** 수량만 있는 줄과 내용 없는 구역 줄을 넣어도 오류 없이 두 줄이 돌아온다
- **AND** 줄의 제품이 가습기를 권하면(`optional_product_ids`) `suggested_options` 에 가습기가 있다

### Requirement: 복제는 과거 없는 새 견적을 만든다

시스템은 `create` 명령의 `copy_of` 를 받으면 줄(수량·단가·할인·세금)과 선택 제품, 약관을 가진 새 견적을 만들어야 한다(SHALL). 번호와 날짜는 새로 정하고 선금 줄, 납품·청구 수량, 서명, `client_ref` 는 옮기지 않아야 한다(MUST). 앱 화면에는 복제 버튼이 없어 명령으로만 할 수 있다.

#### Scenario: 복제하면 새 번호의 견적이 되고 지난 일은 따라오지 않는다

- **WHEN** 제습기 2개 할인 5, 메모 줄, 약관, 고객 참조번호 `PO-9`, 선택 제품 하나인 주문이 확정되어 2개 출고되고 선금 청구서가 게시된 뒤 `copy_of` 로 복제한다
- **THEN** 새 ID 와 새 번호의 `draft` 견적이고 `invoice_status` 와 `delivery_status` 는 `no`, 합계는 2,090 이다
- **AND** 줄은 제습기 2개 할인 5 와 메모 줄뿐이고 납품·청구 수량은 0 이며 `pickings` 는 비어 있다
- **AND** 약관과 선택 제품은 옮겨 오고 고객 참조번호는 없으며 유효기간은 미래다
- **AND** `copy_of` 가 잘못된 값이면 `ERP_INVALID_REF` 로 거부된다

### Requirement: 확정하면 고칠 수 있는 것이 줄어든다

시스템은 확정할 때 `date_order` 를 지금으로 바꾸고 이 날짜를 뒤의 가격 계산 기준으로 삼아야 한다(SHALL). 확정 주문은 고객·가격표·창고·양식·주문일을 바꿀 수 없고, 줄의 제품과 단위를 바꾸거나 제품 줄을 지울 수 없으며(수량 0 으로만), 재화 줄을 납품 수량 아래로 줄일 수 없어야 한다(MUST). 거부는 모두 `ERP_INVALID` 다. 줄 추가, 단가·할인 변경, 구역·메모 줄의 추가와 삭제, 메모·고객 참조번호·납품 희망일 변경은 된다.

#### Scenario: 확정하면 주문일이 지금으로 바뀌고 뒤의 가격 계산 기준이 된다

- **WHEN** 2026-01-31 에 끝나는 50% 할인 규칙의 가격표로 주문일 2026-01-15 인 견적을 만들어 확정하고 「가격 다시 계산」을 누른다
- **THEN** 견적일 때 줄 할인은 50 이고, 확정하면 `date_order` 가 지금으로 바뀌며, 다시 계산한 줄 할인은 0 이다

#### Scenario: 확정 줄은 제품을 바꾸거나 지울 수 없고 추가와 가격 변경은 된다

- **WHEN** 제습기 5개 주문을 확정한 뒤 박영업이 줄의 제품을 바꾸거나 줄을 지운다
- **THEN** `ERP_INVALID` 로 거부된다
- **AND** 가습기 4개, 단가 77, 할인 5 인 줄을 더하면 `SalesOrderLineAdded` 가 남고 그 줄은 `qty_to_invoice` 4, `to_invoice` 다
- **AND** 제습기 줄을 단가 77, 할인 5 로 고치면 공급가액 366 이고 수량 변경이 아니므로 `SalesOrderLineChanged` 가 남는다
- **AND** 제습기 줄의 수량을 0 으로 고치면 `qty_to_invoice` 0, 줄 상태 `invoiced` 이고 `SalesOrderLineQtyChanged` 의 `to` 는 0 이다
- **AND** 구역 줄을 더했다가 지우면 `SalesOrderSectionAdded` 와 `SalesOrderSectionRemoved` 가 차례로 남는다
- **AND** 메모, 고객 참조번호, 납품 희망일을 고치면 `SalesOrderUpdated` 가 남고, 고객이나 가격표를 바꾸면 `ERP_INVALID` 로 거부된다

#### Scenario: 재화 줄은 납품 수량 아래로 줄일 수 없고 서비스 줄은 줄일 수 있다

- **WHEN** 단가 100·세금 없는 납품 기준 재화 10개 주문을 확정하고 전표가 열린 뒤 수량을 15, 8 로 바꾼다
- **THEN** 합계는 1,500, 800 이 되고 `SalesOrderLineQtyChanged` 의 `from`, `to` 는 처음에 10, 15 다
- **AND** 3개가 출고되어 「일부 납품」, `to_invoice` 가 된 뒤 수량 12 는 합계 1,200 으로 되고, 수량 2 는 `ERP_INVALID` 로 거부되어 12 가 유지되며, 수량 3 은 된다
- **AND** 납품 수량 5 를 입력한 서비스 10개 줄은 수량을 3 으로 줄일 수 있다

### Requirement: 잠긴 주문은 약속한 값을 지킨다

시스템은 확정 주문만 잠그거나 풀 수 있게 하고(「잠그기」, 「잠금 풀기」, 그 밖의 상태는 `ERP_STATE`), 회사 설정 「확정 주문 자동 잠금」(`lock_confirmed_sales`)이 켜져 있으면 확정할 때 잠가야 한다(SHALL). 잠긴 주문의 수량·단가·설명·세금 변경과 취소는 `ERP_LOCKED` 로 거부해야 한다(MUST). 할인, 메모, 새 줄은 받는다.

#### Scenario: 잠긴 주문은 수량과 단가와 설명과 세금 변경과 취소를 거부한다

- **WHEN** 제습기 5개 확정 주문을 박영업이 「잠그기」로 잠그고 수량, 단가, 설명, 세금을 하나씩 고치거나 「취소」를 누른다
- **THEN** 모두 `ERP_LOCKED` 로 거부되고 주문은 `locked` `true`, 상태 `sale` 이다
- **AND** 단가를 700 으로 입력해 둔 줄이 있어 「가격 다시 계산」이 단가를 바꾸게 되면 `ERP_LOCKED` 로 거부된다

#### Scenario: 잠긴 주문도 메모와 할인과 새 줄은 받고 풀면 다시 고칠 수 있다

- **WHEN** 잠긴 주문에 메모를 고치고 할인 5 를 넣고 새 줄을 더한다
- **THEN** 모두 저장되고, 바뀔 단가가 없는 「가격 다시 계산」도 거부되지 않는다
- **AND** 「잠금 풀기」를 누르면 `locked` 는 `false` 가 되고 수량을 9 로 고칠 수 있다
- **AND** 견적을 잠그려 하면 `ERP_STATE` 로 거부되고, 잠긴 주문을 다시 잠가도 마지막 이벤트는 `SalesOrderLocked` 그대로다
- **AND** 김대표가 회사의 「확정 주문 자동 잠금」을 켜면 새로 확정한 주문은 `locked` 가 `true` 다

### Requirement: 상태는 정해진 길로만 움직인다

시스템은 `draft`(「견적」), `sent`(「보낸 견적」), `sale`(「주문」), `cancelled`(「취소」) 사이를 다음 길로만 옮겨야 한다(SHALL). `send`(「견적 보내기」)와 `confirm`(「주문 확정」)은 `draft`, `sent` 에서, `set_draft`(「견적으로 되돌리기」)는 `sent`, `cancelled` 에서, `cancel`(「취소」)은 `cancelled` 가 아닌 곳에서, `delete`(「삭제」)는 `draft`, `cancelled` 에서만 된다. 그 밖에는 `ERP_STATE` 로 거부해야 한다(MUST). 포털 토큰은 처음 보낼 때 정해지고, 보낸 방법을 주지 않으면 `via` 는 `link` 다. 되돌리면 서명이 지워진다. 취소된 주문은 고칠 수 없다.

#### Scenario: 견적을 보내면 토큰이 정해지고 다시 보내도 같다

- **WHEN** 박영업이 `send` 명령을 `via: email` 로 보낸다
- **THEN** 상태는 `sent` 이고 32자 이상의 `portal_token` 이 생기며 `QuotationSent` 에 `via` `email` 과 그 토큰이 실린다
- **AND** 다시 보내도 토큰은 그대로이고 메모를 고쳐도 `sent` 그대로다
- **AND** 보낸 견적을 지우려 하면 `ERP_STATE` 로 거부되고 「견적으로 되돌리기」를 누르면 `draft` 가 된다

#### Scenario: 확정 주문과 취소된 주문은 정해진 길만 간다

- **WHEN** 제습기 5개 확정 주문에 다시 확정, 보내기, 되돌리기, 삭제를 요청한다
- **THEN** 모두 `ERP_STATE` 로 거부된다
- **AND** 「취소」를 누르면 `cancelled`, `invoice_status` `no`, 합계 5,500 그대로, 줄의 `qty_to_invoice` 0 이 된다
- **AND** 취소된 주문의 다시 취소, 확정, 보내기, 수정은 `ERP_STATE` 로 거부된다
- **AND** 「견적으로 되돌리기」 뒤 다시 확정하면 `invoice_status` 는 `to_invoice` 이고 `SalesOrderConfirmed` 가 두 번째로 남는다

#### Scenario: 견적과 취소된 주문은 지울 수 있고 취소해도 납품한 수량은 남는다

- **WHEN** 박영업이 견적을 「삭제」한다
- **THEN** 문서는 지워진 것으로 표시되고 그 뒤 수정은 `ERP_NOT_FOUND` 로 거부된다
- **AND** 취소한 주문도 지울 수 있다
- **AND** 2개 출고된 주문을 취소하면 `cancelled`, `invoice_status` `no` 이고 `qty_delivered` 2 는 남는다
- **AND** 그 주문을 지운 뒤 전표 이벤트가 와도 무시되고 구독 실패는 0 이다

### Requirement: 납품 상태는 전표 이벤트로만 움직인다

시스템은 `delivery_status` 를 수량이 아니라 재고 모듈이 알린 전표 상태로 정해야 한다(MUST). 취소를 뺀 전표가 없으면 `no`, 전부 완료면 `full`, 출고 전표가 완료되었으면 `partial`(열린 반품 포함), 앞 단계만 완료면 `started`, 나머지는 `pending` 이다. 판매는 재고 모듈을 부르지 않고 이벤트만 듣는다. 재고 부족은 확정을 막지 않는다. 납품 수량은 출고에 더하고 환불 반품에 빼며, 환불하지 않는 반품과 내부 이동은 건드리지 않는다. 전표 쪽 동작은 재고 스펙의 몫이다.

#### Scenario: 주문을 확정하면 재고 모듈이 전표를 만들고 출고하면 납품 상태가 바뀐다

- **WHEN** 재고 모듈이 켜진 회사에서 박영업이 에어서큘레이터 5개 주문을 확정한다
- **THEN** 명령 직후 판매는 자기 이벤트만 남기고, 구독이 돈 뒤 출고 전표가 생겨 주문 화면에 납품 상태 「납품 전」과 `WH/OUT/` 전표 링크가 보인다
- **AND** 이재고가 그 전표를 완료하면 주문의 납품 상태는 「납품 완료」(`full`), 납품 수량은 5 다

#### Scenario: 재고가 모자라도 주문 확정은 막히지 않는다

- **WHEN** 재고보다 훨씬 많은 10,000개 주문을 박영업이 확정한다
- **THEN** 주문은 `sale` 이고 출고 전표는 완료되지 않은 채 기다린다
- **AND** 주문을 취소하면 구독이 돈 뒤 그 전표는 `cancelled` 다

#### Scenario: 전표 상태가 납품 상태를 정한다

- **WHEN** 10개 주문의 전표가 `ready` 라고 알려 온다
- **THEN** `delivery_status` 는 `pending` 이다
- **AND** 그 전표를 4개만 출고하고 남은 수량을 새 전표로 남기면 `partial`, 남은 수량 6 도 출고하면 `full` 이다
- **AND** 남은 수량 없이 3개만 출고하고 끝나면 `qty_delivered` 3 에 `full` 이다
- **AND** 전표가 `cancelled` 로 바뀌어 남은 전표가 없으면 `no` 로 돌아온다
- **AND** 내부 이동 단계만 완료되고 다음 전표가 `waiting` 이면 `started` 이고, 그 내부 이동은 `qty_delivered` 를 늘리지 않는다

#### Scenario: 초과 납품과 반품이 납품 수량을 바꾼다

- **WHEN** 10개 주문에 12개가 출고된다
- **THEN** `qty_delivered` 12, `full`, `to_invoice` 다
- **AND** 반품 전표가 열리면 `partial` 이고, 환불 대상 2개 반품이 끝나면 `qty_delivered` 10, `full` 이다
- **AND** 환불하지 않는 반품(`to_refund: false`)은 수량을 건드리지 않고, 반품의 반품은 수량을 11 로 늘린다
- **AND** 나간 것보다 많은 50개 환불 반품도 거부되지 않아 `qty_delivered` 는 -39 가 된다

### Requirement: 전표가 추적하기 전까지 사람이 납품 수량을 적는다

시스템은 전표나 이동이 언급한 적 없는 줄의 `qty_delivered` 를 사람이 입력할 수 있게 하고 `SalesOrderDelivered` 를 남겨야 한다(SHALL). 전표가 한 번이라도 언급한 줄(`delivery_tracked`)을 직접 고치면 `ERP_INVALID` 로 거부해야 한다(MUST). 전표가 오면 입력한 값에 더해진다.

#### Scenario: 사람이 입력한 납품 수량에 전표가 더해진다

- **WHEN** 납품 기준 서비스 10개와 재화 5개 확정 주문에서 박영업이 납품 수량을 3, 2 로 입력한다
- **THEN** 서비스 줄은 `qty_to_invoice` 3 이고 주문은 `to_invoice` 이며 재화 줄은 납품 수량 2 다
- **AND** 전표가 그 재화 줄을 언급한 뒤 입력하면 `ERP_INVALID` 로 거부되고, 2개 출고 이벤트가 오면 납품 수량은 4 가 된다
- **AND** 전표가 언급하지 않은 서비스 줄은 계속 입력할 수 있다
- **AND** 판매만 켜진 회사의 제습기 10개 주문에 납품 수량 4 를 입력하면 `qty_delivered` 는 4 이고 `SalesOrderDelivered` 가 남는다

### Requirement: 청구 수량과 상태는 청구서 이벤트로만 움직인다

시스템은 줄의 `qty_invoiced` 를 청구 모듈의 이벤트로만 다시 계산해야 한다(MUST). 취소가 아닌 청구서의 줄을 초안부터 더하고 대변 메모는 빼며, 금액 `amount_invoiced` 는 게시된 것만 센다. 청구 대상은 `invoice_policy` 가 `order` 면 `qty - qty_invoiced`, `delivery` 면 `qty_delivered - qty_invoiced`, 확정 주문이 아니면 0 이다. 줄 상태는 대상이 0 이 아니면 `to_invoice`, `order` 기준 초과 납품이면 `upselling`, 주문량까지 청구됐으면 `invoiced`, 나머지 `no` 다. 주문 상태는 `to_invoice` 줄이 있으면 `to_invoice`, 전부 `invoiced` 면 `invoiced`, `upselling` 이 있고 나머지가 `invoiced` 면 `upselling`, 나머지 `no` 이고 구역·선금·콤보 줄은 세지 않는다. 판매 주문이 아닌 문서와 없는 주문의 이벤트는 무시한다. 청구서 쪽 동작은 청구 스펙의 몫이다.

#### Scenario: 청구 수량은 초안부터 세고 금액은 게시부터 센다

- **WHEN** 납품 기준 제습기 10개, 할인 10%(합계 9,900) 확정 주문에 4개가 출고되고 남은 전표가 열린다
- **THEN** `invoice_status` `to_invoice`, `delivery_status` `partial`, `qty_delivered` 4, `qty_to_invoice` 4 다
- **AND** 4개 청구서 초안 이벤트가 오면 `invoice_status` `no`, `qty_invoiced` 4, `qty_to_invoice` 0 이고 `amount_invoiced` 는 0 이다
- **AND** 합계 3,960 으로 게시되면 `amount_invoiced` 3,960, `amount_to_invoice` 5,940 이다
- **AND** 나머지 6개가 출고되어 청구서 초안이 오면 `invoice_status` `invoiced`, `qty_invoiced` 10, `qty_to_invoice` 0 이다

#### Scenario: 주문 수량 기준이면 초과 납품이 추가 판매 기회가 된다

- **WHEN** `invoice_policy` `order` 인 제품 10개 견적을 확정한다
- **THEN** 견적일 때 `qty_to_invoice` 는 0 이고 확정 뒤에는 10 이며 `invoice_status` 는 `to_invoice` 이고, 4개가 출고되어도 10 그대로다
- **AND** 10개 청구서 초안이 오면 `invoiced`, 게시해도 `invoiced` 다
- **AND** 8개가 더 출고되어 납품 수량이 12 가 되면 `invoice_status` 와 줄 상태는 `upselling`(「추가 판매 기회」)이다

#### Scenario: 납품 수량 기준이면 나간 만큼만 청구 대기가 된다

- **WHEN** `invoice_policy` `delivery` 인 제품 10개 견적을 확정한다
- **THEN** `invoice_status` 는 `no`, `qty_to_invoice` 는 0 이고, 4개가 출고되면 `to_invoice`, 4 가 된다
- **AND** 4개 청구서 초안이 오면 `no`, `qty_invoiced` 4, `qty_to_invoice` 0 이고, 그 초안이 취소되면 `to_invoice`, 0, 4 로 돌아간다
- **AND** 5개 주문에 7개가 출고되면 `to_invoice`, 7 이고 7개 초안이 오면 `invoiced` 로, `upselling` 이 되지 않는다

#### Scenario: 서비스도 청구 기준을 따르고 일부만 청구된 주문은 no 다

- **WHEN** `order` 기준 서비스 10개 주문과 `delivery` 기준 서비스 10개 주문을 확정한다
- **THEN** 앞의 주문은 `to_invoice`, `qty_to_invoice` 10, `delivery_status` `no` 이고 뒤의 주문은 `no` 다
- **AND** `order` 재화 2개, `delivery` 재화 3개, `order` 서비스 1개 주문에서 `order` 줄들이 청구서 초안에 오르면 줄 상태는 `invoiced`, `no`, `invoiced` 이고 주문 상태는 `no` 다

#### Scenario: 대변 메모는 초안부터 청구 수량을 되돌리고 다른 문서의 이벤트는 무시한다

- **WHEN** 2개, 3개 주문이 3개, 3개 출고되어 2개, 3개가 게시 청구되어 `upselling` 인 주문에 둘째 줄 3개 대변 메모 초안이 온다
- **THEN** 둘째 줄은 `qty_invoiced` 0, `qty_to_invoice` 3 이고 주문은 `to_invoice` 다
- **AND** 대변 메모를 2개로 고쳐 게시하면 `qty_invoiced` 1, `qty_to_invoice` 2 다
- **AND** 원래 청구서를 초안으로 되돌려도 첫 줄의 `qty_invoiced` 는 2 다
- **AND** 공급사 청구서(`in_invoice`), `origin_type` 이 `purchase_order` 인 청구서, 없는 주문을 가리키는 청구서 이벤트가 와도 주문의 버전은 그대로이고 구독 실패는 0 이다

### Requirement: 선금 청구서는 주문에 합계를 바꾸지 않는 줄로 남는다

시스템은 선금 청구서 줄(`is_downpayment`, `origin_line_id: null`, 양수 수량)을 받으면 주문에 「선금」 구역 하나와 선금 줄을 더해야 한다(SHALL). 선금 줄의 `id` 는 청구서 줄의 `line_id` 와 같고 `invoice_line_id` 에도 적으며, 수량 0 이라 합계를 바꾸지 않고 주문 상태 계산에서도 빠진다. 선금 줄은 손으로 지울 수 없어야 한다(MUST).

#### Scenario: 선금 청구서 초안이 오면 구역과 선금 줄이 생기고 합계는 그대로다

- **WHEN** 제습기 10개 확정 주문에 단가 3,000 선금 청구서 초안 이벤트가 온다
- **THEN** 공급가액 10,000, 세액 1,000, 합계 11,000 과 `invoice_status` `to_invoice` 는 그대로다
- **AND** 구역 줄과 선금 줄이 생기고 선금 줄은 수량 0, 단가 3,000, 공급가액 0, `qty_invoiced` 1, `qty_to_invoice` -1, 줄 상태 `invoiced`, 10% 세금, 설명에 「초안」이다
- **AND** 선금 줄의 `id` 와 `invoice_line_id` 는 청구서 줄의 `line_id` 다
- **AND** 같은 이벤트가 다시 와도 버전이 그대로이고 선금 줄은 하나다

#### Scenario: 게시된 선금은 최종 청구서에서 차감된다

- **WHEN** 그 선금 청구서가 게시된다
- **THEN** 선금 줄은 줄 상태 `to_invoice` 이고 설명에 청구서 번호가 있으며 `amount_invoiced` 는 그 청구서 합계다
- **AND** 단가 1,000 선금이 더 게시되면 선금 줄은 둘이고 구역은 하나다
- **AND** 제습기 10개와 수량 -1 차감 줄 둘인 최종 청구서 초안이 오면 제습기 줄은 `qty_invoiced` 10, 주문은 `invoiced` 이고 선금 줄은 단가 3,000, 1,000 에 `qty_invoiced` 0, `qty_to_invoice` 0, `invoiced` 이며 줄 수는 그대로다
- **AND** 그 최종 청구서가 게시되어도 선금 줄의 단가와 `qty_invoiced` 는 그대로다
- **AND** 아직 출고하지 않은 납품 기준 주문은 선금이 게시되어도 `invoice_status` 가 `no` 다

#### Scenario: 선금 청구서를 취소하거나 대변 메모로 되돌리면 선금 줄이 따라간다

- **WHEN** 단가 3,000 선금 청구서 초안이 취소된다
- **THEN** 선금 줄은 단가 0, `qty_invoiced` 0, `qty_to_invoice` 0, `invoiced` 이고 설명에 「취소」가 있다
- **AND** 새 선금 청구서가 게시되면 새 줄이 생기고, 초안으로 되돌리면 그 줄은 단가 3,000, 1, -1, `invoiced` 다
- **AND** 다시 게시한 그 선금에 대변 메모 초안이 오면 단가 3,000, 0, 0 이고, 1,000 만큼 게시되면 단가 2,000, 1, -1, `to_invoice`, 3,000 전액으로 게시되면 단가 0, 0, 0, `invoiced` 다
- **AND** 대변 메모는 새 선금이 되지 않아 선금 줄 수는 그대로다
- **AND** `reversal_of` 로 되돌릴 청구서만 말하는 대변 메모도 그 선금 줄을 찾아 단가 0, `qty_invoiced` 0 으로 만든다

#### Scenario: 선금 줄은 손으로 지울 수 없다

- **WHEN** 박영업이 선금 줄을 뺀 줄 목록을 저장한다
- **THEN** `ERP_INVALID` 로 거부된다
- **AND** 줄을 그대로 다시 저장하면 버전과 선금 단가 100 은 그대로다

### Requirement: 고객 포털은 토큰으로 그 견적 하나만 열고 내부 값을 돌려주지 않는다

앱에는 고객 포털 화면이 없고, 로그인 없이 부를 수 있는 공개 입구 `erp_portal_get(token)`, `erp_portal_sign(token, name, signature)`, `erp_portal_decline(token, reason)`, `erp_portal_add_option(token, option_id, qty)` 로만 쓴다. 시스템은 토큰으로 그 견적 하나만 열고, `company, number, state, partner_name, date_order, validity_date, commitment_date, is_expired, client_ref, note, amount_untaxed, amount_tax, amount_total, require_signature, require_payment, prepayment_percent, signed_by, signed_at, can_sign, can_decline, can_add_options, lines, optional_lines` 만 돌려주어야 한다(MUST). 원가·마진·담당자·토큰 같은 내부 값은 돌려주지 않는다. 서명 이미지는 200,000자까지다. 이벤트의 `source` 는 `portal` 이고 `actor_name` 은 서명이면 서명한 이름, 그 밖에는 `고객` 이다.

#### Scenario: 토큰으로 견적 하나를 보고 내부 값은 보이지 않는다

- **WHEN** 가온마트 담당자 오민지가 받은 토큰으로 고객 포털 입구 `erp_portal_get` 을 로그인 없이 부른다
- **THEN** 번호, `state` `sent`, 합계 2,200, 약관, `can_sign` 과 `can_decline` `true`, `is_expired` `false`, 회사 이름, 줄의 단위 이름 「개」, 선택 제품이 돌아온다
- **AND** 응답 어디에도 `cost`, `margin`, `salesperson`, `portal_token`, `pricelist`, `pickings`, `invoices` 가 없다
- **AND** 짧은 토큰, 없는 토큰, `null` 은 `ERP_NOT_FOUND` 로 거부된다
- **AND** 로그인 없이 `erp_command` 나 `erp_sales_expired` 를 부르면 권한 없음(`permission denied`)으로 거부된다
- **AND** 판매 모듈이 꺼진 회사에서는 토큰이 맞아도 `ERP_MODULE_OFF` 로 거부된다

#### Scenario: 서명만 요구하는 견적은 서명하면 확정된다

- **WHEN** 오민지가 이름과 서명 이미지를 넣어 `erp_portal_sign` 을 부른다
- **THEN** 돌아온 값은 `state` `sale`, `signed_by` 오민지, `can_sign` `false` 이고 주문에 서명 이미지가 저장된다
- **AND** `QuotationSigned` 와 `SalesOrderConfirmed` 가 같은 `correlation_id`, `source` `portal`, `actor_name` 오민지로 남는다
- **AND** 빈 이름은 `ERP_REQUIRED`, 200,001자 서명은 `ERP_INVALID`, 다시 서명하면 `ERP_STATE` 로 거부된다
- **AND** 확정 뒤에도 그 토큰으로 `state` `sale` 을 볼 수 있다

#### Scenario: 결제를 요구하는 견적은 담당자를 기다리고 만료되었거나 서명이 필요 없는 견적은 거부된다

- **WHEN** `require_payment` 가 `true` 인 견적에 오민지가 서명한다
- **THEN** `state` 는 `sent` 그대로이고 `signed_by` 는 오민지다
- **AND** 다시 서명하면 `ERP_STATE` 로 거부되고, 박영업이 「견적으로 되돌리기」를 누르면 `signed_by` 는 `null` 이다
- **AND** 유효기간이 2020-01-01 인 보낸 견적은 `is_expired` `true`, `can_sign` `false` 이고 서명하면 `ERP_EXPIRED` 로 거부된다
- **AND** `require_signature` 가 `false` 인 견적에 서명하면 `ERP_INVALID` 로 거부된다

#### Scenario: 포털에서 선택 제품을 담으면 표시된 줄이 생기고 거절하면 사유와 함께 취소된다

- **WHEN** 오민지가 제습기 1개와 선택 제품 가습기(정가 50원) 2개인 견적에서 `erp_portal_add_option` 으로 가습기를 담는다
- **THEN** 줄은 둘이 되고 새 줄은 `from_portal` `true`, 선택 제품은 `added` `true`, 합계는 1,210 이다
- **AND** `QuotationOptionTaken` 이 `source` `portal`, `from_portal` `true` 로 남는다
- **AND** 없는 선택 제품은 `ERP_NOT_FOUND`, 수량 0 은 `ERP_INVALID` 로 거부된다
- **AND** `erp_portal_decline` 에 사유 「가격이 안 맞습니다」를 주면 `state` `cancelled`, `declined_reason` 그 사유, `QuotationDeclined` 가 남는다
- **AND** 거절한 뒤 다시 거절하거나 선택 제품을 담으면 `ERP_STATE` 로 거부된다

#### Scenario: 만료된 견적은 포털에서 선택 제품을 담을 수 없고 거절은 된다

- **WHEN** 유효기간이 지난 보낸 견적을 포털에서 본다
- **THEN** `can_add_options` 는 `false`, `can_decline` 은 `true` 이고 선택 제품을 담으면 `ERP_EXPIRED` 로 거부된다
- **AND** 거절하면 `cancelled` 가 되고 `QuotationDeclined` 의 `actor_name` 은 `고객` 이다

### Requirement: 다른 모듈에 알리는 이벤트는 필요한 사실을 전부 싣는다

시스템은 재고·청구 모듈이 판매를 읽지 않아도 되도록 이벤트의 `data` 최상위에 사실을 실어야 한다(MUST). `SalesOrderConfirmed` 는 `number, partner_id, partner_name, delivery_partner_id, region, warehouse_id, shipping_policy, commitment_date, date_order, currency, amount_untaxed, amount_tax, amount_total, lines` 를, 그 `lines` 는 구역·메모·선금 줄을 빼고 `line_id, product_id, variant_id, name, qty, uom_id, lead_days, unit_price, discount, subtotal, cost, type, invoice_policy, linked_line_id, combo_item_id` 를 싣는다. `SalesOrderLineAdded` 는 같은 모양의 `line` 과 `warehouse_id, partner_id, number` 를, `SalesOrderLineQtyChanged` 는 `line_id, variant_id, product_id, from, to, uom_id, name, type, warehouse_id, partner_id, number` 를, `SalesOrderCancelled` 는 `number, partner_id, was, reason` 을 싣는다. `region` 은 납품처의 지역, 없으면 거래처의 지역이고 `warehouse_id` 는 재고 모듈이 꺼져 있으면 `null` 이다.

#### Scenario: 확정과 그 뒤의 변경과 취소가 납품처와 줄의 사실을 싣는다

- **WHEN** 지역이 영남인 거래처의 지역 호남 배송지로, 납품 희망일과 배송 정책 `one` 을 정해 납기 3일·납품 기준 제습기 2개 할인 10, 구역 줄, 서비스 1개 주문을 확정한다
- **THEN** `SalesOrderConfirmed` 에 `delivery_partner_id` 는 그 배송지, `region` `호남`, `shipping_policy` `one`, `currency` `KRW`, `amount_total` 3,080 이 실린다
- **AND** `lines` 는 구역 줄을 뺀 두 줄이고, 첫 줄은 수량 2, `unit_price` 1,000, `discount` 10, `subtotal` 1,800, `cost` 600, `type` `goods`, `lead_days` 3, `invoice_policy` `delivery` 이며 둘째 줄의 `type` 은 `service` 다
- **AND** 제습기 수량을 5 로 고치면 `SalesOrderLineQtyChanged` 에 `from` 2, `to` 5, `type` `goods` 가 실린다
- **AND** 서비스 4개 줄을 더하면 `SalesOrderLineAdded` 의 `line` 은 수량 4, `type` `service` 다
- **AND** 사유 「고객 변심」으로 취소하면 `SalesOrderCancelled` 에 번호, `partner_id`, `reason` 이 실린다

### Requirement: 같은 이벤트가 다시 와도 결과는 같다

시스템은 다른 모듈의 이벤트를 두 번 받아도 주문이 달라지지 않게 해야 한다(MUST). 청구 수량은 들을 때마다 청구서 기록 전체에서 다시 계산하고, 납품 수량은 처리한 이벤트 번호를 기억해 중복을 막는다. 전표 작업을 되돌리면 그 작업이 늘린 납품 수량도 함께 돌아가야 한다.

#### Scenario: 같은 이벤트가 두 번 와도 아무것도 바뀌지 않는다

- **WHEN** 4개 출고 전표 이벤트와 청구서 게시 이벤트가 이미 반영된 주문에 같은 이벤트들이 다시 전달된다
- **THEN** 주문의 버전과 내용은 그대로다

#### Scenario: 전표 작업을 되돌리면 납품 수량도 돌아간다

- **WHEN** 납품 기준 주문에 4개 출고를 알린 작업을 김대표가 되돌리기로 취소한다
- **THEN** `qty_delivered` 와 `qty_to_invoice` 는 0 으로 돌아간다

### Requirement: 판매 역할만 쓰고 구성원은 모두 읽는다

시스템은 견적·주문과 견적 양식의 쓰기를 `sales` 역할과 `admin` 에게 허락하고 다른 역할은 `ERP_FORBIDDEN` 으로 거부해야 한다(MUST). 모든 구성원은 읽을 수 있다. 없는 명령은 `ERP_COMMAND`, 없는 항목은 `ERP_UNKNOWN_FIELD` 로 거부한다.

#### Scenario: 구매 담당자는 주문을 읽을 수만 있다

- **WHEN** 최구매(`purchase`)가 견적을 만들거나 박영업의 견적을 확정하려 한다
- **THEN** `ERP_FORBIDDEN` 으로 거부되지만 그 견적을 읽을 수는 있다
- **AND** 박영업이 없는 명령을 보내면 `ERP_COMMAND`, 없는 항목을 넣으면 `ERP_UNKNOWN_FIELD` 로 거부된다
- **AND** 박영업은 그 견적을 확정할 수 있다
