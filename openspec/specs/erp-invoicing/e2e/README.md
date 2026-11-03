# E2E — erp-invoicing

청구서·공급사 청구서·대변 메모·입금·미수금의 금액과 상태, 오류 코드, 동시 요청, 역할, 모듈 꺼짐을 실제 데이터베이스 명령으로 확인하고, 청구 대상에서 청구서를 만들어 게시하고 입금하는 흐름을 실제 화면으로 확인한다. `invoicing.test.mjs` 는 청구 모듈만 켠 회사에서 돌고 판매·구매 주문은 계약 모양의 레코드와 이벤트로 흉내 낸다. `growth.test.mjs`, `isolation.test.mjs` 와 브라우저 시험은 실제 모듈 위에서 돈다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/invoicing.test.mjs test/growth.test.mjs test/isolation.test.mjs test/rebuild-gl.test.mjs
source scripts/local-env.sh && npm run test:e2e -- growth.spec.mjs rollback.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321)

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 할인과 세금을 줄마다 계산하고 번호는 게시할 때 붙인다 | `invoicing.test.mjs › a draft computes amounts line by line and has no number until posted` | SQL | ✅ |
| 제품을 고르면 제품의 값으로 채우고 잘못된 입력은 거부한다 | `invoicing.test.mjs › a product line takes its name, unit, price and taxes from the product; a blank line needs words` | SQL | ✅ |
| 초안의 줄을 고치면 금액이 다시 계산되고 바뀐 것이 없으면 기록하지 않는다 | `invoicing.test.mjs › line edits become line events, a no-op writes nothing, and subscribers hear every draft change` | SQL | ✅ |
| 저장하지 않고 금액을 미리 계산한다 | `invoicing.test.mjs › the form asks and the same rules answer, without writing` | SQL | ✅ |
| 비어 있거나 음수인 문서는 게시되지 않고 0원 문서는 바로 끝난다 | `invoicing.test.mjs › posting refuses an empty or negative document and closes a zero one at once` | SQL | ✅ |
| 할부 결제 조건은 금액을 나누고 만기일은 마지막 할부다 | `invoicing.test.mjs › payment terms split the amount, the due date is the last installment, a direct date is taken as given` | SQL | ✅ |
| 문서 종류마다 번호 형식이 다르다 | `invoicing.test.mjs › a draft computes amounts line by line and has no number until posted`<br>`invoicing.test.mjs › a bill needs its date; an invoice does not`<br>`invoicing.test.mjs › a credit note starts as a draft copy and closes an unpaid invoice when posted`<br>`invoicing.test.mjs › credit notes from nothing, vendor refunds and debit notes` | SQL | ✅ |
| 초안 복귀와 취소를 거쳐도 번호가 같고 번호 붙은 문서는 삭제되지 않는다 | `invoicing.test.mjs › reset keeps the number, cancel keeps it too, and only an unnumbered draft can vanish` | SQL | ✅ |
| 취소된 번호와 빠진 번호를 조회한다 | `invoicing.test.mjs › reset keeps the number, cancel keeps it too, and only an unnumbered draft can vanish` | SQL | ✅ |
| 입금이 맞물린 청구서를 되돌리거나 취소해도 돈은 입금에 남는다 | `invoicing.test.mjs › taking a paid invoice back to draft or cancelling it frees the money and keeps the payment` | SQL | ✅ |
| 주문 기준은 주문 수량을, 납품 기준은 납품한 만큼을 청구한다 | `invoicing.test.mjs › order policy bills the ordered quantity, delivery policy what went out, and a draft already counts` | SQL | ✅ |
| 구역·메모 줄과 청구 거래처와 참조를 주문에서 가져온다 | `invoicing.test.mjs › layout rows travel with the lines and the order supplies partner, terms and reference` | SQL | ✅ |
| 확정되지 않았거나 읽을 수 없는 주문은 거부한다 | `invoicing.test.mjs › only confirmed orders, only when the order can be read` | SQL | ✅ |
| 반품 뒤의 다음 청구는 대변 메모가 된다 | `invoicing.test.mjs › returned goods make a credit note out of the next invoice` | SQL | ✅ |
| 일부 줄만 고를 수 있고 동시에 눌러도 한 번만 청구된다 | `invoicing.test.mjs › a single order can choose some lines, and a second click cannot bill the same quantity` | SQL | ✅ |
| 청구 대상 화면과 주문 화면에서 청구서를 만든다 | `growth.test.mjs › S5. invoicing, then accounting: the books are rebuilt from what happened before`<br>`growth.spec.mjs › S5. 청구를 켠다: 청구 대상에서 청구서를 만들어 게시하고 입금을 등록한다` | SQL, 브라우저 | ✅ |
| 공급사 청구서는 청구일이 있어야 게시된다 | `invoicing.test.mjs › a bill needs its date; an invoice does not` | SQL | ✅ |
| 입고 기준은 입고를 기다리고 주문 기준은 기다리지 않으며 과다 청구는 되돌아온다 | `invoicing.test.mjs › purchase: receipt policy waits for goods, order policy does not, over-billing comes back as a refund`<br>`growth.spec.mjs › S5. 청구를 켠다: 청구 대상에서 청구서를 만들어 게시하고 입금을 등록한다` | SQL, 브라우저 | ✅ |
| 기준일 전 주문은 청구 대상이 아니고 껐다 켜도 그대로다 | `invoicing.test.mjs › orders_since limits what can be invoiced and what the screen offers, and survives turning off and on` | SQL | ✅ |
| 구매 주문은 기준일 전이어도 공급사 청구서를 만들 수 있다 | ✗ | — | ✗ |
| 비율 선금은 세금 묶음마다 공급가에 곱한다 | `invoicing.test.mjs › a percentage down payment takes the taxed total; a fixed one is what the customer pays`<br>`invoicing.test.mjs › a down payment splits by tax group, and a fixed amount lands on exactly that total` | SQL | ✅ |
| 정액 선금은 고객이 내는 금액과 끝수까지 같다 | `invoicing.test.mjs › a percentage down payment takes the taxed total; a fixed one is what the customer pays`<br>`invoicing.test.mjs › a down payment splits by tax group, and a fixed amount lands on exactly that total` | SQL | ✅ |
| 0 이하의 선금과 잘못된 요청은 거부하고 주문을 넘는 금액은 받아들인다 | `invoicing.test.mjs › limits: zero and negative are refused, more than the order is not`<br>`invoicing.test.mjs › a down payment is for sales orders and only known methods` | SQL | ✅ |
| 최종 청구는 게시 여부와 상관없이 선금을 모두 뺀다 | `invoicing.test.mjs › the final invoice deducts every down payment, posted or not, and points at the order line`<br>`invoicing.test.mjs › a down payment recorded only on the order is deducted from it, once` | SQL | ✅ |
| 선금이 상품보다 많으면 대변 메모가 되고 같으면 0원 청구서가 된다 | `invoicing.test.mjs › more down payment than goods makes a credit note`<br>`invoicing.test.mjs › a full down payment leaves a zero final invoice that closes itself` | SQL | ✅ |
| 선금에 대변 메모를 만들면 더는 차감하지 않는다 | `invoicing.test.mjs › a credit note on a down payment takes it out of later deductions` | SQL | ✅ |
| 대변 메모는 초안으로 시작하고 게시하면 미결제 청구서를 닫는다 | `invoicing.test.mjs › a credit note starts as a draft copy and closes an unpaid invoice when posted` | SQL | ✅ |
| 대변 메모는 남은 금액까지만 맞물린다 | `invoicing.test.mjs › a partial credit note after a partial payment leaves the rest open`<br>`invoicing.test.mjs › a credit note larger than what is open keeps the rest; money already in means paid, not reversed` | SQL | ✅ |
| 완납한 청구서의 대변 메모는 지급으로 환불한다 | `invoicing.test.mjs › a credit note on a paid invoice stays open and is refunded with an outgoing payment` | SQL | ✅ |
| 맞물림을 풀면 대변 메모를 다시 게시할 때만 다시 맞물리고 손으로도 맞춘다 | `invoicing.test.mjs › undoing a credit note or its invoice lets go of the match, and only the credit note re-matches on posting` | SQL | ✅ |
| 미래 날짜 대변 메모만 그날까지 기다렸다 자동으로 게시된다 | `invoicing.test.mjs › a credit note dated ahead waits for its day and posts itself then` | SQL | ✅ |
| 전액 정정은 먼저 받은 돈을 풀고 같은 내용의 새 초안을 연다 | `invoicing.test.mjs › correcting in full posts the credit note at once, frees earlier money and opens a new draft` | SQL | ✅ |
| 공급사 청구서를 정정하고 원 문서 없는 대변 메모는 열려 있다 | `invoicing.test.mjs › credit notes from nothing, vendor refunds and debit notes` | SQL | ✅ |
| 차변 메모와 복사는 주문과 잇지 않은 새 초안을 만든다 | `invoicing.test.mjs › credit notes from nothing, vendor refunds and debit notes` | SQL | ✅ |
| 일부 입금은 처리 중이고 문서가 끝나면 함께 완료된다 | `invoicing.test.mjs › payment state follows the invoice: in process until everything it touched is closed` | SQL | ✅ |
| 문서 없는 입금은 문서를 기다리고 초안 문서에는 맞추지 않는다 | `invoicing.test.mjs › a standalone receipt waits for a document; paying a draft document keeps the money unattached` | SQL | ✅ |
| 청구서 화면에서 입금을 등록하면 결제 완료가 된다 | `growth.test.mjs › S5. invoicing, then accounting: the books are rebuilt from what happened before`<br>`growth.spec.mjs › S5. 청구를 켠다: 청구 대상에서 청구서를 만들어 게시하고 입금을 등록한다` | SQL, 브라우저 | ✅ |
| 돈을 내줄 문서의 버튼은 지급 등록이다 | ✗ | — | ✗ |
| 초과 입금은 미배분으로 기다리고 문서에 맞추면 입금이 처리 중으로 돌아간다 | `invoicing.test.mjs › overpaying leaves a credit that waits to be applied, and applying it reopens the payment` | SQL | ✅ |
| 탈락 금액은 모자란 돈으로 문서를 끝낼 때만 넣을 수 있다 | `invoicing.test.mjs › a write-off closes the invoice with less money; without one the rest stays open` | SQL | ✅ |
| 여러 문서 입금은 기본이 문서마다 한 건이고 묶으면 거래처별로 남은 금액만 낸다 | `invoicing.test.mjs › several documents pay separately by default, and grouped they net per partner` | SQL | ✅ |
| 제안 금액은 다음 할부이고 그다음은 남은 금액이다 | `invoicing.test.mjs › the suggested amount is the next installment, then what is left` | SQL | ✅ |
| 기한 안에 할인 금액을 내면 차액은 탈락으로 끝난다 | `invoicing.test.mjs › an early discount is taken by paying in time, and only then` | SQL | ✅ |
| 기한이 지나면 할인 없이 전액을 제안하고 할인 금액만 내면 부분 입금이다 | `invoicing.test.mjs › an early discount is taken by paying in time, and only then` | SQL | ✅ |
| 같은 금액만 짝짓거나 오래된 문서부터 모두 쓴다 | `invoicing.test.mjs › automatic matching pairs equal amounts, or spends everything oldest first` | SQL | ✅ |
| 합쳐진 거래처의 입금이 옛 문서에 맞물리고 연령 분석은 하나로 보인다 | `invoicing.test.mjs › money from a merged contact still meets the old documents, and aging shows them as one` | SQL | ✅ |
| 거부 표시는 청구서를 바꾸지 않는다 | `invoicing.test.mjs › a rejected payment is a mark only; the invoice stays as it was until someone cancels` | SQL | ✅ |
| 입금을 취소하면 문서가 다시 열리고 번호 붙은 입금은 삭제되지 않는다 | `invoicing.test.mjs › cancelling money reopens what it paid; a draft can come back, a posted one cannot be deleted` | SQL | ✅ |
| 두 입금이 동시에 같은 청구서를 맞춰도 넘치지 않는다 | `invoicing.test.mjs › two payments at once cannot pay the same money twice` | SQL | ✅ |
| 남은 금액을 할부별 만기로 나누고 크레딧을 빼며 과거도 본다 | `invoicing.test.mjs › aging puts each installment in its own bucket, nets credits and can look back` | SQL | ✅ |
| 미수금·미지급금 화면에 거래처별 남은 금액이 보인다 | `growth.spec.mjs › S5. 청구를 켠다: 청구 대상에서 청구서를 만들어 게시하고 입금을 등록한다` | 브라우저 | ✅ |
| 미지급금은 공급사 문서의 남은 금액이다 | `rebuild-gl.test.mjs › what the books say is owed equals what invoicing says is open`<br>`invoicing.test.mjs › aging puts each installment in its own bucket, nets credits and can look back` | SQL | ◐ |
| 게시한 청구서와 입금의 되돌리기는 막고 초안 작성은 되돌린다 | `invoicing.test.mjs › posted documents refuse rollback and point at the correction` | SQL | ✅ |
| 주문을 되돌리려 해도 게시한 청구서가 얽히면 막는다 | `growth.test.mjs › S6. rollback crosses module lines and a posted invoice stops it` | SQL | ✅ |
| 막힌 되돌리기는 화면에 안내만 보여 준다 | `rollback.spec.mjs › 게시된 청구서가 얽히면 막고 대변 메모를 안내한다` | 브라우저 | ◐ |
| 영업은 청구서를 만들 수 없고 회계만 문서와 입금을 쓴다 | `invoicing.test.mjs › who may do what` | SQL | ✅ |
| 읽을 수 있는 문서와 조회 기능이 역할로 갈린다 | `invoicing.test.mjs › who may do what` | SQL | ✅ |
| 회계 없이 청구와 입금이 끝까지 돈다 | `invoicing.test.mjs › invoicing runs with no books: nothing asks for accounts, and the module is off for journal entries`<br>`growth.test.mjs › S5. invoicing, then accounting: the books are rebuilt from what happened before`<br>`isolation.test.mjs › modules [invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing] work together with nothing stuck` | SQL | ✅ |
| 게시 이벤트는 구독자에게 사실을 싣고 전표를 쓰지 않는다 | `invoicing.test.mjs › InvoicePosted states every fact the contract promises` | SQL | ✅ |
| 모듈을 끄면 명령과 메뉴가 막히고 데이터는 남는다 | `invoicing.test.mjs › module off refuses commands but keeps the records; the catalog hides them`<br>`growth.spec.mjs › 모듈을 끄면 그 메뉴와 보고서가 사라지고 데이터는 남는다` | SQL, 브라우저 | ✅ |

- ◐ 「미지급금은 공급사 문서의 남은 금액이다」: 시험은 `payable` 합계가 시산표의 외상매입금 잔액과 같은지만 보고 구간별 금액은 보지 않는다. `invoicing.test.mjs` 의 `payable` 호출은 실행되는지만 본다.
- ◐ 「막힌 되돌리기는 화면에 안내만 보여 준다」: 브라우저 시험은 실제 청구서가 아니라 같은 막힘 사유 문구를 쓰는 시험용 문서 유형으로 화면을 확인한다. 실제 청구서의 막힘과 사유는 SQL 시험이 확인하고, 거기서는 사유에 「대변 메모」가 들어 있는지까지 본다.
- ✗ 「구매 주문은 기준일 전이어도 공급사 청구서를 만들 수 있다」: 시험이 없다. 코드에서만 확인했다.
- ✗ 「돈을 내줄 문서의 버튼은 지급 등록이다」: 시험이 없다. 브라우저 시험은 고객 청구서의 「입금 등록」만 확인한다. 앱 코드에서만 확인했다.
- 「모듈을 끄면 명령과 메뉴가 막히고 데이터는 남는다」의 데이터가 남는다는 부분은 브라우저 시험이 확인한다. `invoicing.test.mjs` 쪽은 시험 이름과 달리 기록이 없는 회사에서 거부와 카탈로그만 본다.
- `isolation.test.mjs` 의 조합 시험 가운데 청구가 켜진 16개가 모두 같은 방식으로 확인한다. 표에는 회계가 꺼진 조합 둘만 적었다.

## 시나리오에 대응하지 않는 시험

- `isolation.test.mjs › invoicing does not reach into other modules`
