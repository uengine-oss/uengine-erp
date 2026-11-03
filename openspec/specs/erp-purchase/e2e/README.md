# E2E — erp-purchase

구매 문서의 생애(견적 요청, 승인, 확정, 잠금, 취소, 삭제), 단가와 납기 결정, 입고·청구 수량과 상태, 재주문 요청에서 초안 만들기, 읽기 권한과 조회를 실제 설치 SQL 위에서 확인하고, 화면으로는 구매를 켜서 재주문부터 입고까지 가는 흐름과 입고 수량 입력 창을 확인한다. `purchase.test.mjs` 의 앞부분은 재고와 청구를 끄고 그 소식을 모듈 사이 이벤트 계약의 모양으로 직접 넣어 시험하고, `S4` 뒤의 시험과 `with stock on` 시험은 실제 재고 모듈을 함께 돌린다. 청구서는 이 스펙의 시험에서 항상 이벤트로만 들어온다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/purchase.test.mjs test/growth.test.mjs test/isolation.test.mjs
source scripts/local-env.sh && npm run test:e2e -- growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 견적 요청 초안을 만든다 | `purchase.test.mjs › an RFQ computes its amounts and stays out of receiving and billing until confirmed` | SQL | ✅ |
| 보냄 표시를 하고 주문을 확정한다 | `purchase.test.mjs › an RFQ computes its amounts and stays out of receiving and billing until confirmed` | SQL | ✅ |
| 초안의 줄을 고치면 바뀐 것만 남는다 | `purchase.test.mjs › a document may be edited line by line, a change that changes nothing writes nothing, unknown fields are refused` | SQL | ✅ |
| 잘못된 입력은 저장되지 않는다 | `purchase.test.mjs › a document may be edited line by line, a change that changes nothing writes nothing, unknown fields are refused` | SQL | ◐ |
| 구역 줄은 금액과 이벤트에 들어가지 않고 줄 없는 문서도 확정된다 | `purchase.test.mjs › a document may be edited line by line, a change that changes nothing writes nothing, unknown fields are refused` | SQL | ✅ |
| 맞는 줄 중 최소 수량이 가장 큰 줄을 고른다 | `purchase.test.mjs › G14: largest fitting minimum, then lowest price, whatever the row order; no fit means cost, and the delay still comes along` | SQL | ✅ |
| 맞는 줄이 없으면 제품 원가를 쓴다 | `purchase.test.mjs › G14: largest fitting minimum, then lowest price, whatever the row order; no fit means cost, and the delay still comes along` | SQL | ✅ |
| 입고 예정일은 주문 마감일에 납기를 더한 날이고 머리글은 가장 이른 줄을 따른다 | `purchase.test.mjs › G14: largest fitting minimum, then lowest price, whatever the row order; no fit means cost, and the delay still comes along`<br>`purchase.test.mjs › confirmed: no removing a line or swapping its product, price and new lines are fine, each change a fact of its own` | SQL | ✅ |
| 수량이 바뀌어 납기가 달라져도 정해진 입고 예정일은 그대로다 | ✗ | — | ✗ |
| 자동 단가는 수량을 따르고 직접 넣은 단가는 남는다 | `purchase.test.mjs › an automatic price follows the quantity; a typed one stays until someone changes it; discount and vendor code come along` | SQL | ✅ |
| 저장하지 않고 금액을 미리 본다 | `purchase.test.mjs › an automatic price follows the quantity; a typed one stays until someone changes it; discount and vendor code come along` | SQL | ✅ |
| 구매 단위가 기본이고 분류가 다른 단위는 거부된다 | `purchase.test.mjs › units: the purchase unit is the default, prices follow it, and another kind of unit is refused` | SQL | ✅ |
| 공급사 단가와 최소 수량은 구매 단위 기준이다 | ✗ | — | ✗ |
| 공급사 조건과 요청자가 문서에 채워진다 | `purchase.test.mjs › payment terms, tax position and buyer come from who is buying from whom; a tax position maps the taxes` | SQL | ✅ |
| 한도 이상이면 승인을 기다리고 입고 전표가 없다 | `purchase.test.mjs › G8: above the limit a buyer's confirmation waits for an administrator; no receipt until then` | SQL | ✅ |
| 승인 대기는 관리자만 풀 수 있다 | `purchase.test.mjs › G8: above the limit a buyer's confirmation waits for an administrator; no receipt until then` | SQL | ✅ |
| 한도는 세금 포함 합계로 보고 승인 대기 문서는 되돌릴 수 있다 | `purchase.test.mjs › G8: above the limit a buyer's confirmation waits for an administrator; no receipt until then` | SQL | ✅ |
| 확정된 주문의 줄 삭제와 제품·공급사 교체는 거부된다 | `purchase.test.mjs › confirmed: no removing a line or swapping its product, price and new lines are fine, each change a fact of its own` | SQL | ✅ |
| 확정된 주문의 수량·가격·새 줄은 각각 이벤트로 남는다 | `purchase.test.mjs › confirmed: no removing a line or swapping its product, price and new lines are fine, each change a fact of its own` | SQL | ✅ |
| 입고량 아래로 줄이면 거부된다 | `purchase.test.mjs › without stock the received quantity is typed in, and statuses follow it`<br>`purchase.test.mjs › with stock on: quantities and prices follow onto the receipt; below what arrived is refused; equal closes it` | SQL | ✅ |
| 수량과 가격이 열린 입고 전표로 따라간다 | `purchase.test.mjs › with stock on: quantities and prices follow onto the receipt; below what arrived is refused; equal closes it` | SQL | ✅ |
| 입고량과 같게 줄이면 남은 입고가 닫히고 다시 늘리면 새 전표가 생긴다 | `purchase.test.mjs › with stock on: quantities and prices follow onto the receipt; below what arrived is refused; equal closes it` | SQL | ✅ |
| 잠긴 주문은 숫자와 취소가 막히고 메모는 받는다 | `purchase.test.mjs › lock and unlock; a locked order keeps its numbers and cannot be cancelled, a note still goes on` | SQL | ◐ |
| 공급사 확인 일시를 기록한다 | `purchase.test.mjs › lock and unlock; a locked order keeps its numbers and cannot be cancelled, a note still goes on` | SQL | ✅ |
| 취소하지 않은 문서는 지울 수 없다 | `purchase.test.mjs › G5: cancelling and deleting: a document must be cancelled before it goes, and can come back as a draft` | SQL | ✅ |
| 취소한 문서는 초안으로 되돌리거나 지울 수 있다 | `purchase.test.mjs › G5: cancelling and deleting: a document must be cancelled before it goes, and can come back as a draft` | SQL | ✅ |
| 입고된 주문은 취소할 수 없다 | `purchase.test.mjs › without stock the received quantity is typed in, and statuses follow it`<br>`purchase.test.mjs › with stock on: quantities and prices follow onto the receipt; below what arrived is refused; equal closes it` | SQL | ✅ |
| 게시된 청구서는 취소를 막고 초안 청구서는 막지 않는다 | `purchase.test.mjs › D1: bills count from the draft; an order-policy line is due at once, a receipt-policy line when received`<br>`purchase.test.mjs › a draft bill does not stop cancelling; a posted one does` | SQL | ✅ |
| 입고 전에 취소하면 입고 전표도 취소되고 다시 확정하면 새 전표가 생긴다 | `purchase.test.mjs › with stock on: a return reduces the received quantity, and cancelling before receipt cancels the transfer` | SQL | ✅ |
| 재고 없이 입고 수량을 직접 입력한다 | `purchase.test.mjs › without stock the received quantity is typed in, and statuses follow it` | SQL | ✅ |
| 잘못된 입고 수량 입력은 거부된다 | `purchase.test.mjs › without stock the received quantity is typed in, and statuses follow it`<br>`purchase.test.mjs › receipt status comes from the transfers, the received quantity from what they moved` | SQL | ✅ |
| 서비스 줄은 직접 입력하고 입고 상태에 들어가지 않는다 | `purchase.test.mjs › services are received by hand even with transfers around; billing policy decides what is due` | SQL | ◐ |
| 입고 수량 입력 창은 줄마다 수량을 묻는다 | `growth.spec.mjs › S6. 시점을 고르면 재고와 미수금도 그날 기준으로 보이고, 구매 입고 입력은 수량을 줄별로 묻는다` | 브라우저 | ✅ |
| 입고 전표 상태를 따라 입고 상태가 바뀐다 | `purchase.test.mjs › receipt status comes from the transfers, the received quantity from what they moved` | SQL | ✅ |
| 취소된 전표는 입고 상태에서 빠진다 | `purchase.test.mjs › receipt status comes from the transfers, the received quantity from what they moved` | SQL | ✅ |
| 같은 소식을 다시 받아도 한 번만 세고 남의 소식은 무시한다 | `purchase.test.mjs › hearing the same thing twice counts once; old news does not overwrite newer`<br>`purchase.test.mjs › events about somebody else's documents are ignored` | SQL | ✅ |
| 환불 반품은 입고 수량을 줄이고 환불 없는 반품은 그대로 둔다 | `purchase.test.mjs › returns: a refunded one takes the received quantity down, a plain one leaves it, and units convert`<br>`purchase.test.mjs › with stock on: a return reduces the received quantity, and cancelling before receipt cancels the transfer` | SQL | ✅ |
| 주문 기준 줄은 확정하면 바로 청구 대상이고 청구서 초안부터 센다 | `purchase.test.mjs › D1: bills count from the draft; an order-policy line is due at once, a receipt-policy line when received` | SQL | ✅ |
| 입고 기준 줄은 들어온 만큼만 청구 대상이고 음수도 그대로 둔다 | `purchase.test.mjs › billing against receipts: partial bills, more than received, a refund taking it back` | SQL | ✅ |
| 서비스 줄도 청구 기준을 따른다 | `purchase.test.mjs › services are received by hand even with transfers around; billing policy decides what is due` | SQL | ✅ |
| 처음 산 공급사는 제품의 공급사 목록에 더해진다 | `purchase.test.mjs › a new vendor joins the product's price list on confirmation; a known one stays as it was` | SQL | ✅ |
| 이미 있는 공급사의 조건은 바꾸지 않는다 | `purchase.test.mjs › a new vendor joins the product's price list on confirmation; a known one stays as it was` | SQL | ✅ |
| 부족이 견적 요청이 되고 입고까지 이어진다 | `purchase.test.mjs › S4: a shortage becomes an RFQ, confirming makes the receipt, receiving raises stock, cost and receipt status` | SQL | ✅ |
| 같은 공급사 요청은 요청으로 만든 초안에 모이고 같은 줄은 수량이 는다 | `purchase.test.mjs › requests for one vendor gather on one draft; a sent one or one prepared by hand is left alone` | SQL | ✅ |
| 구매를 켜고 재주문에서 입고까지 화면으로 진행한다 | `growth.test.mjs › S4. purchase turned on: a reorder rule becomes a request, an order, a receipt and real lead times`<br>`growth.spec.mjs › S4. 구매를 켠다: 재주문 규칙이 요청을 만들고, 구매 주문과 입고로 재고가 는다` | SQL, 브라우저 | ✅ |
| 사람이 만든 초안도 주문한 것으로 센다 | `purchase.test.mjs › requests for one vendor gather on one draft; a sent one or one prepared by hand is left alone` | SQL | ✅ |
| 예측은 초안이 바뀌는 대로 따라간다 | `purchase.test.mjs › the forecast follows what happens to the draft: edited, sent, cancelled` | SQL | ✅ |
| 구매만 켠 회사는 입고 전표 없이 확정된다 | `isolation.test.mjs › modules [purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase] work together with nothing stuck`<br>`purchase.test.mjs › an RFQ computes its amounts and stays out of receiving and billing until confirmed` | SQL | ✅ |
| 재고를 나중에 켜면 옛 주문은 직접 입력하고 새 주문은 전표를 받는다 | `purchase.test.mjs › stock turned on after purchasing started: old orders stay typed by hand, new ones get receipts` | SQL | ✅ |
| 확정을 되돌리면 입고 전표도 사라지고 다시 확정할 수 있다 | `purchase.test.mjs › undoing a confirmation takes the receipt with it, and purchasing can be confirmed again` | SQL | ✅ |
| 확정을 되돌리는 미리보기는 공급사에게 따로 알리라고 경고한다 | ✗ | — | ✗ |
| 전부 다시 만들어도 숫자가 같다 | `purchase.test.mjs › everything both modules did replays to the same numbers` | SQL | ✅ |
| 구매·회계 역할이 아니면 구매 문서가 보이지 않는다 | `purchase.test.mjs › reading: buyers and accounting see purchase documents, others do not; the report, dashboard and catalogue answer` | SQL | ✅ |
| 회계 역할은 구매 문서를 읽기만 한다 | ✗ | — | ✗ |
| 줄 단위 구매 보고서를 읽는다 | `purchase.test.mjs › reading: buyers and accounting see purchase documents, others do not; the report, dashboard and catalogue answer` | SQL | ✅ |
| 구매 현황 집계를 읽는다 | `purchase.test.mjs › reading: buyers and accounting see purchase documents, others do not; the report, dashboard and catalogue answer` | SQL | ✅ |
| 공급사 카탈로그를 읽는다 | `purchase.test.mjs › reading: buyers and accounting see purchase documents, others do not; the report, dashboard and catalogue answer` | SQL | ✅ |
| 구매를 끄면 명령이 막히고 문서는 남는다 | `purchase.test.mjs › purchasing off refuses its commands and keeps its documents`<br>`isolation.test.mjs › modules [sales] work together with nothing stuck` | SQL | ✅ |
| 구매가 꺼지면 메뉴가 없고 켜면 나타난다 | `growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다`<br>`growth.spec.mjs › S4. 구매를 켠다: 재주문 규칙이 요청을 만들고, 구매 주문과 입고로 재고가 는다` | 브라우저 | ✅ |
| 재고나 청구가 꺼지면 그 칸이 보이지 않는다 | ✗ | — | ✗ |

◐ 잘못된 입력은 저장되지 않는다: 할인 101% 거부는 시험에 없다.

◐ 잠긴 주문은 숫자와 취소가 막히고 메모는 받는다: 시험은 `note` 만 저장해 보고 `vendor_ref` 는 저장해 보지 않는다.

◐ 서비스 줄은 직접 입력하고 입고 상태에 들어가지 않는다: 시험 이름과 달리 본문에 입고 전표가 없어서, 전표가 있는 주문의 서비스 줄 입력은 확인하지 못한다.

✗ 표시한 시나리오는 저장소에 시험이 없다. 코드를 읽고 임시 DB 에서 한 번 실행해 동작을 확인한 것이다.

## 시나리오에 대응하지 않는 시험

- `isolation.test.mjs › purchase does not reach into other modules`
