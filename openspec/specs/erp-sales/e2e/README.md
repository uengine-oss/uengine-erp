# E2E — erp-sales

견적 작성부터 확정, 납품·청구 상태, 선금, 고객 포털, 역할까지 판매 모듈이 약속한 동작을 실제 PostgreSQL 위의 공개 명령과 공개 함수로 확인한다. 재고와 청구는 대부분 그 모듈이 낼 이벤트를 시험이 직접 내서 흉내 내고, 성장 시나리오 시험은 진짜 모듈을 켜서 같은 동작을 확인한다. 브라우저 시험은 실제 화면에서 판매만 켜진 회사의 견적부터 주문까지와 재고를 켠 뒤의 납품 상태를 따라간다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/sales.test.mjs test/growth.test.mjs
source scripts/local-env.sh && npm run test:e2e -- growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 판매만 켜진 회사에서 견적을 보내고 주문으로 확정한다 | `growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다`<br>`growth.test.mjs › S1. a new company starts with sales alone` | 브라우저, SQL | ✅ |
| 재고와 청구가 없으면 두 상태는 해당 없음이다 | `sales.test.mjs › S1: alone, sales runs from quote to order and both statuses say "does not apply"`<br>`growth.test.mjs › S1. a new company starts with sales alone` | SQL | ✅ |
| 청구 모듈을 나중에 켜면 고른 날짜 이후의 주문만 청구 상태가 뜻을 갖는다 | `sales.test.mjs › S1: alone, sales runs from quote to order and both statuses say "does not apply"`<br>`sales.test.mjs › orders older than the chosen date stay out of the invoice status` | SQL | ✅ |
| 번호와 합계와 마진과 예상 납품일이 줄에서 계산된다 | `sales.test.mjs › numbers, totals, margin and the expected date` | SQL | ✅ |
| 구역과 메모 줄은 금액 없이 줄 사이에 놓인다 | `sales.test.mjs › sections and notes sit between lines and move with the array` | SQL | ✅ |
| 저장하면 바뀐 것만 이벤트로 남는다 | `sales.test.mjs › saving the whole collection records only what changed, as line events with the totals` | SQL | ✅ |
| 견적·주문 목록에 주문이 보인다 | `growth.spec.mjs › 목록은 실제 문서의 열을 보여 준다` | 브라우저 | ◐ |
| 고객을 고르면 소속 회사의 조건과 주소가 오고 없으면 기본값을 쓴다 | `sales.test.mjs › the partner brings its address, pricelist, terms, fiscal position and salesperson, through its company` | SQL | ✅ |
| 견적의 고객을 바꾸면 조건이 함께 바뀐다 | `sales.test.mjs › changing the customer on a quotation brings the new customer's terms along` | SQL | ✅ |
| 새 견적의 유효 기한과 서명·결제 기본값 | `sales.test.mjs › validity defaults to the company setting and a template; an expired quote can still be confirmed` | SQL | ✅ |
| 만료된 견적도 상태는 그대로이고 사람이 확정할 수 있다 | `sales.test.mjs › validity defaults to the company setting and a template; an expired quote can still be confirmed` | SQL | ✅ |
| 줄 없는 견적은 확정되고 제품 없는 줄은 확정이 거부된다 | `sales.test.mjs › an empty quote can be confirmed, a line without a product cannot, and a product that is not for sale goes through` | SQL | ✅ |
| 양식이 줄과 선택 제품과 조건을 채우고 직접 넣은 값이 먼저다 | `sales.test.mjs › a template fills lines, options, validity, signature and payment, and the caller still wins` | SQL | ✅ |
| 있는 견적에서 양식을 고르면 줄이 바뀌고 양식의 잘못된 값은 거부된다 | `sales.test.mjs › a template fills lines, options, validity, signature and payment, and the caller still wins` | SQL | ✅ |
| 계산된 단가는 수량을 따르고 입력한 단가는 남는다 | `sales.test.mjs › a computed price follows the quantity; a typed price stays and the discount returns to the rule` | SQL | ✅ |
| 확정 줄도 수량을 따라 단가가 바뀌지만 청구된 단가는 그대로다 | `sales.test.mjs › a confirmed line reprices with its quantity too, unless it has been invoiced` | SQL | ✅ |
| 가격표나 세금 조정을 바꿔도 줄은 요청 전까지 그대로이고 다른 제품은 처음부터 계산한다 | `sales.test.mjs › changing the pricelist or fiscal position does not touch lines until asked; a new product starts over` | SQL | ✅ |
| 세금 조정은 전부 포함 세금인 줄의 단가만 바꾼다 | `sales.test.mjs › a fiscal position changes an included price only when every tax on the line is included` | SQL | ✅ |
| 수량과 할인은 소수 둘째 자리로 단가는 입력한 그대로 저장된다 | `sales.test.mjs › inputs: quantity and discount keep two places, the price stays as typed` | SQL | ✅ |
| 다스로 팔면 단가와 원가와 출고 수량이 환산된다 | `sales.test.mjs › selling in another unit converts price, cost and the quantity moved` | SQL | ✅ |
| 속성 방식에 따라 변형이 정해지고 값이 단가에 더해진다 | `sales.test.mjs › variants: always, dynamic, and values that make no variant` | SQL | ✅ |
| 콤보는 단가 0 인 줄과 몫대로 값이 매겨진 항목 줄이 되고 항목은 콤보 줄을 따른다 | `sales.test.mjs › a combo sells as one line of no value plus its chosen items, priced in proportion` | SQL | ✅ |
| 세금이 하나인 주문의 세 가지 일괄 할인 | `sales.test.mjs › bulk discount, one tax: on every line, as a line, and as an amount with tax included`<br>`sales.test.mjs › S1: alone, sales runs from quote to order and both statuses say "does not apply"` | SQL | ✅ |
| 세금 조합마다 음수 줄이 하나씩 더해진다 | `sales.test.mjs › bulk discount, several taxes: one line per tax combination, shares by what each combination comes to` | SQL | ✅ |
| 확정되거나 잠긴 주문에도 일괄 할인이 되고 잘못된 값은 거부된다 | `sales.test.mjs › bulk discount: on a confirmed or locked order, bad values, nothing to discount` | SQL | ✅ |
| 가격 다시 계산은 할인 줄도 0 으로 돌리고 취소된 주문은 다시 계산을 거부한다 | ✗ | — | ✗ |
| 선택 제품은 값이 매겨지고 추가하면 새 줄이 된다 | `sales.test.mjs › optional products: priced like lines, added on request as new lines, never on a confirmed order` | SQL | ✅ |
| 미리보기는 저장 없이 합계와 고객의 조건을 돌려준다 | `sales.test.mjs › preview shows what saving would store, and stores nothing`<br>`sales.test.mjs › optional products: priced like lines, added on request as new lines, never on a confirmed order` | SQL | ✅ |
| 복제하면 새 번호의 견적이 되고 지난 일은 따라오지 않는다 | `sales.test.mjs › a copy is a new quotation with quantities and discounts, and nothing from its past` | SQL | ✅ |
| 확정하면 주문일이 지금으로 바뀌고 뒤의 가격 계산 기준이 된다 | `sales.test.mjs › confirming moves the order date to now, and prices recomputed later use that date` | SQL | ✅ |
| 확정 줄은 제품을 바꾸거나 지울 수 없고 추가와 가격 변경은 된다 | `sales.test.mjs › a confirmed line keeps its product and cannot be removed, only zeroed; sections come and go` | SQL | ✅ |
| 재화 줄은 납품 수량 아래로 줄일 수 없고 서비스 줄은 줄일 수 있다 | `sales.test.mjs › order-qty-change: quantities follow, down to what was delivered and no further`<br>`sales.test.mjs › a service may go below its typed delivered quantity; goods may not` | SQL | ✅ |
| 잠긴 주문은 수량과 단가와 설명과 세금 변경과 취소를 거부한다 | `sales.test.mjs › a locked order refuses quantity, price, description, taxes and cancelling, and takes notes, discounts and new lines` | SQL | ✅ |
| 잠긴 주문도 메모와 할인과 새 줄은 받고 풀면 다시 고칠 수 있다 | `sales.test.mjs › a locked order refuses quantity, price, description, taxes and cancelling, and takes notes, discounts and new lines` | SQL | ✅ |
| 견적을 보내면 토큰이 정해지고 다시 보내도 같다 | `sales.test.mjs › state transitions: send, cancel, back to draft, delete` | SQL | ✅ |
| 확정 주문과 취소된 주문은 정해진 길만 간다 | `sales.test.mjs › state transitions: send, cancel, back to draft, delete` | SQL | ✅ |
| 견적과 취소된 주문은 지울 수 있고 취소해도 납품한 수량은 남는다 | `sales.test.mjs › state transitions: send, cancel, back to draft, delete` | SQL | ✅ |
| 주문을 확정하면 재고 모듈이 전표를 만들고 출고하면 납품 상태가 바뀐다 | `growth.test.mjs › S2. inventory turned on later: it hears sales without sales knowing it exists`<br>`growth.spec.mjs › S2. 주문을 확정하면 재고 모듈이 전표를 만들고, 출고하면 재고가 줄고 납품 상태가 바뀐다` | SQL, 브라우저 | ✅ |
| 재고가 모자라도 주문 확정은 막히지 않는다 | `growth.test.mjs › S2. a shortage does not stop an order; the delivery waits`<br>`growth.spec.mjs › S2. 적게 출고하면 남은 수량을 묻고, 재고가 모자라도 주문은 막히지 않는다` | SQL, 브라우저 | ✅ |
| 전표 상태가 납품 상태를 정한다 | `sales.test.mjs › delivery status comes from the transfers: done with no backorder is full, cancelled is nothing, an open return is partial`<br>`sales.test.mjs › o2c: quote, partial delivery with a backorder, invoices and the rest, as the other modules report them`<br>`growth.spec.mjs › S2. 적게 출고하면 남은 수량을 묻고, 재고가 모자라도 주문은 막히지 않는다` | SQL, 브라우저 | ✅ |
| 초과 납품과 반품이 납품 수량을 바꾼다 | `sales.test.mjs › delivery status comes from the transfers: done with no backorder is full, cancelled is nothing, an open return is partial` | SQL | ✅ |
| 사람이 입력한 납품 수량에 전표가 더해진다 | `sales.test.mjs › a person types delivered quantities until a transfer starts tracking the line`<br>`sales.test.mjs › S1: alone, sales runs from quote to order and both statuses say "does not apply"` | SQL | ✅ |
| 청구 수량은 초안부터 세고 금액은 게시부터 센다 | `sales.test.mjs › o2c: quote, partial delivery with a backorder, invoices and the rest, as the other modules report them` | SQL | ✅ |
| 주문 수량 기준이면 초과 납품이 추가 판매 기회가 된다 | `sales.test.mjs › invoice policy "ordered": invoiced qty moves at the draft, upselling after over-delivery` | SQL | ✅ |
| 납품 수량 기준이면 나간 만큼만 청구 대기가 된다 | `sales.test.mjs › invoice policy "delivered": only what went out, cancelling a draft gives it back, partial is "no"` | SQL | ✅ |
| 서비스도 청구 기준을 따르고 일부만 청구된 주문은 no 다 | `sales.test.mjs › services follow the policy, and a mixed order is "no" once the invoiceable part is invoiced` | SQL | ✅ |
| 대변 메모는 초안부터 청구 수량을 되돌리고 다른 문서의 이벤트는 무시한다 | `sales.test.mjs › one line over-delivered and the rest exact is upselling; a credit note brings quantities back, even as a draft` | SQL | ✅ |
| 선금 청구서 초안이 오면 구역과 선금 줄이 생기고 합계는 그대로다 | `sales.test.mjs › down payment: a section and a line on the order, deducted later, never counted in the totals or the status` | SQL | ✅ |
| 게시된 선금은 최종 청구서에서 차감된다 | `sales.test.mjs › down payment: a section and a line on the order, deducted later, never counted in the totals or the status`<br>`sales.test.mjs › down payment corrections: cancelled, reset to draft, partly and fully credited` | SQL | ✅ |
| 선금 청구서를 취소하거나 대변 메모로 되돌리면 선금 줄이 따라간다 | `sales.test.mjs › down payment corrections: cancelled, reset to draft, partly and fully credited` | SQL | ✅ |
| 선금 줄은 손으로 지울 수 없다 | `sales.test.mjs › an order line with a down payment cannot be removed by hand` | SQL | ✅ |
| 토큰으로 견적 하나를 보고 내부 값은 보이지 않는다 | `sales.test.mjs › portal: anyone with the token sees one quotation, and nothing internal`<br>`sales.test.mjs › portal: with the module off the link says so` | SQL | ✅ |
| 서명만 요구하는 견적은 서명하면 확정된다 | `sales.test.mjs › portal: signing confirms a quotation that only asks for a signature` | SQL | ✅ |
| 결제를 요구하는 견적은 담당자를 기다리고 만료되었거나 서명이 필요 없는 견적은 거부된다 | `sales.test.mjs › portal: a quotation that also asks for payment waits, an expired one or one with no signature required refuses` | SQL | ✅ |
| 포털에서 선택 제품을 담으면 표시된 줄이 생기고 거절하면 사유와 함께 취소된다 | `sales.test.mjs › portal: declining cancels the quotation with the reason, and options can be added` | SQL | ✅ |
| 만료된 견적은 포털에서 선택 제품을 담을 수 없고 거절은 된다 | ✗ | — | ✗ |
| 확정과 그 뒤의 변경과 취소가 납품처와 줄의 사실을 싣는다 | `sales.test.mjs › events carry the facts the other modules were promised` | SQL | ✅ |
| 같은 이벤트가 두 번 와도 아무것도 바뀌지 않는다 | `sales.test.mjs › the same event twice changes nothing` | SQL | ✅ |
| 전표 작업을 되돌리면 납품 수량도 돌아간다 | `sales.test.mjs › a rollback of the transfer takes its delivered quantity along` | SQL | ✅ |
| 구매 담당자는 주문을 읽을 수만 있다 | `sales.test.mjs › only sales roles write, everyone reads` | SQL | ✅ |

◐ 견적·주문 목록에 주문이 보인다: 시험은 표의 첫 줄이 보이는지만 확인한다. 열 구성은 카탈로그와 앱 코드에서만 확인했다.

## 시나리오에 대응하지 않는 시험

- `sales.test.mjs › the catalog matches docs/modules/sales.md, and the module says what it publishes`
- `sales.test.mjs › the projection always equals a replay of the ledger`
