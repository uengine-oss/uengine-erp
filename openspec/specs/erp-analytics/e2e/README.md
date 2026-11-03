# E2E — erp-analytics

모델의 세 상태, 원장을 읽는 공개 함수, 정답을 아는 가상 회사에서의 모델 결과, 예측 화면을 확인한다. SQL 시험과 브라우저 시험은 `docs/modules/events.md` 의 모양대로 이벤트를 직접 넣은 가상 회사를 쓰며, 브라우저 시험의 숫자는 화면이 모델의 말을 그대로 옮기는지만 본다. 여기 통과가 실제 회사의 정확도를 뜻하지 않는다. 측정 스크립트는 `experiments/whatif/s7.mjs`, `thresholds.mjs`, `cash.mjs`, `speed.mjs` 이고 결과는 같은 폴더의 `results-*.json`, 해설은 `docs/modules/analytics.md` 다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/models.test.mjs test/isolation.test.mjs test/growth.test.mjs
source scripts/local-env.sh && npm run test:e2e -- whatif.spec.mjs growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 첫 화면은 15개 모델을 세 상태로 보여 준다 | `whatif.spec.mjs › 첫 화면은 모델을 세 상태로 보여 주고, 각자 무엇을 기다리는지 말한다` | 브라우저 | ✅ |
| 어떤 모듈도 켜기 전에는 모두 잠겨 있다 | `models.test.mjs › nothing is open before any module is on` | SQL | ✅ |
| 판매만 켠 회사는 통계만 열리고 수요 예측은 근거를 기다린다 | `models.test.mjs › S1: with sales alone, the sales forecast is short of history and the corrected one is locked`<br>`growth.test.mjs › S1. a new company starts with sales alone`<br>`growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다`<br>`whatif.spec.mjs › 첫 화면은 모델을 세 상태로 보여 주고, 각자 무엇을 기다리는지 말한다` | SQL, 브라우저 | ✅ |
| 어떤 모듈 조합에서도 세 상태 중 하나로 답한다 | `isolation.test.mjs › modules [none] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing, accounting] work together with nothing stuck` | SQL | ✅ |
| 잠긴 모델은 원장을 읽지 않고 안내만 한다 | `whatif.spec.mjs › 잠긴 모델은 계산하지 않고 어떤 모듈을 켜면 되는지 안내한다` | 브라우저 | ✅ |
| 무엇이 얼마나 더 필요한지와 범위만 보여 준다 | `whatif.spec.mjs › 근거가 모자라면 숫자 대신 무엇이 얼마나 더 필요한지와 범위만 보여 준다` | 브라우저 | ✅ |
| 대체 사례가 없는 단종은 0~100% 범위로만 말한다 | `whatif.spec.mjs › 근거가 모자라면 숫자 대신 무엇이 얼마나 더 필요한지와 범위만 보여 준다`<br>`models.test.mjs › dropping a product with no cases gives only a 0 to 100% range, which holds the truth` | SQL, 브라우저 | ✅ |
| 근거 수에 닿으면 열리고 발주 계획은 더 많이 요구한다 | `models.test.mjs › evidence thresholds for quotes, receipts, payments and journal months` | SQL | ✅ |
| 재고 이력이 길어도 판매 한 시즌을 보기 전에는 수요 예측이 열리지 않는다 | `models.test.mjs › a young company: stock history alone does not open what needs a season of sales` | SQL | ✅ |
| 재고 이력이 모자라면 날수를 함께 말한다 | `models.test.mjs › module on and off comes from the ledger, and history stays usable after off (M8)` | SQL | ✅ |
| 발주 정책은 입고 기록이 있으면 필요한 이력이 줄어든다 | `models.test.mjs › module on and off comes from the ledger, and history stays usable after off (M8)`<br>`models.test.mjs › the thresholds in SQL match the ones the browser applies` | SQL | ✅ |
| 결제 조건은 조건이 바뀐 거래처가 있어야 답한다 | `models.test.mjs › evidence thresholds for quotes, receipts, payments and journal months`<br>`models.test.mjs › payments: open invoices count, forecast lands near the truth, and terms need a customer who changed` | SQL | ✅ |
| 회사 전체는 되어도 그 제품의 근거가 모자라면 그 답을 따른다 | `whatif.spec.mjs › 회사 전체는 되어도 그 제품·공급사의 근거가 모자라면 함수의 답을 따른다` | 브라우저 | ✅ |
| 수요 예측은 제품별 결과와 80% 구간, 근거를 보여 준다 | `whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | 브라우저 | ✅ |
| 품절 확률은 말한 만큼 맞는다 | `models.test.mjs › stockout dates: stated chances are about right`<br>`whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | SQL, 브라우저 | ✅ |
| 실측 납기는 미입고를 세고 공급사별로 나온다 | `models.test.mjs › lead time counts open orders, by vendor, and halving it cuts stockouts`<br>`whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | SQL, 브라우저 | ✅ |
| 발주 필요 예측은 날짜와 수량을 말한다 | `models.test.mjs › reorder plan names a date and a quantity and is locked behind receipts`<br>`whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | SQL, 브라우저 | ✅ |
| 입금 예측은 미입금 청구서를 세고 주별로 말한다 | `models.test.mjs › payments: open invoices count, forecast lands near the truth, and terms need a customer who changed`<br>`whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | SQL, 브라우저 | ✅ |
| 손익 전망은 전표를 읽고 앞으로 석 달을 말한다 | `models.test.mjs › profit outlook reads the journal, and a what-if carries over to it`<br>`whatif.spec.mjs › 예측은 결과와 80% 구간, 근거, 경고를 그대로 보여 준다` | SQL, 브라우저 | ✅ |
| 새 제품을 몇 년치 0 으로 읽지 않는다 | `models.test.mjs › a brand-new product is not read as years of zero demand` | SQL | ✅ |
| 예시 제품에 묶이지 않는다 | `models.test.mjs › nothing is tied to the sample products: other shapes of company work` | SQL | ✅ |
| 기준 대비 변화를 P10·P50·P90 으로 보여 준다 | `whatif.spec.mjs › what-if: 입력 폼에서 기준 대비 변화를 P10·P50·P90 으로 보여 주고, 원장은 그대로다`<br>`models.test.mjs › profit outlook reads the journal, and a what-if carries over to it` | SQL, 브라우저 | ✅ |
| 구간이 0 을 포함하면 숫자보다 먼저 구분할 수 없다고 말한다 | `whatif.spec.mjs › 구간이 0 을 포함하면 숫자보다 먼저 효과를 구분할 수 없다고 말한다`<br>`models.test.mjs › a band that includes zero says it cannot tell, in those words` | SQL, 브라우저 | ✅ |
| 창고 재배치는 대부분 구분할 수 없다고 말하고 같은 창고로는 못 옮긴다 | `whatif.spec.mjs › 구간이 0 을 포함하면 숫자보다 먼저 효과를 구분할 수 없다고 말한다`<br>`models.test.mjs › a band that includes zero says it cannot tell, in those words` | SQL, 브라우저 | ✅ |
| 발주를 늘리면 방향과 크기를 말한다 | `models.test.mjs › order more of the summer products: right size and direction once purchases are visible` | SQL | ✅ |
| 구매 기록이 없으면 기준 매출을 믿지 말라고 한다 | `whatif.spec.mjs › 구매 기록이 없는 단계에서는 기준 매출을 믿지 말라고 하고, 그 시점으로 계산한다`<br>`models.test.mjs › without purchase orders the model says its base level is only inferred` | SQL, 브라우저 | ✅ |
| 품절 사례가 많으면 단종의 대체율을 잰다 | `models.test.mjs › dropping a product with many cases measures the substitution, peak season or not`<br>`whatif.spec.mjs › 단종·납기·결제 조건도 같은 틀로 답하고, 납기와 대체율을 함께 보여 준다` | SQL, 브라우저 | ✅ |
| 납기를 줄이면 품절일이 줄어든다고 말한다 | `models.test.mjs › lead time counts open orders, by vendor, and halving it cuts stockouts`<br>`whatif.spec.mjs › 단종·납기·결제 조건도 같은 틀로 답하고, 납기와 대체율을 함께 보여 준다` | SQL, 브라우저 | ✅ |
| 결제 조건을 줄이면 입금이 늘어난다고 말한다 | `models.test.mjs › payments: open invoices count, forecast lands near the truth, and terms need a customer who changed`<br>`whatif.spec.mjs › 단종·납기·결제 조건도 같은 틀로 답하고, 납기와 대체율을 함께 보여 준다` | SQL, 브라우저 | ✅ |
| 주문이 기다리는 회사에는 잃은 매출이 과대하다고 경고한다 | `models.test.mjs › if orders keep coming while nothing is on the shelf, the result warns that lost sales are overstated` | SQL | ✅ |
| 음수 재고가 있으면 기초 재고를 의심하라고 경고한다 | `models.test.mjs › negative stock is pointed out, because it usually means opening stock was never entered` | SQL | ✅ |
| 최근을 재현하지 못하면 그렇다고 말한다 | `models.test.mjs › if the simulation cannot reproduce the recent past, the result says so` | SQL | ✅ |
| what-if 를 돌려도 원장은 그대로다 | `whatif.spec.mjs › what-if: 입력 폼에서 기준 대비 변화를 P10·P50·P90 으로 보여 주고, 원장은 그대로다` | 브라우저 | ✅ |
| 모듈을 꺼도 이력 모델은 계속 계산한다 | `models.test.mjs › module on and off comes from the ledger, and history stays usable after off (M8)` | SQL | ✅ |
| 모듈이 켜진 기간은 원장에서 읽는다 | `models.test.mjs › module on and off comes from the ledger, and history stays usable after off (M8)` | SQL | ✅ |
| 원장에서 읽은 값은 회사가 한 일과 칸마다 같다 | `models.test.mjs › what the SQL returns is exactly what the company did, as of any date` | SQL | ✅ |
| 고른 시점까지의 기록으로 계산하고 옮기면 다시 읽는다 | `whatif.spec.mjs › 구매 기록이 없는 단계에서는 기준 매출을 믿지 말라고 하고, 그 시점으로 계산한다`<br>`whatif.spec.mjs › 읽지 못하면 오류와 다시 시도를 보여 주고, 다른 시점으로 옮기면 다시 읽는다` | 브라우저 | ✅ |
| 판매 시계열은 변경·취소·재확정·되돌리기를 반영한다 | `models.test.mjs › sales rows net out changes, cancellations, re-confirmation and rollbacks` | SQL | ✅ |
| 소급 입력은 자기 업무일에 들어가고 묶음을 더하면 같다 | `models.test.mjs › a backdated line is in its own day, and batches add up to one big call` | SQL | ✅ |
| 수량은 제품 단위로 환산된다 | `models.test.mjs › units convert to the product unit` | SQL | ✅ |
| 재고 시계열은 창고로 올려 합치고 고객 위치를 뺀다 | `models.test.mjs › stock rows sum to what the kernel says, keep to stock locations and map to warehouses` | SQL | ✅ |
| 납기 시계열은 미입고 줄을 남기고 수량 변경과 반품을 읽는다 | `models.test.mjs › lead times keep open lines, follow qty changes, and read partial receipts and returns` | SQL | ✅ |
| 입금 시계열은 부분 입금과 대변 메모와 취소를 읽는다 | `models.test.mjs › payment delays read partial payments, refunds and undoing a payment` | SQL | ✅ |
| 전표 시계열은 손익 계정만 회계일로 묶는다 | `models.test.mjs › the journal gives income and expense with the right sign, and a rollback nets out` | SQL | ✅ |
| 회계를 늦게 켜도 전표 달은 회계일로 센다 | `models.test.mjs › books turned on late count months by accounting date, not by when they were rebuilt` | SQL | ✅ |
| 통계·전환율·재주문 규칙을 시점별로 읽는다 | `models.test.mjs › statistics, quote conversion and reorder rules` | SQL | ✅ |
| 통계는 지역·제품·기간으로 좁혀지고 없으면 빈 상태로 말한다 | `whatif.spec.mjs › 통계는 지역·제품·기간 매출을 SVG 로 그리고, 고르면 좁혀지고, 없으면 빈 상태로 말한다` | 브라우저 | ✅ |
| 견적 전환율은 근거가 모자라면 범위로만 말한다 | `whatif.spec.mjs › 견적 전환율은 근거가 모자라면 범위로만 말한다` | 브라우저 | ✅ |
| 권한이 없는 시계열은 비어 있고 모델은 잠긴다 | `models.test.mjs › row security holds: nobody sees numbers from documents they may not read` | SQL | ✅ |
| 권한이 없는 모델은 화면에서도 왜 잠겼는지 말한다 | `whatif.spec.mjs › 문서를 읽을 권한이 없는 역할에는 그 문서로 계산하는 모델이 잠긴다` | 브라우저 | ✅ |
| 계산은 별도 스레드에서 돌고 읽는 동안 진행을 보여 준다 | `whatif.spec.mjs › 계산은 별도 스레드에서 돌고, 읽는 동안 진행을 보여 주며 화면을 막지 않는다` | 브라우저 | ✅ |
| 읽지 못하면 오류와 다시 시도를 보여 준다 | `whatif.spec.mjs › 읽지 못하면 오류와 다시 시도를 보여 주고, 다른 시점으로 옮기면 다시 읽는다` | 브라우저 | ✅ |
| 큰 원장에서도 호출이 제한 안에 끝난다 | `models.test.mjs › each call stays well inside the 8 second limit at this size` | SQL | ✅ |
| 휴대폰 폭과 어두운 테마에서도 읽힌다 | `whatif.spec.mjs › 휴대폰 폭과 어두운 테마에서도 읽힌다` | 브라우저 | ✅ |
| 품절이 수요를 가리고 재고 이력이 되찾는다 | `models.test.mjs › S7: stockouts hide demand from sales alone; the stock history brings it back` | SQL | ✅ |
| 재고가 넉넉하면 재고 이력의 차이가 작다 | `models.test.mjs › with plenty of stock, stock history changes little` | SQL | ✅ |

- 「어떤 모듈 조합에서도 세 상태 중 하나로 답한다」: 32개 조합 시험 모두 같은 확인을 한다. 표에는 양 끝 둘만 적었다. 전체 목록은 `erp-modules` 에 있다.
- 「납기를 줄이면 품절일이 줄어든다고 말한다」, 「결제 조건을 줄이면 입금이 늘어난다고 말한다」 의 판정은 가상 회사에서 나온 결과이며 실제 회사에서 같은 방향을 보장하지 않는다.
- 「수요 예측은…」 의 화면 시험은 값의 크기를 보지 않는다. 표와 문구가 나오는지만 본다.

## 시나리오에 대응하지 않는 시험

- `models.test.mjs › the simulator matches the generator it was ported from`: 브라우저 시뮬레이터가 실험 코드와 같은 값을 내는지 비교한다.
- `isolation.test.mjs › analysis reads the ledger, not any module table`: 분석 소스의 정적 검사다.
