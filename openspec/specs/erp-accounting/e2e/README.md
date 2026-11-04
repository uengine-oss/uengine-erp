# E2E — erp-accounting

사실마다 어떤 전표가 나오는지, 수동 전표의 상태와 오류 코드, 보고서 4종의 일치, 읽기 권한을 시험으로 확인한다. 같은 작업을 준 세 회사(처음부터, 중간에, 전부 끝난 뒤에 회계를 켠 회사)의 장부를 비교해 나중에 켜도 같은 장부인지 확인하고, 실제 화면에서 회계를 켜고 전표와 보고서를 본다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/accounting.test.mjs test/rebuild-gl.test.mjs test/growth.test.mjs test/bus.test.mjs test/demo.test.mjs
source scripts/local-env.sh && npm run test:e2e -- growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321). `growth.spec.mjs` 는 한 회사를 S1 부터 차례로 키우는 직렬 시험이라 하나만 따로 돌리지 않는다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 고객 청구서를 게시하면 채권과 매출·세금 전표가 생긴다 | `accounting.test.mjs › customer invoice: receivable against income and tax` | SQL | ✅ |
| 고객 대변 메모는 같은 계정의 반대 전표가 된다 | `accounting.test.mjs › payment and credit note: the same accounts the other way` | SQL | ✅ |
| 입금은 고른 수단의 계정과 외상매출금으로 잡힌다 | `accounting.test.mjs › payment and credit note: the same accounts the other way`<br>`accounting.test.mjs › cash journal, refunds to customers and payments to vendors use the right accounts` | SQL | ✅ |
| 고객 환불과 공급사 지급·환불은 각자의 채권·채무 계정으로 잡힌다 | `accounting.test.mjs › cash journal, refunds to customers and payments to vendors use the right accounts` | SQL | ✅ |
| 탈락 금액은 기본 계정이나 지정한 계정과 사유로 잡힌다 | `accounting.test.mjs › a write-off books the difference on its account, by default bad debt on receipts and income on payments` | SQL | ✅ |
| 지급 탈락에 계정을 고르지 않으면 잡이익으로 잡힌다 | ✗ | — | ✗ |
| 조기 할인은 방식에 따라 세금까지 줄이거나 세금을 그대로 둔다 | `accounting.test.mjs › an early discount on the taxed amount lowers income and tax; on the untaxed amount only income` | SQL | ✅ |
| 묶음 세금과 나눗셈 세금은 세금별 계정으로 잡힌다 | `accounting.test.mjs › taxes in a group or on the taxed amount book separately per tax` | SQL | ✅ |
| 계정을 적지 않은 이벤트와 모르는 제품도 시드 계정으로 전표가 된다 | `accounting.test.mjs › a contract event that names no accounts, or products nobody knows, still books` | SQL | ✅ |
| 줄의 계정이 먼저이고 없으면 제품 분류와 그 상위 분류를 따른다 | `accounting.test.mjs › accounts come from the line, then the category and its parents, then the tax, then the seeds` | SQL | ✅ |
| 새 회사에는 미착품 계정과 기본 계정 연결이 들어 있다 | `accounting.test.mjs › the seed account for goods not yet billed exists and master seeds kept their accounts`<br>`accounting.test.mjs › setup seeds the account and leaves the module off, and the module card says what cannot be rebuilt` | SQL | ✅ |
| 선금은 선수금에 있다가 최종 청구서가 비운다 | `accounting.test.mjs › down payments sit on the advance account until the final invoice clears them` | SQL | ✅ |
| 재고 모듈이 켜져 있던 때의 저장 제품 청구서만 미착품으로 잡힌다 | `accounting.test.mjs › a bill debits goods-in-transit only if stock was on then, and only for stored goods` | SQL | ✅ |
| 용역과 제품 없는 줄과 저장하지 않는 제품은 미착품을 쓰지 않는다 | `accounting.test.mjs › a bill debits goods-in-transit only if stock was on then, and only for stored goods` | SQL | ✅ |
| 출고와 입고는 원가로 잡히고 날짜는 완료일이다 | `accounting.test.mjs › stock moves value at cost: out to cost of sales, in against goods in transit, returns the opposite` | SQL | ✅ |
| 반품의 방향은 플래그가 아니라 위치로 정해진다 | `accounting.test.mjs › stock moves value at cost: out to cost of sales, in against goods in transit, returns the opposite` | SQL | ✅ |
| 사내 이동과 원가 0 은 전표가 없다 | `accounting.test.mjs › stock moves value at cost: out to cost of sales, in against goods in transit, returns the opposite` | SQL | ✅ |
| 위치를 알 수 없으면 전표 유형과 반품 표시로 판단한다 | `accounting.test.mjs › with unknown locations the picking type and return flag decide` | SQL | ✅ |
| 실사 차이와 폐기는 재고자산감모손실로 잡힌다 | `accounting.test.mjs › stock count differences and scrap go to the shrinkage account` | SQL | ✅ |
| 할부 조건 청구서의 채권 줄은 만기일별로 나뉜다 | `accounting.test.mjs › installments split the receivable by due date, and a total the lines do not support stops only this subscriber` | SQL | ✅ |
| 합이 맞지 않는 이벤트에서 회계 구독만 멈춘다 | `accounting.test.mjs › installments split the receivable by due date, and a total the lines do not support stops only this subscriber` | SQL | ✅ |
| 사유를 남기고 건너뛰면 회계 구독이 다시 돈다 | `accounting.test.mjs › installments split the receivable by due date, and a total the lines do not support stops only this subscriber` | SQL | ✅ |
| 초안으로 되돌리면 전표가 그 기간에서 지워지고 다시 게시하면 새 날짜로 잡힌다 | `accounting.test.mjs › going back to draft or cancelling erases the entry from its period; posting again books the new date` | SQL | ✅ |
| 청구서나 입금을 취소하면 전표가 지워진다 | `accounting.test.mjs › going back to draft or cancelling erases the entry from its period; posting again books the new date` | SQL | ✅ |
| 전표는 원본 작업의 묶음을 이어받는다 | `accounting.test.mjs › an entry carries the source event's correlation and cause, so the source can take it along`<br>`rebuild-gl.test.mjs › every entry follows its source: same correlation, and the books lag only by when they were switched on` | SQL | ✅ |
| 전달된 뒤 되돌리면 전표도 함께 되돌아간다 | `accounting.test.mjs › rollback takes the entry along; before delivery there is nothing to take; a posted invoice refuses` | SQL | ✅ |
| 전달 전에 되돌린 작업은 전표를 만들지 않는다 | `accounting.test.mjs › rollback takes the entry along; before delivery there is nothing to take; a posted invoice refuses` | SQL | ✅ |
| 게시 청구서의 되돌리기는 전표까지 보여 주고 막힌다 | `accounting.test.mjs › rollback takes the entry along; before delivery there is nothing to take; a posted invoice refuses` | SQL | ✅ |
| 화면에서 수동 전표를 차대를 맞춰 게시한다 | `growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | 브라우저 | ✅ |
| 차대가 다른 전표는 게시되지 않고 맞추면 번호가 붙는다 | `accounting.test.mjs › manual entries: draft may be off balance, posting may not` | SQL | ✅ |
| 잘못된 전표 입력은 코드별로 거부된다 | `accounting.test.mjs › manual entries: draft may be off balance, posting may not` | SQL | ✅ |
| 역분개는 반대 전표를 게시하고 한 번만 된다 | `accounting.test.mjs › a manual entry can be reversed or reset; a generated one only through its source` | SQL | ✅ |
| 초안으로 되돌리면 효과가 지워지고 번호는 유지된다 | `accounting.test.mjs › a manual entry can be reversed or reset; a generated one only through its source` | SQL | ✅ |
| 번호가 붙은 전표는 삭제할 수 없고 번호 없는 전표는 취소 뒤 삭제된다 | `accounting.test.mjs › a manual entry can be reversed or reset; a generated one only through its source` | SQL | ✅ |
| 게시된 수동 전표는 되돌리기가 막히고 역분개를 안내한다 | `accounting.test.mjs › a manual entry can be reversed or reset; a generated one only through its source` | SQL | ✅ |
| 기초 잔액 전표는 그 뒤 기간의 기초로 보인다 | `accounting.test.mjs › opening balances are ordinary entries of their own kind` | SQL | ✅ |
| 자동 전표를 직접 고치면 ERP_AUTO_ENTRY 로 거부된다 | `accounting.test.mjs › a manual entry can be reversed or reset; a generated one only through its source` | SQL | ✅ |
| 화면의 자동 전표에는 저장 버튼이 없다 | `growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | 브라우저 | ✅ |
| 시산표는 전체와 기간 모두 합계가 맞는다 | `accounting.test.mjs › reports agree with each other and always balance` | SQL | ✅ |
| 계정별 원장은 시산표 기말과 이어진다 | `accounting.test.mjs › reports agree with each other and always balance` | SQL | ✅ |
| 시산표 화면에서 일치를 보고 계정별 원장으로 내려간다 | `growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | 브라우저 | ✅ |
| 손익계산서의 합계는 줄의 합과 같다 | `accounting.test.mjs › reports agree with each other and always balance` | SQL | ✅ |
| 재무상태표는 옮기지 않은 손익까지 넣어 항상 맞는다 | `accounting.test.mjs › reports agree with each other and always balance`<br>`growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | SQL, 브라우저 | ✅ |
| 외상매출금·외상매입금 잔액은 미수금·미지급금 합계와 같다 | `rebuild-gl.test.mjs › what the books say is owed equals what invoicing says is open` | SQL | ✅ |
| 회계 역할이 아니면 보고서와 장부 줄을 읽거나 쓸 수 없다 | `accounting.test.mjs › only accounting reads the books; the module off refuses its commands and keeps listening where it stopped` | SQL | ✅ |
| 회계 권한이 없으면 보고서 메뉴가 없고 주소로 가도 오류가 보인다 | `growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | 브라우저 | ✅ |
| 회계를 끈 동안 명령은 거부되고 다시 켜면 밀린 이벤트가 전표가 된다 | `accounting.test.mjs › only accounting reads the books; the module off refuses its commands and keeps listening where it stopped`<br>`growth.spec.mjs › 모듈을 끄면 그 메뉴와 보고서가 사라지고 데이터는 남는다` | SQL, 브라우저 | ✅ |
| 회계만 켠 회사도 재고 이벤트로 장부를 만든다 | `accounting.test.mjs › books run with nothing else on: stock events and manual entries are enough` | SQL | ✅ |
| 다시 만들기 뒤에도 장부가 같다 | `accounting.test.mjs › derived totals rebuild from the ledger to the same numbers` | SQL | ✅ |
| 설치 SQL 을 다시 실행해도 장부와 커서가 그대로다 | `accounting.test.mjs › running the install files again changes nothing and keeps the cursor` | SQL | ✅ |
| S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고 보고서가 맞는다 | `growth.test.mjs › S5. invoicing, then accounting: the books are rebuilt from what happened before`<br>`growth.spec.mjs › S5. 청구를 켠다: 청구 대상에서 청구서를 만들어 게시하고 입금을 등록한다`<br>`growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | SQL, 브라우저 | ✅ |
| 언제 켜도 시산표가 정확히 같다 | `rebuild-gl.test.mjs › the trial balance is exactly the same however late accounting was turned on` | SQL | ✅ |
| 기간별 보고서와 계정·날짜·거래처별 금액도 같다 | `rebuild-gl.test.mjs › so are the periods, profit and loss, and the balance sheet`<br>`rebuild-gl.test.mjs › account by account, date by date, partner by partner` | SQL | ✅ |
| 실제 모듈로 돌려도 회계를 마지막에 켠 회사의 장부가 같다 | `growth.test.mjs › accounting turned on last gives the same books as accounting from the start, on the real modules` | SQL | ✅ |
| 지난 일은 그때의 설정으로 전표가 된다 | `rebuild-gl.test.mjs › details that only hold if replay reads the past` | SQL | ✅ |
| 전표 날짜는 다시 만든 날이 아니라 업무 날짜다 | `rebuild-gl.test.mjs › details that only hold if replay reads the past`<br>`rebuild-gl.test.mjs › account by account, date by date, partner by partner` | SQL | ✅ |
| 같은 이벤트를 다시 받아도 전표가 늘지 않는다 | `rebuild-gl.test.mjs › the same event twice never makes a second entry` | SQL | ✅ |
| 늦게 켠 회사도 그 뒤로 평소처럼 장부가 쌓인다 | `rebuild-gl.test.mjs › a late company keeps working forward after the replay, like any other` | SQL | ✅ |
| 새 회사에서 회계는 꺼져 있고 켜기 창이 다시 만들 수 없는 것을 알린다 | `accounting.test.mjs › setup seeds the account and leaves the module off, and the module card says what cannot be rebuilt`<br>`growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다`<br>`growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다` | SQL, 브라우저 | ✅ |
| 장부 시작일을 고르면 그 날 이후의 이벤트만 전표가 된다 | `bus.test.mjs › replay reads from the beginning; since_option reads from a chosen date`<br>`demo.test.mjs › the books, the stock and the history add up` | SQL | ◐ |

◐ 장부 시작일: 날짜 옵션의 동작은 `bus.test.mjs` 가 시험용 모듈로만 확인한다. 데모 회사는 `books_since` 로 회계를 켜지만 `demo.test.mjs` 는 차변과 대변이 맞는지까지만 보고, 그 날짜 전의 이벤트가 전표에서 빠지는지는 회계 구독으로 확인하는 시험이 없다.

읽는 법:

- 재고 평가와 실사 차이 시나리오의 SQL 시험은 재고 모듈을 켜지 않고 이벤트 계약 모양대로 이벤트를 직접 넣는다. 실제 재고 모듈이 낸 이벤트로 전표가 되는지는 `growth.test.mjs › accounting turned on last gives the same books as accounting from the start, on the real modules` 가 시산표 수준에서 확인한다.
- `accounting.test.mjs`, `rebuild-gl.test.mjs` 는 대부분 관리자 계정으로 명령을 보낸다. `accounting` 역할로 보내는 명령은 `growth.test.mjs`, `growth.spec.mjs` 의 S5 시험이 확인한다.
- 코드에서만 확인한 문장(시나리오 없이 요구사항 본문에만 있음): 지급 쪽 조기 할인 계정, 공급사 선금의 선급금, 출고 원가에 제품 분류 비용 계정 쓰기, `kind` 가 `auto` 인 전표의 `reverse`·`update` 밖의 명령 거부, 시산표 화면의 기본 기간.

## 장부, 재무제표, 결산

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 실행 한 번은 계정별 한 줄의 전표 하나다 | `assets.test.mjs › a monthly run charges each asset and the books make one entry per account` | SQL | ✅ |
| 합계잔액시산표는 재무상태표 계정을 이월하고 손익 계정은 올해 것만 더한다 | `books.test.mjs › the trial balance of totals and balances: balance sheet accounts carry in, income and expense start from nothing`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 일계표는 현금과 대체를 나누고 현금 칸이 잔액과 맞는다 | `books.test.mjs › the day summary splits cash from the rest, and its cash columns meet the cash balance`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 월계표는 같은 보고서를 한 달로 보고 지난해 같은 달을 함께 보여 준다 | `books.test.mjs › the monthly summary is the same report over a month, against the same month a year before`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 현금출납장은 잔액을 이어 가고 상대 계정을 말한다 | `books.test.mjs › the cash book runs a balance, names the other side, and can read a bank account too`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 거래처 원장은 거래처별로 보고 눌러서 줄을 본다 | `books.test.mjs › the partner ledger: one row a partner, and every line of one`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 매입매출장은 문서별이고 취소한 문서는 없다 | `books.test.mjs › sales and purchase book: documents, not entries, and one taken back is gone`<br>`books.spec.mjs › 장부` | SQL, 브라우저 | ✅ |
| 손익계산서 | `books.test.mjs › the income statement: the sections of the form, the year before beside it`<br>`books.spec.mjs › 재무제표` | SQL, 브라우저 | ✅ |
| 재무상태표는 전기 말과 나란히 맞는다 | `books.test.mjs › the balance sheet: the groups of the form, against the end of the year before, and it balances`<br>`books.spec.mjs › 재무제표` | SQL, 브라우저 | ✅ |
| 재료비, 노무비, 경비에서 당기제품제조원가까지 | `books.test.mjs › materials, labour and overhead, opening and closing work in progress` | SQL | ✅ |
| 손익계산서와 이어진다 | `books.test.mjs › the income statement takes the total as a line under cost of sales, and the books still add up` | SQL | ✅ |
| 처분하면 다음 해의 전기이월과 맞물린다 | `books.test.mjs › the appropriation statement reads next year's entry, and last year's carried amount meets this one`<br>`books.spec.mjs › 재무제표` | SQL, 브라우저 | ✅ |
| 손실이면 결손금처리계산서다 | `books.test.mjs › the deficit form when the year lost money` | SQL | ✅ |
| 넣지 못한 것은 이유를 말한다 | `books.test.mjs › before anything happens: the transfer is shown, and what could not be included says why`<br>`books.spec.mjs › 결산` | SQL, 브라우저 | ✅ |
| 대손 추정은 실적률로만 나온다 | `books.test.mjs › a bad-debt estimate appears only with evidence, at the rate of the decree, net of the allowance` | SQL | ✅ |
| 손익을 옮겨도 그해 손익은 그대로다 | `books.test.mjs › the close moves profit to equity, and what the year earned still reads the same`<br>`books.spec.mjs › 재무제표` | SQL, 브라우저 | ✅ |
| 결산하지 않은 지난 해 손익이 함께 옮겨진다 | `books.test.mjs › a year never closed comes along with the next one, and the statement still says what each year earned`<br>`books.spec.mjs › 결산` | SQL, 브라우저 | ✅ |
| 뒤의 해가 결산되어 있으면 앞의 해를 바꿀 수 없다 | `books.test.mjs › a year closed later has to be taken back first; a year still open comes along` | SQL | ✅ |
| 잠그면 결산도 취소도 되돌리기도 막힌다 | `books.test.mjs › the lock holds: no close, no taking back inside a closed period, and the rollback is blocked too`<br>`books.spec.mjs › 잠그면` | SQL, 브라우저 | ✅ |
| 업그레이드해도 시산표가 같다 | `books.test.mjs › upgrading adds accounts and moves no balance, and takes the next code when one is in use` | SQL | ✅ |
| 설치 SQL 을 다시 실행해도 숫자가 같다 | `books.test.mjs › running the install script again on a company with entries changes no figure` | SQL | ✅ |
| 새 회사에는 계정과 제조원가 그룹이 있다 | `books.test.mjs › a new company has the accounts and the manufacturing group` | SQL | ✅ |
