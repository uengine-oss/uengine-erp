# E2E — erp-master

새 회사의 기본 데이터, 재설치 뒤 데이터 유지, 역할별 쓰기, 입력 값 검사, 단위 환산, 연락처 합치기와 중복 찾기, 제품·변형·콤보·공급사 줄, 가격 규칙과 세금·할부 계산을 실제 Postgres 위에서 명령을 보내 확인하고, 기초데이터 화면의 입력과 오류 표시를 실제 브라우저에서 확인한다. 가격·세금·할부의 경계값은 사례 파일을 돌려 정확한 숫자로 비교한다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/master.test.mjs test/pricing.test.mjs test/sales.test.mjs
source scripts/local-env.sh && npm run test:e2e -- master.spec.mjs meta.spec.mjs growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321)

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 새 회사에 세금·결제 조건·창고·가격표가 준비되어 있다 | `master.test.mjs › a new company starts with usable master data`<br>`master.test.mjs › seeding a company takes well under the API statement limit`<br>`pricing.test.mjs › the default pricelist is seeded once and gives list price` | SQL | ✅ |
| 기초데이터 메뉴에서 시드 세금과 계정과목을 본다 | `master.spec.mjs › 기초데이터 메뉴와 시드가 나타난다`<br>`meta.spec.mjs › 카탈로그에 있는 유형이 메뉴에 나타나고, 없는 유형은 숨는다`<br>`growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다` | 브라우저 | ✅ |
| 기본 데이터를 다시 넣어도 바꾼 이름이 돌아오지 않는다 | `master.test.mjs › seeding again creates nothing, and does not bring back what a user changed`<br>`pricing.test.mjs › the default pricelist is seeded once and gives list price` | SQL | ◐ |
| 설치 스크립트를 다시 실행해도 데이터가 그대로다 | `master.test.mjs › running the install script again changes no data` | SQL | ✅ |
| 역할에 없는 쓰기는 거부되고 역할에 맞는 쓰기는 통과한다 | `master.test.mjs › roles decide who can write each master type, and every member can read`<br>`pricing.test.mjs › only sales roles write pricelists` | SQL | ✅ |
| 구성원은 모두 읽고 회사 밖에서는 변형을 볼 수 없다 | `master.test.mjs › roles decide who can write each master type, and every member can read`<br>`master.test.mjs › variants are closed to anyone outside the company` | SQL | ✅ |
| 형식이 틀린 값은 업무 오류로 거부된다 | `master.test.mjs › malformed values get a business error, not a raw database error`<br>`master.test.mjs › create cannot overwrite an existing record through a chosen id` | SQL | ✅ |
| 카탈로그에 없는 항목과 줄 칸은 저장되지 않는다 | `master.test.mjs › fields and nested columns outside the catalog are not stored` | SQL | ✅ |
| 단위는 같은 분류 안에서 배수로 환산하고 대상 단위에 맞춰 반올림한다 | `master.test.mjs › uom conversion uses ratios, rounds half up at the target unit, and refuses other categories` | SQL | ✅ |
| 상위 순환과 코드 겹침과 잘못된 재고 위치는 거부된다 | `master.test.mjs › parents cannot form a cycle`<br>`master.test.mjs › account codes are unique and accounts reject unknown types`<br>`master.test.mjs › a warehouse keeps its stock in an internal location and has a unique code` | SQL | ✅ |
| 새 세금은 회사 설정을 따르되 직접 밝히면 그 값을 쓴다 | `pricing.test.mjs › a new tax follows the company choice unless it says otherwise` | SQL | ✅ |
| 세금 그룹은 하위 세금으로 풀리고 줄에는 그룹이 남는다 | `pricing.test.mjs › a tax group stands for its children, and a tax reached twice counts once` | SQL | ✅ |
| 계산 순서와 기준 포함이 세액을 정한다 | `pricing.test.mjs › case: 기준 포함: 고정 100 이 뒤 세금의 기준에 더해진다`<br>`pricing.test.mjs › case: 기준 포함: 포함 세금도 뒤 세금의 기준에 더해진다`<br>`pricing.test.mjs › case: 기준 영향을 끄면 앞 세금을 기준에 넣지 않는다`<br>`pricing.test.mjs › case: 계산 순서는 입력 순서가 아니라 먼저 만든 세금부터`<br>`pricing.test.mjs › case: 계산 순서 값이 먼저다` | SQL | ✅ |
| 별도 세금은 할인 뒤 줄 합계에 매기고 고정 금액 세금은 수량을 곱한다 | `pricing.test.mjs › seeded taxes compute as a Korean invoice expects`<br>`pricing.test.mjs › price and tax errors are business errors`<br>`pricing.test.mjs › case: 할인 뒤 금액에 세금`<br>`pricing.test.mjs › case: 복수 별도 세금은 서로 곱해지지 않는다`<br>`pricing.test.mjs › case: 고정 금액 세금은 수량을 곱한다`<br>`pricing.test.mjs › case: 고정 금액 세금은 할인에 영향받지 않는다` | SQL | ✅ |
| 포함 세금은 줄 합계에서 빠지고 여럿이면 한 번에 나눈다 | `pricing.test.mjs › case: 포함 10%: 단가에서 뺀다`<br>`pricing.test.mjs › case: 포함 10%: 나누어떨어지지 않아도 합계는 단가 그대로`<br>`pricing.test.mjs › case: 복수 포함 세금은 한 번에 나눈다`<br>`pricing.test.mjs › case: 복수 포함 세금: 세금을 각각 반올림하고 남는 금액이 공급가액`<br>`pricing.test.mjs › case: 포함 + 별도 혼합: 별도 세금은 뺀 뒤 금액에`<br>`pricing.test.mjs › case: 포함 고정 + 포함 비율: 고정 금액을 먼저 뺀다`<br>`pricing.test.mjs › case: 포함 고정 금액 세금`<br>`pricing.test.mjs › case: 포함 고정 세금이 단가보다 크면 공급가액이 음수` | SQL | ✅ |
| 줄 합계를 먼저 반올림하고 반은 0 에서 멀어지는 쪽으로 간다 | `pricing.test.mjs › case: 줄 단위 반올림: 단가별이 아니라 줄 전체로`<br>`pricing.test.mjs › case: 반올림 경계: 0.5 는 올린다`<br>`pricing.test.mjs › case: 음수 수량은 대칭: 반올림도 0 에서 멀어지는 쪽`<br>`pricing.test.mjs › case: 별도 세금 기준은 반올림된 공급가액: 1.5 x 3` | SQL | ✅ |
| 나눗셈 세금은 세금 포함 금액에 대한 비율이다 | `pricing.test.mjs › case: 나눗셈 별도: 가격에 대한 비율이 세금`<br>`pricing.test.mjs › case: 나눗셈 포함`<br>`pricing.test.mjs › case: 나눗셈 둘은 나누는 수를 합친다`<br>`pricing.test.mjs › case: 나눗셈과 비율은 서로 독립`<br>`pricing.test.mjs › a tax group stands for its children, and a tax reached twice counts once` | SQL | ✅ |
| 세금 조정은 세금을 바꾸거나 빼거나 여럿으로 나눈다 | `master.test.mjs › fiscal position rows refer to taxes and report their changes`<br>`pricing.test.mjs › case: 세금 조정: 다른 세금으로 바꾼다`<br>`pricing.test.mjs › case: 세금 조정: 대상이 비면 세금을 뺀다`<br>`pricing.test.mjs › case: 세금 조정: 하나를 둘로, 대상이 아닌 세금은 그대로` | SQL | ✅ |
| 전부 포함 세금이면 조정이 단가도 바꾼다 | `pricing.test.mjs › case: 세금 조정: 포함 세금이 빠지면 고객 단가에서도 빠진다`<br>`pricing.test.mjs › case: 세금 조정: 포함 세금 제거, 나누어떨어지지 않는 단가`<br>`pricing.test.mjs › case: 세금 조정: 포함 세금이 다른 포함 세금으로 바뀌면 공급가액을 유지`<br>`pricing.test.mjs › case: 세금 조정: 포함 → 포함 + 반올림`<br>`pricing.test.mjs › case: 세금 조정 뒤 단가와 세금으로 다시 계산해도 같다` | SQL | ✅ |
| 별도 세금이 끼면 조정해도 단가는 그대로다 | `pricing.test.mjs › case: 세금 조정: 별도 세금이 섞여 있으면 단가를 건드리지 않는다`<br>`pricing.test.mjs › case: 세금 조정: 별도 → 포함은 단가를 올리지 않는다` | SQL | ✅ |
| 비율 합계가 100 이 아닌 결제 조건은 저장되지 않는다 | `master.test.mjs › payment term lines: percentages add up to exactly 100, and the term may have no lines at all`<br>`master.spec.mjs › 결제 조건의 규칙 위반은 서버 문구로 보여 주고 줄을 고치면 저장된다` | SQL, 브라우저 | ✅ |
| 조기 할인은 100% 한 줄에만 쓰고 기한 안에 낼 금액을 계산한다 | `master.test.mjs › early payment discount fits one 100% line and needs a positive rate and period`<br>`pricing.test.mjs › case: 할부: 조기 할인, 세금 포함 금액 기준`<br>`pricing.test.mjs › case: 할부: 조기 할인, 공급가액 기준` | SQL | ✅ |
| 비율 할부의 끝수는 마지막 비율 줄이 받아 합이 정확히 맞다 | `pricing.test.mjs › case: 할부: 30% 선금 + 70% 60일`<br>`pricing.test.mjs › case: 할부: 반올림 차이는 마지막 비율이 흡수`<br>`pricing.test.mjs › case: 할부: 끝수가 앞으로 올림되면 마지막이 작다`<br>`pricing.test.mjs › case: 할부: 비율은 총액 기준, 마지막 비율이 나머지`<br>`pricing.test.mjs › case: 할부: 마지막 비율 뒤의 고정 금액도 남긴다` | SQL | ✅ |
| 고정 금액이 합계보다 커도 음수 할부는 없고 환불은 부호를 유지한다 | `pricing.test.mjs › case: 할부: 고정 금액이 합계보다 커도 음수 할부는 없다`<br>`pricing.test.mjs › case: 할부: 끝수로 0원이 된 회차도 남고 기일을 정한다`<br>`pricing.test.mjs › case: 할부: 환불은 부호를 유지` | SQL | ✅ |
| 기일은 기준에 따라 월말과 지정일로 계산하고 조건이 없으면 청구일이다 | `pricing.test.mjs › case: 할부: 달을 넘기는 일수`<br>`pricing.test.mjs › case: 할부: 월말부터`<br>`pricing.test.mjs › case: 할부: 월말부터, 1월 31일`<br>`pricing.test.mjs › case: 할부: 다음 달 말부터`<br>`pricing.test.mjs › case: 할부: 다음 달 말부터, 1월 31일`<br>`pricing.test.mjs › case: 할부: 일수 뒤 월말의 다음 달 10일`<br>`pricing.test.mjs › case: 할부: 일수 뒤 월말의 다음 달 10일, 1월 31일`<br>`pricing.test.mjs › case: 할부: 지정일 0 은 그 월말`<br>`pricing.test.mjs › case: 할부: 지정일 31`<br>`pricing.test.mjs › case: 할부: 결제 조건이 없으면 청구일 한 줄`<br>`pricing.test.mjs › case: 할부: 줄 없는 결제 조건도 청구일 한 줄` | SQL | ✅ |
| 지정일이 그 달보다 크면 그 달 말일이다 | ✗ | — | ✗ |
| 저장하기 전에 아무 금액과 날짜로 할부를 미리 본다 | `pricing.test.mjs › a payment term can be tried on any amount before it is saved` | SQL | ✅ |
| 여러 값 속성은 변형을 만들 수 없고 제품에 쓰인 방식과 값은 바꿀 수 없다 | `master.test.mjs › attribute rules: multi only without variants, unique value names`<br>`master.test.mjs › an attribute in use keeps its variant mode and its used values` | SQL | ✅ |
| 화면에서 연락처를 만들고 태그·담당자·결제 조건을 고른다 | `master.spec.mjs › 연락처를 만들고 태그·담당자·결제 조건을 고른다`<br>`master.test.mjs › partner fields round trip, and merged_into and active cannot be written directly` | SQL, 브라우저 | ✅ |
| 연락처를 합치면 대상 값이 이기고 빈칸·태그·하위 연락처·공급사 줄이 옮겨진다 | `master.spec.mjs › 연락처 합치기는 대상을 묻고 위험 동작으로 확인한다`<br>`master.test.mjs › partner merge: the target keeps its values, fills blanks, and takes over children and supplier prices` | SQL, 브라우저 | ✅ |
| 합쳐도 발행된 문서의 거래처는 그대로다 | ✗ | — | ✗ |
| 합쳐진 연락처는 고칠 수 없고 잘못된 합치기는 거부된다 | `master.test.mjs › partner merge: the target keeps its values, fills blanks, and takes over children and supplier prices` | SQL | ✅ |
| 고른 항목이 모두 같은 연락처를 묶어 보여 주고 빈 값은 맞지 않는다 | `master.test.mjs › contacts that may be the same can be listed; blank values never match` | SQL | ✅ |
| 제품을 저장하면 기본 변형과 회사 기본값이 붙는다 | `master.spec.mjs › 제품을 만들면 서버가 기본 변형을 만들고, 변형은 줄을 추가할 수 없다`<br>`master.test.mjs › a product without attributes has one default variant, and the defaults come from the company` | SQL, 브라우저 | ✅ |
| 제품 규칙 위반은 거부되고 재화만 재고를 추적한다 | `master.test.mjs › product rules: same uom category, services are not tracked, barcodes are unique, vendor dates in order`<br>`master.test.mjs › goods track stock unless switched off; services and combos never do`<br>`sales.test.mjs › S1: alone, sales runs from quote to order and both statuses say "does not apply"` | SQL | ✅ |
| 콤보는 선택 항목이 있어야 하고 제품이 겹치거나 콤보가 들어갈 수 없다 | `master.test.mjs › a combo needs at least one choice, each with its own distinct products, and no combo inside a combo` | SQL | ✅ |
| 공급사 줄은 입력한 대로 보관되고 변경은 자기 이벤트로 남는다 | `master.test.mjs › vendor rows are kept and reported by their own events`<br>`master.test.mjs › product rules: same uom category, services are not tracked, barcodes are unique, vendor dates in order` | SQL | ✅ |
| 즉시 방식은 모든 조합을 만들고 정가에 값의 추가 금액을 더한다 | `master.test.mjs › always: every combination at once, priced by the sum of its value extras` | SQL | ✅ |
| 값을 빼면 변형이 보관되고 돌아오면 같은 id 로 되살아난다 | `master.test.mjs › removing a value archives its variants; putting it back revives them with the same id`<br>`master.test.mjs › adding a value creates only the new combinations and keeps the old ids`<br>`master.test.mjs › adding attributes to a plain product: several values replace the default variant, one value extends it` | SQL | ✅ |
| 조합이 1000개를 넘으면 거부된다 | `master.test.mjs › a thousand combinations fit inside the API statement limit, and more is refused` | SQL | ✅ |
| 화면에서 속성 값과 변형을 목록으로 고른다 | `master.spec.mjs › 속성의 값은 속성을 고른 뒤에 선택지로 나타난다`<br>`master.spec.mjs › 가격표의 변형 참조는 변형 목록에서 고른다` | 브라우저 | ✅ |
| 주문할 때 방식은 처음 쓸 때 변형을 하나만 만든다 | `master.test.mjs › dynamic: no variant until first use, then exactly one for each combination`<br>`master.test.mjs › dynamic: simultaneous first uses create one variant`<br>`sales.test.mjs › variants: always, dynamic, and values that make no variant` | SQL | ✅ |
| 변형을 정할 수 없는 값 조합은 거부되고 보관된 변형은 되살아난다 | `master.test.mjs › dynamic: no variant until first use, then exactly one for each combination`<br>`master.test.mjs › variant ensure revives a variant a user archived by hand` | SQL | ✅ |
| 만들지 않음 방식은 변형을 늘리지 않고 변형 가격에도 넣지 않는다 | `master.test.mjs › no_variant: attributes do not multiply variants and do not take part in identity` | SQL | ✅ |
| 변형 줄에서는 SKU·바코드·원가·사용 여부만 고칠 수 있다 | `master.test.mjs › variant rows: only sku, barcode, cost and active can be edited, and rows cannot be added` | SQL | ✅ |
| 없는 변형, 겹치는 바코드, 틀린 속성 줄은 거부된다 | `master.test.mjs › variant rows: only sku, barcode, cost and active can be edited, and rows cannot be added`<br>`master.test.mjs › simultaneous saves cannot put one barcode on two variants` | SQL | ✅ |
| 제품과 값 이름을 바꾸면 변형 이름이 따라간다 | `master.test.mjs › renames flow into variant names, including through an attribute value` | SQL | ✅ |
| 보관·삭제는 변형에 닿고 쓰이는 제품과 세금은 지울 수 없다 | `master.test.mjs › archive and delete reach the derived table; a referenced product cannot be deleted` | SQL | ✅ |
| 되돌리기로 제품에서 빠진 변형은 찾을 수 없고 바코드를 놓는다 | `master.test.mjs › a rollback that takes variants out of the state leaves them inactive and unresolvable` | SQL | ◐ |
| 줄 전체를 보내도 바뀐 줄만 이벤트로 남는다 | `master.test.mjs › saving a whole collection records only the rows that changed`<br>`pricing.test.mjs › saving rules records only what changed` | SQL | ✅ |
| 잘못된 가격 규칙과 자기 자신으로 돌아오는 기준은 저장되지 않는다 | `pricing.test.mjs › rules are checked when saved`<br>`pricing.test.mjs › a pricelist cannot end up based on itself, directly or through others` | SQL | ✅ |
| 구체적인 대상이 먼저이고 그다음 기준 수량, 가까운 분류, 나중에 넣은 규칙 순이다 | `pricing.test.mjs › case: 대상 우선순위: 변형이 제품·분류·전체를 이긴다 (순서가 뒤에 있어도)`<br>`pricing.test.mjs › case: 변형 규칙은 다른 변형에 적용되지 않는다`<br>`pricing.test.mjs › case: 구체적인 대상이 수량보다 먼저: 분류 규칙이 수량 큰 전체 규칙을 이긴다`<br>`pricing.test.mjs › case: 같은 대상이면 기준 수량이 큰 쪽`<br>`pricing.test.mjs › case: 분류는 가까운 쪽이 먼저`<br>`pricing.test.mjs › case: 분류끼리는 기준 수량이 먼저: 상위 분류의 큰 수량 규칙이 하위 분류를 이긴다`<br>`pricing.test.mjs › case: 분류끼리 수량에 못 미치면 하위 분류`<br>`pricing.test.mjs › case: 모든 조건이 같으면 나중에 넣은 규칙`<br>`pricing.test.mjs › case: 규칙이 없으면 정가`<br>`pricing.test.mjs › case: 가격표가 없으면 정가` | SQL | ✅ |
| 규칙 기간은 날짜 단위로 시작일과 종료일을 포함한다 | `pricing.test.mjs › case: 시작일 당일은 적용`<br>`pricing.test.mjs › case: 시작일 전날은 적용되지 않음`<br>`pricing.test.mjs › case: 종료일 당일도 적용`<br>`pricing.test.mjs › case: 종료일 다음 날은 적용되지 않음`<br>`pricing.test.mjs › case: 기간이 끝난 구체적 규칙은 덜 구체적인 규칙으로 넘어간다` | SQL | ✅ |
| 할인은 단가를 두고 할인율을 보여 주고 고정 가격은 단가에 녹는다 | `pricing.test.mjs › case: discount 는 단가를 두고 할인율을 보여 준다`<br>`pricing.test.mjs › case: 할인 100%`<br>`pricing.test.mjs › case: 고정 가격은 추가 금액을 더하지 않는다` | SQL | ✅ |
| 계산식은 할인 → 반올림 → 추가금 → 마진 한도 순서다 | `pricing.test.mjs › case: 계산식 순서: 할인 → 반올림 → 추가금`<br>`pricing.test.mjs › case: 계산식 반올림 경계: 반은 올린다`<br>`pricing.test.mjs › case: 계산식은 할인을 단가에 녹인다`<br>`pricing.test.mjs › case: 계산식 원가 기준 + 최소 마진`<br>`pricing.test.mjs › case: 계산식 원가 기준 + 최대 마진`<br>`pricing.test.mjs › case: 계산식 판매가 기준: 마진의 기준은 할인 전 기준 가격`<br>`pricing.test.mjs › case: 소수 통화: 0.99 로 끝나게 만드는 계산식` | SQL | ✅ |
| 다른 가격표를 기준으로 삼으면 그 가격표의 할인까지 뺀 값에서 시작한다 | `pricing.test.mjs › case: 다른 가격표 기준: 기준 가격표의 할인까지 뺀 값에서 시작한다`<br>`pricing.test.mjs › case: 다른 가격표 기준 + 할인 표시`<br>`pricing.test.mjs › case: 기준 가격표에 맞는 규칙이 없으면 정가에서 시작` | SQL | ✅ |
| 요청 단위로 바꿔 계산하고 기준 수량은 제품 단위로 잰다 | `pricing.test.mjs › case: 기준 수량은 제품 단위로 잰다: 1다스는 12개`<br>`pricing.test.mjs › case: 기준 수량은 제품 단위로: 13개 기준은 1다스에 안 맞는다`<br>`pricing.test.mjs › case: 기준 수량 경계: 정확히 같으면 적용`<br>`pricing.test.mjs › case: 기준 수량 경계: 하나 모자라면 아래 규칙`<br>`pricing.test.mjs › case: 고정 가격도 단위를 따른다`<br>`pricing.test.mjs › case: 계산식은 다스 단가로 계산하고 추가금도 다스로 바꾼다`<br>`pricing.test.mjs › case: 제품 단위보다 작은 단위는 자릿수를 남긴다`<br>`pricing.test.mjs › case: 제품 단위보다 작은 단위의 계산식` | SQL | ✅ |
| 입력한 가격은 통화 자릿수로 잘리지 않고 줄 금액만 반올림한다 | `master.test.mjs › prices keep what was typed, money that is an amount rounds to the company currency`<br>`pricing.test.mjs › prices keep every digit that was typed, in a whole-won company too`<br>`pricing.test.mjs › rules are checked when saved`<br>`pricing.test.mjs › case: 소수 통화: 계산식 단가는 통화 자릿수보다 길게 남는다` | SQL | ✅ |
| 가격 조회는 아무것도 쓰지 않고 날짜를 안 주면 업무 일자를 쓴다 | `pricing.test.mjs › prices are reads: they write nothing and use the business date by default` | SQL | ✅ |
| 가격 조회는 구성원만 할 수 있고 없는 대상은 업무 오류다 | `pricing.test.mjs › the public price function is for members only`<br>`pricing.test.mjs › price and tax errors are business errors` | SQL | ✅ |

일부만 확인한 시나리오:

- 기본 데이터를 다시 넣어도 바꾼 이름이 돌아오지 않는다: 시험은 이름을 바꾼 시드만 확인한다. 지운 시드가 다시 생기지 않는 것은 시험이 없다.
- 되돌리기로 제품에서 빠진 변형은 찾을 수 없고 바코드를 놓는다: 시험은 되돌리기 화면이나 명령을 거치지 않고 `Reverted` 이벤트를 직접 넣어 확인한다.

시험이 없는 두 시나리오(지정일이 그 달보다 큰 경우, 합친 뒤 발행 문서의 거래처)와 지운 시드는 코드를 읽고 임시 DB 에서 한 번 실행해 확인했을 뿐 회귀 시험에 들어 있지 않다.

## 사례 파일

`test/pricing-cases.json` 에 가격 47개, 세금 54개, 할부 28개, 모두 129개의 사례가 입력과 기대 숫자로 들어 있다. `pricing.test.mjs` 가 사례마다 `case: <이름>` 시험을 하나씩 돌린다. 스펙 시나리오에는 대표 사례만 옮겼고 나머지 경계값은 이 파일이 원본이다. 표에 적지 않은 사례도 같은 요구사항을 확인한다.

## 시나리오에 대응하지 않는 시험

- `master.test.mjs › every master type in the domain document has a catalog entry with the same fields`
- `master.test.mjs › the variants table can be rebuilt from the ledger`
- `master.test.mjs › the projection always equals a replay of the ledger`
- `pricing.test.mjs › there are enough decision cases, with unique names`
- `pricing.test.mjs › the pricelist catalog matches the domain document`
- `pricing.test.mjs › the projection always equals a replay of the ledger`
