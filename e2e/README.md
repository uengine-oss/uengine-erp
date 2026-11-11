# 시험 안내

모든 시험은 실제 Postgres 또는 실제 Supabase 로컬 스택에 대고 돈다. 스펙별 시나리오와 시험의 대응은 `openspec/specs/<id>/e2e/README.md` 에 있고, 이 문서는 그 전체 지도다.

## 실행

```bash
# 저장소 루트에서. 로컬 Supabase 스택이 떠 있어야 한다
source scripts/local-env.sh

# SQL: 시험 파일마다 임시 DB 를 만들어 쓴다. postgres DB 는 건드리지 않는다
node scripts/build-sql.mjs && node --test --test-concurrency=4 test/*.test.mjs

# HTTP: 실제 게이트웨이·PostgREST·GoTrue·pg_cron. 파일마다 회사를 새로 만드므로 초기화하고 설치한 스택에서 하나씩 돌린다
node scripts/reset-local.mjs && node scripts/build-sql.mjs && node scripts/install-local.mjs <설치 코드>
SETUP_CODE=<설치 코드> node --test test/stack.e2e.mjs
node scripts/reset-local.mjs && node scripts/install-local.mjs <설치 코드>
SETUP_CODE=<설치 코드> node --test test/api.e2e.mjs

# 브라우저: 프로덕션 빌드를 :5301 에 띄워 Playwright 로 돈다. 시험 파일마다 로컬 스택의 postgres DB 를 초기화한다
npm run test:e2e
npx playwright test -c e2e/playwright.config.mjs --list   # 목록만
```

| 환경 변수 | 뜻 |
|---|---|
| `API_URL`, `ANON_KEY`, `PUBLISHABLE_KEY` | `scripts/local-env.sh` 가 로컬 스택에서 읽어 온다 |
| `ERP_TEST_PG` | SQL 시험이 쓸 Postgres. 기본값은 `postgres://postgres:postgres@127.0.0.1:56322/postgres` |
| `SETUP_CODE` | HTTP 시험이 회사를 만들 때 쓰는 설치 코드 |

`expense.spec.mjs` 와 `api.e2e.mjs` 는 실제 Storage API 에 파일을 올린다. `supabase/config.toml` 의 `[storage] enabled = true` 로 스택을 띄워야 한다. 브라우저 시험은 한 번에 하나만 돈다(`workers: 1`). 브라우저 시험과 `reset-local`·`install-local` 은 postgres DB 를 초기화하고 :5301 을 쓰므로, 같은 스택을 여러 작업이 함께 쓰면 `lockf /tmp/uengine-erp-e2e.lock <명령>` 으로 감싼다. SQL 시험은 임시 DB 를 쓰므로 잠금이 필요 없다.

## 테스트 카탈로그

표기: ✅ 덮음 · ◐ 일부 · ✗ 아직 없음(아래 「남은 공백」). 시험 칸은 그 요구사항의 시나리오에 대응하는 파일과 시험 수이고, 시험 이름은 각 스펙의 `e2e/README.md` 에 있다. 요구사항의 ✅ 는 시나리오가 모두 ✅ 라는 뜻이고, ◐ 나 ✗ 가 하나라도 섞이면 ◐ 다. 스펙이 정한 문장 가운데 시나리오 없이 요구사항 본문에만 있는 것은 이 표에 잡히지 않는다.

### 1. 원장과 커맨드 (spec `erp-ledger`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 업무 쓰기는 명령으로 들어와 원장에 이벤트를 남긴다 | `core.test.mjs` 2 | SQL | ✅ |
| 원장은 고칠 수 없고 명령 밖의 쓰기는 거부된다 | `core.test.mjs` 2<br>`concurrency.test.mjs` 2<br>`stack.e2e.mjs` 1 | SQL, HTTP | ✅ |
| 명령 하나는 트랜잭션 하나다 | `concurrency.test.mjs` 3 | SQL | ✅ |
| 동시 요청도 규칙을 넘지 못한다 | `concurrency.test.mjs` 3 | SQL | ✅ |
| 앞선 버전으로 저장하면 충돌로 거부한다 | `core.test.mjs` 1<br>`api.e2e.mjs` 1<br>`concurrency.test.mjs` 1<br>`meta.spec.mjs` 2 | SQL, HTTP, 브라우저 | ✅ |
| 재시도 키로 다시 보내도 한 번만 일어난다 | `bus.test.mjs` 1 | SQL | ◐ |
| 업무 문서는 모르는 필드를 거부한다 | `bus.test.mjs` 1 | SQL | ✅ |
| 오류는 코드와 상태로 구분할 수 있다 | `core.test.mjs` 2<br>`api.e2e.mjs` 1<br>`meta.spec.mjs` 2 | SQL, HTTP, 브라우저 | ✅ |
| 명령과 읽기는 역할을 따른다 | `core.test.mjs` 1<br>`concurrency.test.mjs` 1<br>`meta.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 원장과 이력을 화면에서 읽는다 | `ledger.spec.mjs` 3<br>`meta.spec.mjs` 2 | 브라우저 | ✅ |
| 현재 상태는 언제나 원장을 재생한 값과 같다 | `core.test.mjs` 1<br>`ledger.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 화면은 카탈로그를 따라 메뉴와 폼을 그린다 | `meta.spec.mjs` 10<br>`growth.spec.mjs` 1 | 브라우저 | ✅ |
| 목록은 찾고 정렬하고 내려받고 인쇄할 수 있다 | `meta.spec.mjs` 5 | 브라우저 | ◐ |
| 연결이 흔들려도 입력을 잃지 않는다 | `resilience.spec.mjs` 3<br>`demo.spec.mjs` 1 | 브라우저 | ✅ |
| 앱과 DB 의 버전이 어긋나면 쓰기를 멈춘다 | `bus.test.mjs` 1<br>`modules.spec.mjs` 3 | SQL, 브라우저 | ✅ |

### 2. 시간 여행·되돌리기·재구축 (spec `erp-history`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 문서를 과거 시점과 버전으로 읽는다 | `history.test.mjs` 2<br>`core.test.mjs` 1<br>`history.spec.mjs` 1<br>`meta.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 회사 전체를 고른 날짜로 본다 | `growth.test.mjs` 1<br>`history.spec.mjs` 7<br>`history.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 잘못한 작업을 미리 본 뒤 모듈을 넘어 되돌린다 | `growth.test.mjs` 1<br>`rollback.spec.mjs` 2<br>`history.test.mjs` 6 | SQL, 브라우저 | ◐ |
| 뒤따른 작업이 있으면 범위를 보여 주고 동의를 받는다 | `rollback.spec.mjs` 1<br>`growth.test.mjs` 1<br>`history.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 되돌리면 안 되는 일은 막거나 경고한다 | `history.test.mjs` 5<br>`growth.test.mjs` 1<br>`rollback.spec.mjs` 4 | SQL, 브라우저 | ✅ |
| 관리자만 되돌리고 구성원·설정은 대상이 아니다 | `history.test.mjs` 1<br>`rollback.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 문서를 고른 버전으로 되돌린다 | `history.test.mjs` 1<br>`rollback.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 회사 전체를 고른 시점으로 되돌린다 | `history.test.mjs` 2<br>`rollback.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 되돌리기 자체를 다시 되돌린다 | `history.test.mjs` 1<br>`rollback.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 다른 모듈로 전달된 일도 함께 되돌아간다 | `bus.test.mjs` 3 | SQL | ✅ |
| 파생 데이터는 원장에서 다시 만들 수 있다 | `history.test.mjs` 1 | SQL | ✅ |

### 3. 모듈과 이벤트 버스 (spec `erp-modules`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 새 회사는 판매만 켜진 채로 시작한다 | `growth.test.mjs` 1<br>`modules.spec.mjs` 4<br>`growth.spec.mjs` 1<br>`bus.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 모듈은 필요한 모듈을 문서에 적고, 없으면 켜지지 않는다 | `expense.test.mjs` 1<br>`timeoff.spec.mjs` 1<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 다른 모듈 없이 일할 수 없는 모듈은 그렇게 밝힌다 | `expense.test.mjs` 1<br>`expense.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 켜기 전에 무엇이 열리고 무엇을 다시 만들 수 없는지 알려 준다 | `modules.spec.mjs` 1<br>`growth.spec.mjs` 1<br>`accounting.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 켠 모듈은 그 뒤의 이벤트부터 받고 고른 만큼만 과거를 읽는다 | `modules.spec.mjs` 1<br>`bus.test.mjs` 5<br>`growth.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 유형은 카탈로그로 행 단위 읽기를 정할 수 있다 | `expense-privacy.test.mjs` 3 | SQL | ✅ |
| 모듈 사이의 통로는 원장 이벤트 하나다 | `growth.test.mjs` 1<br>`growth.spec.mjs` 1<br>`bus.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 여섯 모듈의 어떤 조합도 동작한다 | `isolation.test.mjs` 32 | SQL | ✅ |
| 구독자가 실패해도 다른 일은 멈추지 않는다 | `growth.test.mjs` 1<br>`modules.spec.mjs` 2<br>`bus.test.mjs` 3 | SQL, 브라우저 | ✅ |
| 전달은 재촉과 정기 실행으로 이어지고 순서를 지킨다 | `modules.spec.mjs` 2<br>`api.e2e.mjs` 1<br>`bus.test.mjs` 2 | SQL, HTTP, 브라우저 | ✅ |
| 끄면 막히되 데이터는 남고 다시 켤 때 밀린 일을 고른다 | `modules.spec.mjs` 1<br>`growth.spec.mjs` 1<br>`bus.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 다른 모듈의 이벤트로 일하는 모듈은 그 모듈이 켜져 있어야 켜진다 | `mrp.test.mjs` 3<br>`isolation.test.mjs` 1<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 플러그인은 SQL 한 파일로 붙고 떨어진다 | `plugin.test.mjs` 8<br>`growth.test.mjs` 1 | SQL | ✅ |
| 모듈과 버스 화면은 작은 화면과 어두운 테마에서도 읽힌다 | `modules.spec.mjs` 2 | 브라우저 | ✅ |

### 4. 기초데이터와 가격 (spec `erp-master`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 새 회사는 바로 쓸 수 있는 기본 데이터로 시작한다 | `master.test.mjs` 2<br>`pricing.test.mjs` 1<br>`master.spec.mjs` 1<br>`meta.spec.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재설치와 재시드는 쌓인 데이터를 바꾸지 않는다 | `master.test.mjs` 2<br>`pricing.test.mjs` 1 | SQL | ◐ |
| 기초데이터 쓰기는 유형마다 정해진 역할만 할 수 있고 읽기는 구성원 모두 할 수 있다 | `master.test.mjs` 2<br>`pricing.test.mjs` 1 | SQL | ✅ |
| 저장할 때 값의 형식과 참조를 검사한다 | `master.test.mjs` 3 | SQL | ✅ |
| 단위는 같은 분류 안에서 배수로 환산한다 | `master.test.mjs` 1 | SQL | ✅ |
| 분류·계정과목·창고·위치와 상위 관계는 어긋나지 않는다 | `master.test.mjs` 3 | SQL | ✅ |
| 세금은 포함 여부, 그룹, 계산 순서를 갖는다 | `pricing.test.mjs` 7 | SQL | ✅ |
| 세금 금액은 줄 단위로 계산한다 | `pricing.test.mjs` 23 | SQL | ✅ |
| 세금 조정은 세금을 바꾸고 전부 포함 세금일 때만 단가를 바꾼다 | `master.test.mjs` 1<br>`pricing.test.mjs` 10 | SQL | ✅ |
| 결제 조건은 저장할 때 줄 규칙을 지킨다 | `master.test.mjs` 2<br>`master.spec.mjs` 1<br>`pricing.test.mjs` 2 | SQL, 브라우저 | ✅ |
| 할부는 합이 정확히 맞고 음수 회차가 없다 | `pricing.test.mjs` 20 | SQL | ◐ |
| 제품 속성은 변형 방식과 쓰인 값을 지킨다 | `master.test.mjs` 2 | SQL | ✅ |
| 연락처는 회사와 개인을 담고 합침 상태는 직접 쓸 수 없다 | `master.spec.mjs` 1<br>`master.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 연락처는 합칠 수 있고 합칠 후보를 찾아 볼 수 있다 | `master.spec.mjs` 1<br>`master.test.mjs` 2 | SQL, 브라우저 | ◐ |
| 제품은 기본 변형과 회사 기본값을 갖고 규칙을 지킨다 | `master.spec.mjs` 1<br>`master.test.mjs` 3<br>`sales.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 콤보 제품과 공급사 줄은 제품에 함께 저장된다 | `master.test.mjs` 3 | SQL | ✅ |
| 즉시(`always`) 속성은 조합 전체를 변형으로 만든다 | `master.test.mjs` 5<br>`master.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 주문할 때(`dynamic`)와 만들지 않음(`no_variant`) 속성은 미리 변형을 만들지 않는다 | `master.test.mjs` 4<br>`sales.test.mjs` 1 | SQL | ✅ |
| 변형 줄은 정해진 칸만 고칠 수 있고 바코드는 겹치지 않는다 | `master.test.mjs` 3 | SQL | ✅ |
| 보관과 삭제는 변형에 닿고 쓰이는 레코드는 지울 수 없다 | `master.test.mjs` 2 | SQL | ◐ |
| 줄 전체를 보내도 원장에는 바뀐 줄만 남는다 | `master.test.mjs` 1<br>`pricing.test.mjs` 1 | SQL | ✅ |
| 가격 규칙은 저장할 때 검사한다 | `pricing.test.mjs` 2 | SQL | ✅ |
| 가격은 가격표 규칙에서 한 가지로 정해진다 | `pricing.test.mjs` 36 | SQL | ✅ |
| 입력한 가격은 그대로 저장하고 금액만 통화 자릿수로 반올림한다 | `master.test.mjs` 1<br>`pricing.test.mjs` 3 | SQL | ✅ |
| 가격 조회는 쓰기를 하지 않고 구성원에게만 열린다 | `pricing.test.mjs` 3 | SQL | ✅ |

### 5. 판매 (spec `erp-sales`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 판매 모듈만으로 견적에서 주문까지 끝난다 | `growth.spec.mjs` 1<br>`growth.test.mjs` 1<br>`sales.test.mjs` 2 | SQL, 브라우저 | ✅ |
| 견적은 번호와 합계·마진·예상 납품일을 스스로 계산한다 | `sales.test.mjs` 3 | SQL | ✅ |
| 견적·주문 목록은 실제 문서를 보여 준다 | `growth.spec.mjs` 1 | 브라우저 | ◐ |
| 고객을 고르면 그 조건이 함께 온다 | `sales.test.mjs` 2 | SQL | ✅ |
| 유효 기한은 기본값을 갖고 만료는 상태를 바꾸지 않는다 | `sales.test.mjs` 2 | SQL | ✅ |
| 견적 양식은 비운 값을 채운다 | `sales.test.mjs` 1 | SQL | ✅ |
| 단가는 가격표를 따르고 입력한 값은 입력한 대로 남는다 | `sales.test.mjs` 5 | SQL | ✅ |
| 다른 단위로 팔 수 있다 | `sales.test.mjs` 1 | SQL | ✅ |
| 줄은 변형을 쓴다 | `sales.test.mjs` 1 | SQL | ✅ |
| 콤보는 금액 없는 줄과 고른 항목 줄로 팔린다 | `sales.test.mjs` 1 | SQL | ✅ |
| 일괄 할인은 세 방식으로 주문 전체에 걸린다 | `sales.test.mjs` 4 | SQL | ◐ |
| 선택 제품은 합계 밖에 있다가 요청하면 줄이 된다 | `sales.test.mjs` 1 | SQL | ✅ |
| 미리보기는 저장할 값을 보여 주고 아무것도 저장하지 않는다 | `sales.test.mjs` 2 | SQL | ✅ |
| 복제는 과거 없는 새 견적을 만든다 | `sales.test.mjs` 1 | SQL | ✅ |
| 확정하면 고칠 수 있는 것이 줄어든다 | `sales.test.mjs` 4 | SQL | ✅ |
| 잠긴 주문은 약속한 값을 지킨다 | `sales.test.mjs` 1 | SQL | ✅ |
| 상태는 정해진 길로만 움직인다 | `sales.test.mjs` 1 | SQL | ✅ |
| 납품 상태는 전표 이벤트로만 움직인다 | `growth.test.mjs` 2<br>`growth.spec.mjs` 2<br>`sales.test.mjs` 2 | SQL, 브라우저 | ✅ |
| 전표가 추적하기 전까지 사람이 납품 수량을 적는다 | `sales.test.mjs` 2 | SQL | ✅ |
| 청구 수량과 상태는 청구서 이벤트로만 움직인다 | `sales.test.mjs` 5 | SQL | ✅ |
| 선금 청구서는 주문에 합계를 바꾸지 않는 줄로 남는다 | `sales.test.mjs` 3 | SQL | ✅ |
| 고객 포털은 토큰으로 그 견적 하나만 열고 내부 값을 돌려주지 않는다 | `sales.test.mjs` 5 | SQL | ◐ |
| 다른 모듈에 알리는 이벤트는 필요한 사실을 전부 싣는다 | `sales.test.mjs` 1 | SQL | ✅ |
| 같은 이벤트가 다시 와도 결과는 같다 | `sales.test.mjs` 2 | SQL | ✅ |
| 판매 역할만 쓰고 구성원은 모두 읽는다 | `sales.test.mjs` 1 | SQL | ✅ |

### 6. 재고 (spec `erp-inventory`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 재고를 켤 때 옛 주문을 가져오고 기초 재고를 넣을 수 있다 | `inventory.test.mjs` 2<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1<br>`purchase.test.mjs` 1<br>`modules.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 재고가 꺼져 있으면 명령과 항목이 막힌다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 판매 주문을 확정하면 출고 전표가 생긴다 | `inventory.test.mjs` 4<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 구매 주문을 확정하면 입고 전표가 생기고 주문의 변경을 따라간다 | `inventory.test.mjs` 1 | SQL | ✅ |
| 판매 주문이 바뀌면 열린 전표가 따라간다 | `inventory.test.mjs` 4 | SQL | ◐ |
| 구독 이벤트가 되풀이되거나 밀려도 전표는 누락·중복되지 않는다 | `inventory.test.mjs` 3<br>`growth.test.mjs` 1 | SQL | ✅ |
| 전표는 예약에 따라 상태가 바뀌고 출고 정책을 따른다 | `inventory.test.mjs` 3 | SQL | ✅ |
| 전표를 처리하면 재고가 움직이고 음수도 허용한다 | `inventory.test.mjs` 3<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 적게 처리하면 남은 수량을 정해야 한다 | `inventory.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 처리한 전표를 수량을 정해 반품할 수 있다 | `inventory.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재고 조정은 실사와 반영을 나누고 되돌릴 수 있다 | `inventory.test.mjs` 5 | SQL | ✅ |
| 폐기는 초안에서 시작해 처리할 때 재고를 줄인다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 로트·일련번호 제품은 번호로 입고하고 먼저 들어온 것부터 나간다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 재주문 규칙은 예측으로 주문 수량을 계산한다 | `inventory.test.mjs` 5 | SQL | ✅ |
| 자동 규칙은 정해진 때에만 바로 요청한다 | `inventory.test.mjs` 4 | SQL | ✅ |
| 보충 요청은 사람이 조절할 수 있고 구매로 이어진다 | `inventory.test.mjs` 2<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 원가는 분류의 방식에 따라 입고에서만 움직인다 | `inventory.test.mjs` 3 | SQL | ✅ |
| 재고는 주문 단위와 상관없이 제품 기준 단위로 센다 | `inventory.test.mjs` 1 | SQL | ✅ |
| 재고만 켠 회사도 수동 전표로 일한다 | `inventory.test.mjs` 3 | SQL | ✅ |
| 작업 유형이 번호, 백오더, 예약 시점을 정한다 | `inventory.test.mjs` 1 | SQL | ✅ |
| 스케줄러가 대기 전표를 예약하고 자동 규칙을 평가한다 | `inventory.test.mjs` 1 | SQL | ✅ |
| 구성원은 재고 현황, 예측, 개요, 이동 내역을 읽는다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 동시에 일해도 재고 수량과 원가가 정확하다 | `inventory.test.mjs` 5 | SQL | ✅ |
| 재고 합계는 원장과 일치하고 재설치로 잃지 않는다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 재고가 얽힌 되돌리기는 재고가 음수가 되면 거부한다 | `inventory.test.mjs` 2 | SQL | ✅ |
| 제조 이벤트를 듣고 자재를 줄이고 완제품을 늘린다 | `mrp.test.mjs` 6 | SQL | ✅ |
| 재주문 규칙은 구매가 아닌 보충 방식을 이벤트에 실어 보낸다 | `mrp.test.mjs` 2 | SQL | ✅ |

### 7. 구매 (spec `erp-purchase`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 견적 요청은 금액을 계산하되 확정 전에는 입고·청구 대상이 아니다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 초안의 줄은 바뀐 것만 기록하고 잘못된 입력은 거부한다 | `purchase.test.mjs` 1 | SQL | ◐ |
| 공급사 단가와 납기는 그 공급사의 유효한 줄에서 정한다 | `purchase.test.mjs` 2 | SQL | ◐ |
| 자동 단가는 수량을 따르고 직접 넣은 단가는 유지한다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 줄의 기본 단위는 구매 단위다 | `purchase.test.mjs` 1 | SQL | ◐ |
| 결제 조건·세금 조정·담당자는 문서를 만들 때 채운다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 한도 이상 주문은 관리자 승인을 기다린다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 확정된 주문은 입고와 청구가 따라갈 수 있는 변경만 받는다 | `purchase.test.mjs` 3 | SQL | ✅ |
| 재고가 켜져 있으면 확정 뒤 변경이 입고 전표로 이어진다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 잠긴 주문은 숫자와 취소를 막는다 | `purchase.test.mjs` 1 | SQL | ◐ |
| 공급사가 확인한 일시를 남긴다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 취소와 삭제는 입고와 청구를 넘지 못한다 | `purchase.test.mjs` 6 | SQL | ✅ |
| 전표가 없는 입고 수량은 직접 입력한다 | `purchase.test.mjs` 3<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 입고 상태는 전표 소식으로 정한다 | `purchase.test.mjs` 3 | SQL | ✅ |
| 입고 수량은 줄 단위로 환산하고 환불 반품만 뺀다 | `purchase.test.mjs` 2 | SQL | ✅ |
| 청구 대상 수량과 청구 상태는 청구 기준을 따른다 | `purchase.test.mjs` 3 | SQL | ✅ |
| 처음 산 공급사는 제품의 공급사 목록에 더한다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 재주문 요청은 요청으로 만든 초안에 모은다 | `purchase.test.mjs` 2<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 초안 수량은 재고 예측에 들어간다 | `purchase.test.mjs` 2 | SQL | ✅ |
| 재고 없이도 동작하고 재고를 나중에 켜도 옛 주문을 건드리지 않는다 | `isolation.test.mjs` 2<br>`purchase.test.mjs` 2 | SQL | ✅ |
| 확정을 되돌리면 입고 전표도 함께 되돌아간다 | `purchase.test.mjs` 2 | SQL | ◐ |
| 구매 문서는 구매·회계 역할과 관리자만 읽는다 | `purchase.test.mjs` 1 | SQL | ◐ |
| 구매 현황을 공개 조회로 돌려준다 | `purchase.test.mjs` 1 | SQL | ✅ |
| 구매가 꺼지면 명령이 막히고 문서는 남는다 | `purchase.test.mjs` 1<br>`isolation.test.mjs` 1<br>`growth.spec.mjs` 2 | SQL, 브라우저 | ◐ |

### 8. 청구 (spec `erp-invoicing`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 증빙 한 장을 한 번의 명령으로 게시하고 결제한다 | `voucher.test.mjs` 4<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 증빙유형이 세액과 공제의 기본값을 정한다 | `voucher.test.mjs` 3<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 같은 증빙은 두 번 게시되지 않는다 | `voucher.test.mjs` 2<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 게시 문서는 대변 메모 게시로 상쇄한다 | `voucher.test.mjs` 5<br>`isolation.test.mjs` 1<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재고는 이벤트를 구독해 움직인다 | `voucher.test.mjs` 3<br>`isolation.test.mjs` 1<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 증빙은 게시 뒤에도 적고 주문에서 온 문서도 같은 칸을 갖는다 | `voucher.test.mjs` 2<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 내려받은 파일이 전표 후보가 된다 | `voucher.test.mjs` 1<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 세금계산서를 인쇄하고 내보내되 발행하지 않는다 | `voucher.test.mjs` 1<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 청구서 초안은 줄마다 금액을 계산한다 | `invoicing.test.mjs` 4 | SQL | ✅ |
| 게시는 문서를 검사하고 할부와 만기일을 정한다 | `invoicing.test.mjs` 2 | SQL | ✅ |
| 번호는 게시할 때 붙고 빈 번호가 생기지 않는다 | `invoicing.test.mjs` 5 | SQL | ✅ |
| 초안 복귀와 취소는 맞물린 돈을 풀어 준다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 판매 주문에서 청구서를 만든다 | `invoicing.test.mjs` 5<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 공급사 청구서를 작성하고 구매 주문에서 만든다 | `invoicing.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 켤 때 정한 날짜 이후의 판매 주문만 청구 대상으로 본다 | `invoicing.test.mjs` 1 | SQL | ◐ |
| 판매 주문에 선금을 청구한다 | `invoicing.test.mjs` 4 | SQL | ✅ |
| 최종 청구는 남은 선금을 뺀다 | `invoicing.test.mjs` 5 | SQL | ✅ |
| 대변 메모로 정정하면 원 문서와 맞물린다 | `invoicing.test.mjs` 5 | SQL | ✅ |
| 미래 날짜의 대변 메모는 그날 자동으로 게시된다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 전액 정정은 대변 메모를 바로 게시하고 새 초안을 연다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 공급사 문서를 정정하고 차변 메모와 복사로 새 초안을 만든다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 입금은 맞춘 문서의 상태를 따른다 | `invoicing.test.mjs` 2<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 초과 입금은 미배분으로 남고 탈락은 문서를 끝내는 데만 쓴다 | `invoicing.test.mjs` 2 | SQL | ✅ |
| 여러 문서를 한 번에 입금한다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 입금 금액을 제안하고 기한 안의 조기 할인을 적용한다 | `invoicing.test.mjs` 2 | SQL | ✅ |
| 자동 맞춤은 기다리는 돈을 열린 문서에 맞춘다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 합쳐진 연락처는 같은 거래처로 본다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 거부 표시는 표시만 바꾸고 입금 취소가 돈을 되돌린다 | `invoicing.test.mjs` 2 | SQL | ✅ |
| 동시 입금은 같은 돈을 두 번 맞추지 않는다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 미수금과 미지급금을 만기별로 본다 | `invoicing.test.mjs` 1<br>`growth.spec.mjs` 1<br>`rebuild-gl.test.mjs` 1 | SQL, 브라우저 | ◐ |
| 게시한 문서는 되돌리지 않고 정정을 안내한다 | `invoicing.test.mjs` 1<br>`growth.test.mjs` 1<br>`rollback.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 쓰기는 회계 역할만 하고 읽는 범위는 역할로 갈린다 | `invoicing.test.mjs` 1 | SQL | ✅ |
| 다른 모듈 없이 동작하고 꺼지면 데이터만 남는다 | `invoicing.test.mjs` 3<br>`growth.test.mjs` 1<br>`isolation.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |

### 8-1. 세금 신고 (spec `erp-krtax`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 켜면 과거 이벤트로 다시 집계하고 처음부터 켠 것과 같다 | `krtax.test.mjs` 2 | SQL | ✅ |
| 전표의 증빙과 세금 구분이 신고서 칸을 정한다 | `krtax.test.mjs` 5<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 경계일은 회사 시간대의 달력으로 정한다 | `krtax.test.mjs` 1 | SQL | ✅ |
| 줄을 누르면 그 금액의 전표가 나온다 | `krtax.test.mjs` 2<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 합계표와 수령 명세를 낸다 | `krtax.test.mjs` 3<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 세액과 끝수는 근거를 밝히고 전표를 따른다 | `krtax.test.mjs` 1 | SQL | ✅ |
| 신고 마감은 값을 남기고 기간을 닫는다 | `krtax.test.mjs` 3<br>`krtax.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 신고 조회는 회계 역할만 한다 | `krtax.test.mjs` 1 | SQL | ✅ |
| 화면은 신고서를 보여 주고 전자신고를 하지 않는다 | `krtax.spec.mjs` 2 | 브라우저 | ✅ |

### 9. 회계 (spec `erp-accounting`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 고객 청구서와 대변 메모는 채권·매출·세금 전표가 된다 | `accounting.test.mjs` 2 | SQL | ✅ |
| 입금과 지급은 예금·현금과 채권·채무 전표가 된다 | `accounting.test.mjs` 2 | SQL | ✅ |
| 탈락 금액과 조기 할인은 정해진 계정에 잡힌다 | `accounting.test.mjs` 2 | SQL | ◐ |
| 세금은 세금별 계정으로 나뉘어 잡힌다 | `accounting.test.mjs` 2 | SQL | ✅ |
| 계정은 줄, 선금, 미착품, 제품 분류, 시드 순으로 고른다 | `accounting.test.mjs` 3 | SQL | ✅ |
| 선금은 최종 청구서가 비울 때까지 선수금에 있다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 공급사 청구서는 그때 재고 모듈이 켜져 있었을 때만 미착품을 쓴다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 입출고는 원가로 평가되어 위치에 따라 전표가 된다 | `accounting.test.mjs` 2 | SQL | ✅ |
| 실사 차이와 폐기는 재고자산감모손실로 잡힌다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 할부가 둘 이상이면 채권 줄을 할부별로 나눈다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 합이 맞지 않는 이벤트에서는 회계 구독만 멈춘다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 초안 복귀와 취소는 그 기간의 전표를 지운다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 자동 전표는 원본 작업과 함께 되돌아간다 | `accounting.test.mjs` 2<br>`rebuild-gl.test.mjs` 1 | SQL | ✅ |
| 수동 전표는 초안으로 쓰고 차대가 맞아야 게시된다 | `growth.spec.mjs` 1<br>`accounting.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 게시한 수동 전표는 역분개나 초안 복귀로 정정한다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 기초 잔액은 자기 구분을 가진 전표로 넣는다 | `accounting.test.mjs` 1 | SQL | ✅ |
| 자동 전표는 원본 문서에서만 정정한다 | `accounting.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 시산표와 계정별 원장은 업무 날짜로 맞아떨어진다 | `accounting.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 손익계산서와 재무상태표는 서로 맞는다 | `accounting.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 장부의 채권·채무는 청구가 말하는 미결과 같다 | `rebuild-gl.test.mjs` 1 | SQL | ✅ |
| 장부는 회계 역할과 관리자만 읽는다 | `accounting.test.mjs` 1<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 회계는 꺼져도 멈춘 자리를 기억하고 혼자서도 동작한다 | `accounting.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 장부는 원장에서 다시 만들 수 있고 재설치로 변하지 않는다 | `accounting.test.mjs` 2 | SQL | ✅ |
| 회계를 언제 켜도 같은 사실이면 같은 장부가 나온다 | `growth.test.mjs` 2<br>`growth.spec.mjs` 2<br>`rebuild-gl.test.mjs` 6 | SQL, 브라우저 | ✅ |
| 다시 만들 수 없는 것을 켜기 전에 알린다 | `accounting.test.mjs` 1<br>`growth.spec.mjs` 2<br>`bus.test.mjs` 1<br>`demo.test.mjs` 1 | SQL, 브라우저 | ◐ |
| 자산의 실행과 처분은 이벤트에 실린 대로 전표가 된다 | `assets.test.mjs` 1 | SQL | ✅ |
| 장부를 전기와 비교해 본다 | `books.test.mjs` 6<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재무제표는 양식의 칸대로 전기와 나란히 나온다 | `books.test.mjs` 2<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 제조원가명세서를 낸다 | `books.test.mjs` 2 | SQL | ✅ |
| 이익잉여금처분계산서는 다음 해의 처분 전표를 읽는다 | `books.test.mjs` 2<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 결산은 단계마다 전표를 보여 주고 되돌릴 수 있으며 잠금일과 맞물린다 | `books.test.mjs` 7<br>`books.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 새 계정은 있던 회사의 잔액을 움직이지 않는다 | `books.test.mjs` 3 | SQL | ✅ |

### 10. 통계·예측·what-if (spec `erp-analytics`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 모든 모델은 세 상태 중 하나로 보인다 | `whatif.spec.mjs` 1<br>`models.test.mjs` 2<br>`growth.test.mjs` 1<br>`growth.spec.mjs` 1<br>`isolation.test.mjs` 2 | SQL, 브라우저 | ✅ |
| 잠긴 모델은 계산하지 않고 어떤 모듈을 켤지 안내한다 | `whatif.spec.mjs` 1 | 브라우저 | ✅ |
| 근거가 모자라면 숫자 대신 필요한 것과 범위를 말한다 | `whatif.spec.mjs` 2<br>`models.test.mjs` 6 | SQL, 브라우저 | ✅ |
| 사용 가능한 모델은 결과와 80% 구간, 근거, 경고를 함께 보여 준다 | `whatif.spec.mjs` 1<br>`models.test.mjs` 7 | SQL, 브라우저 | ✅ |
| what-if 는 기준 대비 변화를 말하고 구간이 0 을 포함하면 구분할 수 없다고 말한다 | `whatif.spec.mjs` 4<br>`models.test.mjs` 10 | SQL, 브라우저 | ✅ |
| 분석은 원장을 바꾸지 않는다 | `whatif.spec.mjs` 1 | 브라우저 | ✅ |
| 분석은 원장만 읽어 모듈을 꺼도 이력을 쓸 수 있다 | `models.test.mjs` 2 | SQL | ✅ |
| 고른 시점까지의 기록으로 계산한다 | `whatif.spec.mjs` 2 | 브라우저 | ✅ |
| 공개 시계열은 일어난 일을 그대로 돌려준다 | `models.test.mjs` 9 | SQL | ✅ |
| 통계와 전환율 화면 | `whatif.spec.mjs` 2 | 브라우저 | ✅ |
| 읽을 수 없는 문서의 숫자는 주지 않는다 | `models.test.mjs` 1<br>`whatif.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 계산이 화면을 막지 않는다 | `whatif.spec.mjs` 3<br>`models.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 품절을 기록으로 알면 수요를 되찾는다 | `models.test.mjs` 2 | SQL | ✅ |

### 11. REST·MCP·연동 키·이벤트 피드 (spec `erp-integration`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 유형마다 REST 자원이 카탈로그에서 생긴다 | `api.test.mjs` 6<br>`api.e2e.mjs` 3 | SQL, HTTP | ✅ |
| MCP 는 도구 4개로 켜진 모듈의 레코드를 다룬다 | `api.e2e.mjs` 1<br>`api.test.mjs` 3<br>`growth.test.mjs` 1 | SQL, HTTP | ✅ |
| 에이전트의 실수를 같은 MCP 도구로 되돌린다 | `api.test.mjs` 4<br>`growth.test.mjs` 1<br>`api.e2e.mjs` 1 | SQL, HTTP | ✅ |
| 연동 키로 로그인 없이 구성원 권한으로 동작한다 | `api.test.mjs` 2<br>`api.e2e.mjs` 1<br>`integration.spec.mjs` 3 | SQL, HTTP, 브라우저 | ✅ |
| 외부 시스템은 이벤트 피드로 원장을 차례로 읽는다 | `bus.test.mjs` 1 | SQL | ◐ |

### 12. 설치·보안·데모 회사 (spec `erp-setup`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 앱은 접속 정보를 받되 비밀 키는 거부한다 | `setup.spec.mjs` 3 | 브라우저 | ✅ |
| 화면이 주는 SQL 로 설치하고 다시 실행해도 데이터는 그대로다 | `setup.spec.mjs` 1<br>`resilience.spec.mjs` 2<br>`stack.e2e.mjs` 2<br>`core.test.mjs` 1<br>`master.test.mjs` 1 | SQL, HTTP, 브라우저 | ✅ |
| 회사를 만들면 관리자가 메일 없이 바로 로그인한다 | `setup.spec.mjs` 1<br>`stack.e2e.mjs` 1 | HTTP, 브라우저 | ✅ |
| 구성원 계정은 관리자가 메일 없이 만든다 | `setup.spec.mjs` 3<br>`stack.e2e.mjs` 1<br>`core.test.mjs` 3 | SQL, HTTP, 브라우저 | ✅ |
| 공개 키만으로는 아무것도 읽거나 쓸 수 없다 | `core.test.mjs` 4<br>`stack.e2e.mjs` 2<br>`setup.spec.mjs` 1<br>`concurrency.test.mjs` 1 | SQL, HTTP, 브라우저 | ✅ |
| 앱은 어느 정적 경로에서나 제3자 없이 동작한다 | `pages.spec.mjs` 4 | 브라우저 | ✅ |
| 초대 링크로 접속 정보를 넘기고 접속을 해제할 수 있다 | `resilience.spec.mjs` 2<br>`setup.spec.mjs` 1 | 브라우저 | ✅ |
| 프로젝트가 멈추면 안내하고 살아나면 돌아온다 | `resilience.spec.mjs` 2 | 브라우저 | ✅ |
| 무료 플랜의 한도를 보여 주고 원장을 내려받게 한다 | `ledger.spec.mjs` 3 | 브라우저 | ◐ |
| 가상 회사로 시작할 수 있다 | `demo.spec.mjs` 5<br>`demo.test.mjs` 4 | SQL, 브라우저 | ✅ |

### 13. 인사 (spec `erp-hr`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 인사는 꺼진 채 시작하고 다른 모듈 없이 동작한다 | `hr.test.mjs` 1<br>`hr.spec.mjs` 1<br>`isolation.test.mjs` 7 | SQL, 브라우저 | ✅ |
| 직원과 부서는 hr 과 관리자만 쓰고, 이름과 부서는 모든 구성원이 읽는다 | `hr.test.mjs` 1<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 직원은 사번으로 구별되고 잘못된 값은 저장되지 않는다 | `hr.test.mjs` 2<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 상사는 순환할 수 없고 퇴사자일 수 없다 | `hr.test.mjs` 2<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 퇴사는 삭제가 아니라 상태 변경이다 | `hr.test.mjs` 4<br>`hr.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 구성원 하나는 재직 직원 하나에만 연결된다 | `hr.test.mjs` 1 | SQL | ✅ |
| 부서 이름은 유일하고 사람이 있는 부서는 보관할 수 없다 | `hr.test.mjs` 1<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 이벤트는 구독자에게 필요한 사실을 싣고 그 밖은 싣지 않는다 | `hr.test.mjs` 2<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 어느 날의 인원은 입퇴사일로 세고 무엇을 알던 때인지도 고른다 | `hr.test.mjs` 6<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 인원 통계는 세 상태로 보인다 | `hr.test.mjs` 1<br>`hr.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 되돌리기는 인원에도 반영되고 원장 밖의 값은 돌아오지 않는다 | `hr.test.mjs` 2<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 나중에 켜고 꺼도 이력과 인원이 남는다 | `hr.test.mjs` 2<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 개인정보는 원장 밖에 두고 값은 어떤 이벤트에도 들어가지 않는다 | `hr.test.mjs` 5<br>`hr.spec.mjs` 1<br>`api.e2e.mjs` 1 | SQL, HTTP, 브라우저 | ✅ |
| 주민등록번호는 받지 않는다 | `hr.test.mjs` 1<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 개인정보는 지울 수 있고 지운 값은 어디에도 남지 않는다 | `hr.test.mjs` 4<br>`hr.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 시간 여행과 연동의 어떤 길로도 개인정보가 나오지 않는다 | `hr.test.mjs` 3<br>`api.e2e.mjs` 1 | SQL, HTTP | ✅ |
| REST 와 MCP 는 카탈로그에서 저절로 나온다 | `hr.test.mjs` 3<br>`api.e2e.mjs` 1 | SQL, HTTP | ✅ |
| 가상 회사에 직원이 더해져도 다른 수치는 그대로다 | `hr.test.mjs` 3 | SQL | ✅ |

### 14. 급여 (spec `erp-payroll`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 급여는 꺼진 채 시작하고 인사가 있어야 켠다 | `payroll.test.mjs` 2<br>`payroll.spec.mjs` 2<br>`isolation.test.mjs` 7 | SQL, 브라우저 | ✅ |
| 요율과 세액표는 제품에 없고 회사가 출처와 함께 넣는다 | `payroll.test.mjs` 3<br>`payroll.spec.mjs` 3 | SQL, 브라우저 | ✅ |
| 금액은 손으로 계산한 값과 같다 | `payroll.test.mjs` 4<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 근거 없는 계산은 하지 않고 사람이 입력한다 | `payroll.test.mjs` 3<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 사람이 고친 칸은 표시되고 남는다 | `payroll.test.mjs` 2<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 확정한 급여는 자료가 바뀌어도 움직이지 않는다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 한 사람의 금액은 원장에 들어가지 않는다 | `payroll.test.mjs` 2 | SQL | ✅ |
| 직원은 자기 명세서만 본다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 주민등록번호는 받지 않는다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 급여 정보와 명세서는 지울 수 있다 | `payroll.test.mjs` 3 | SQL | ✅ |
| 전표는 이벤트만으로 만들고 나중에 켜도 같다 | `payroll.test.mjs` 4<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 앱은 돈을 옮기지 않고 이체 파일을 내려준다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 확정한 대장은 정정 대장으로 바로잡는다 | `payroll.test.mjs` 3<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 사가는 초안을 취소하고 확정을 상쇄한다 | `payroll.test.mjs` 3 | SQL | ✅ |
| 원천세는 지급 월로 귀속 월별로 집계한다 | `payroll.test.mjs` 2<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 마감하면 그 달의 대장이 잠기고 해제는 흔적을 남긴다 | `payroll.test.mjs` 2<br>`payroll.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 입퇴사로 4대보험 목록을 내려받는다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 인건비 전망은 세 상태로 보이고 원장만 읽는다 | `payroll.test.mjs` 1<br>`payroll.spec.mjs` 3 | SQL, 브라우저 | ✅ |
| 끄고 켜도 남고, 구독자가 고장 나도 발행자는 멈추지 않는다 | `payroll.test.mjs` 2 | SQL | ✅ |
### 15. 제조 (spec `erp-mrp`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 제조는 꺼진 채 시작하고 재고가 있어야 켜진다 | `mrp.test.mjs` 3<br>`isolation.test.mjs` 7<br>`mrp.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 모듈 경계를 정적으로 지킨다 | `isolation.test.mjs` 4 | SQL | ✅ |
| 자재 명세는 완제품과 자재와 수량을 담고 잘못된 것은 받지 않는다 | `mrp.test.mjs` 4<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 순환하는 자재 명세를 막는다 | `mrp.test.mjs` 2<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 다단계는 읽을 때 펼치고 각 단계는 자기 지시로 만든다 | `mrp.test.mjs` 1 | SQL | ◐ |
| 제조 지시는 자재를 계산하고 상태를 한 방향으로 간다 | `mrp.test.mjs` 6<br>`mrp.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 자재가 부족해도 막지 않고 먼저 보여 준다 | `mrp.test.mjs` 2<br>`mrp.spec.mjs` 3 | SQL, 브라우저 | ✅ |
| 실제가 계획과 다르면 명세가 정한 대로 한다 | `mrp.test.mjs` 2<br>`mrp.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 완료하면 재고 모듈이 듣고 자재를 줄이고 완제품을 늘린다 | `mrp.test.mjs` 3<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재고가 멈추거나 꺼져도 제조 기록은 남고 고치면 이어 간다 | `mrp.test.mjs` 2<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재주문 규칙이 제조로 이어지고 계획이 예측에 들어간다 | `mrp.test.mjs` 6<br>`mrp.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 원가는 자재비로 정하고 재고 평가와 맞는다 | `mrp.test.mjs` 3<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 회계가 켜져 있으면 재공품을 거쳐 전표가 되고 늦게 켜도 같다 | `mrp.test.mjs` 5<br>`rebuild-gl.test.mjs` 1<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 되돌리면 재고도 돌아가고 팔렸으면 막는다 | `mrp.test.mjs` 4<br>`mrp.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 사가는 되돌리거나 실제 반품으로 상쇄한다 | `mrp.test.mjs` 4 | SQL | ✅ |
| MCP 로 명세와 지시를 다루고 권한을 지킨다 | `mrp.test.mjs` 3<br>`api.e2e.mjs` 1 | SQL, HTTP | ✅ |
| 제조 기간, 자재 소요, 생산량 변경은 세 상태로 보이고 원장만 읽는다 | `mrp.test.mjs` 7<br>`mrp.spec.mjs` 3 | SQL, 브라우저 | ✅ |
| 가상 회사에 제조가 더해져도 다른 수치는 그대로다 | `mrp.test.mjs` 2<br>`hr.test.mjs` 1 | SQL | ✅ |
### 16. 고정자산 (spec `erp-assets`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 자산을 등록하면 연도별 상각 계획이 정해진다 | `assets.test.mjs` 14<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 세법 기준이 허용하지 않는 입력은 이유와 함께 막는다 | `assets.test.mjs` 3<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 실행은 달까지의 금액을 잡고 전표를 먼저 보여 준다 | `assets.test.mjs` 5<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 처분은 그 전 달까지의 상각을 함께 잡고 손익을 먼저 보여 준다 | `assets.test.mjs` 4<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 취득 대금은 계정을 적었을 때만 전표가 된다 | `assets.test.mjs` 1 | SQL | ✅ |
| 되돌리면 자산과 전표가 함께 돌아간다 | `assets.test.mjs` 3<br>`books.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 닫은 기간은 실행도 처분도 되돌리기도 막는다 | `assets.test.mjs` 3<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 회계 없이도 동작하고 나중에 켠 회계는 같은 장부를 만든다 | `assets.test.mjs` 5<br>`isolation.test.mjs` 64 | SQL | ✅ |
| 회계 역할만 다룬다 | `assets.test.mjs` 1<br>`books.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 감가상각비 전망은 세 상태로 답한다 | `assets.test.mjs` 6<br>`books.spec.mjs` 2 | SQL, 브라우저 | ✅ |

### 시험 목록에 더해진 파일

`test/assets.test.mjs`, `test/books.test.mjs`, `e2e/tests/books.spec.mjs`. `books.spec.mjs` 는 모든 입력을 사람 속도(단계마다 1초)로 넣는 직렬 시험이라 하나만 따로 돌리지 않는다. 날짜에 기대는 한 시험(감가상각비 전망의 근거 부족)은 2027-01 부터 건너뛴다.
### 17. 휴가 (spec `erp-timeoff`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 휴가는 꺼진 채 시작하고 인사가 있어야 켜진다 | `timeoff.test.mjs` 1<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 켜면 재직 직원의 일수를 정책대로 계산하고 확인 못 한 것은 밝힌다 | `timeoff.test.mjs` 1<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 연차 일수는 근로기준법 제60조를 따른다 | `timeoff.test.mjs` 5 | SQL | ✅ |
| 출근율 80% 는 마감된 근태로만 판정한다 | `timeoff.test.mjs` 5 | SQL | ✅ |
| 회계연도 기준은 고용노동부 안내를 따르고 부족분을 밝힌다 | `timeoff.test.mjs` 3 | SQL | ✅ |
| 법보다 적게 주는 정책은 법 적용을 끄기 전에는 저장되지 않는다 | `timeoff.test.mjs` 1<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 구성원은 자기 일수를 보고 신청하고 주말과 공휴일은 빠진다 | `timeoff.test.mjs` 6<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 승인자는 상사이고 없으면 인사 담당자다 | `timeoff.test.mjs` 2<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 승인, 반려, 취소 | `timeoff.test.mjs` 3<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 사유는 원장에 남지 않고 본인, 상사, 인사 담당자만 읽는다 | `timeoff.test.mjs` 4<br>`isolation.test.mjs` 1<br>`timeoff.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 팀 달력에는 이름과 날짜만 나온다 | `timeoff.test.mjs` 1<br>`timeoff.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 되돌리면 잔여도 돌아오고 사유는 함께 돌아오지 않는다 | `timeoff.test.mjs` 3<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 에이전트의 신청도 같은 규칙을 지나고 사가로 돌아간다 | `timeoff.test.mjs` 3<br>`timeoff.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 소진 전망과 정책 what-if 는 원장만 읽는다 | `attendance.test.mjs` 1<br>`timeoff.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 근태 없이도 근태와 함께도 동작한다 | `isolation.test.mjs` 8 | SQL | ✅ |
| REST 와 MCP 는 카탈로그에서 저절로 나온다 | `timeoff.test.mjs` 2 | SQL | ✅ |
| 가상 회사에 휴가와 근태가 더해져도 다른 수치는 그대로다 | `attendance.test.mjs` 2<br>`hr.test.mjs` 1 | SQL | ✅ |

### 18. 근태 (spec `erp-attendance`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 근태는 꺼진 채 시작하고 인사가 있어야 켜지며 휴가는 필요 없다 | `attendance.test.mjs` 1<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 출퇴근은 본인이 서버 시각으로 찍는다 | `attendance.test.mjs` 2<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 정정은 사유가 필수이고 원래 값이 원장에 남는다 | `attendance.test.mjs` 1<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 본인은 자기 근태를 보고 남의 근태는 볼 수 없다 | `attendance.test.mjs` 1<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 주 52시간은 그 주 전체 근로시간으로 보고 끝나기 전에 알린다 | `attendance.test.mjs` 3<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 승인된 휴가 날은 결근이 아니다 | `attendance.test.mjs` 3<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 월 마감 뒤에는 고칠 수 없고 사실을 이벤트로 낸다 | `attendance.test.mjs` 2<br>`attendance.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 끄면 기록은 남고 다시 켜면 밀린 휴가를 받는다 | `attendance.test.mjs` 1 | SQL | ✅ |
| 위험과 추이는 원장만 읽는다 | `attendance.test.mjs` 1<br>`attendance.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 업무 수치를 흔들지 않고 어떤 조합에서도 동작한다 | `isolation.test.mjs` 8 | SQL | ✅ |

### 19. 경비 (spec `erp-expense`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 경비는 꺼진 채 시작하고 인사가 있어야 켠다 | `expense.test.mjs` 1<br>`expense.spec.mjs` 1<br>`isolation.test.mjs` 5 | SQL, 브라우저 | ✅ |
| 신청은 본인이나 담당자가 하고 승인은 상사나 관리자가 한다 | `expense.test.mjs` 3<br>`expense.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 금액과 날짜의 경계가 지켜진다 | `expense.test.mjs` 4 | SQL | ✅ |
| 신청에는 영수증이나 없는 사유가 있어야 한다 | `expense.test.mjs` 4<br>`expense.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 영수증은 관계된 사람만 열고 지우는 데 규칙이 있다 | `expense.test.mjs` 2<br>`expense.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 같은 날 같은 금액은 승인자에게 보인다 | `expense.test.mjs` 1 | SQL | ✅ |
| 이벤트는 구독자에게 필요한 사실을 싣는다 | `expense.test.mjs` 1 | SQL | ✅ |
| 회계가 켜져 있으면 전표가 생기고 나중에 켜도 같다 | `expense.test.mjs` 4<br>`expense.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 잠긴 기간은 승인, 지급, 취소를 막는다 | `expense.test.mjs` 1 | SQL | ✅ |
| 지급한 경비는 되돌리지 않고 보상한다 | `expense.test.mjs` 4<br>`expense-privacy.test.mjs` 1 | SQL | ✅ |
| MCP 는 구성원의 권한만큼만 한다 | `expense.test.mjs` 1 | SQL | ✅ |
| 부서별 경비 추이는 세 상태로 보이고 원장만 읽는다 | `expense.test.mjs` 1<br>`expense-privacy.test.mjs` 1<br>`expense.spec.mjs` 3 | SQL, 브라우저 | ✅ |
| 경비는 관계된 사람만 어떤 길로도 읽는다 | `expense-privacy.test.mjs` 5<br>`api.e2e.mjs` 1<br>`expense.spec.mjs` 2 | SQL, HTTP, 브라우저 | ✅ |
| 사람이 친 글은 원장에 없고 지울 수 있다 | `expense-privacy.test.mjs` 5<br>`expense.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 경비 유형은 회계 담당자가 다룬다 | `expense.test.mjs` 1 | SQL | ✅ |
| 가상 회사에 경비가 더해져도 판매와 재고 수치는 그대로다 | `expense.test.mjs` 2 | SQL | ✅ |

### 20. CRM (spec `erp-crm`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| CRM 은 꺼진 채 시작하고 다른 모듈 없이 동작한다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1<br>`isolation.test.mjs` 7 | SQL, 브라우저 | ✅ |
| 쓰기는 sales 와 관리자, 읽기는 모든 구성원이다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 단계는 넷이고 건너뛰거나 되돌릴 수 있다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 잘못된 값은 칸 이름으로 알려 주고 아무것도 남기지 않는다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 수주에는 거래처나 회사명이 있어야 하고 실주에는 사유가 있어야 한다 | `crm.test.mjs` 2<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 수주가 판매에서 견적 초안이 된다 | `crm.test.mjs` 5<br>`crm.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 담당자 연락처는 원장 밖에 두고 지울 수 있다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 되돌릴 수 없는 상태가 없으므로 사가는 되돌리기다 | `crm.test.mjs` 2 | SQL | ✅ |
| MCP 는 구성원의 권한만큼만 한다 | `crm.test.mjs` 1 | SQL | ✅ |
| 전환율은 근거가 찰 때까지 믿을 만하지 않다고 말한다 | `crm.test.mjs` 2<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 수주 전망은 근거가 모자라면 범위로만 말한다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 재구매 후보는 주문 이력을 세어 보여 준다 | `crm.test.mjs` 1<br>`crm.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 꺼도 이력과 전환율이 남는다 | `crm.test.mjs` 1 | SQL | ✅ |
| 가상 회사에 영업 기회가 더해져도 다른 수치는 그대로다 | `crm.test.mjs` 1 | SQL | ✅ |

### 21. 프로젝트 (spec `erp-project`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 프로젝트는 꺼진 채 시작하고 다른 모듈 없이 동작한다 | `project.test.mjs` 2<br>`project.spec.mjs` 3<br>`isolation.test.mjs` 5 | SQL, 브라우저 | ✅ |
| 시간은 작업의 스트림에 쓰지 않는다 | `project.test.mjs` 1 | SQL | ✅ |
| 담당자는 인사가 켜져 있으면 직원이고 아니면 구성원이다 | `project.test.mjs` 2<br>`project.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 담당자와 프로젝트 담당만 일을 옮긴다 | `project.test.mjs` 1<br>`project.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 시간과 날짜의 경계가 지켜진다 | `project.test.mjs` 3<br>`project.spec.mjs` 2 | SQL, 브라우저 | ✅ |
| 단계와 끝남의 규칙이 지켜진다 | `project.test.mjs` 2<br>`project.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 서비스 주문이 프로젝트가 될 수 있다 | `project.test.mjs` 4<br>`project.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 되돌릴 수 없는 상태가 없으므로 사가는 되돌리기다 | `project.test.mjs` 2 | SQL | ✅ |
| MCP 는 구성원의 권한만큼만 한다 | `project.test.mjs` 1 | SQL | ✅ |
| 작업 소요 실측은 계획과 기록이 있는 완료 작업으로만 센다 | `project.test.mjs` 1<br>`project.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 납기 지연은 아는 만큼만 말한다 | `project.test.mjs` 1<br>`project.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 근태와의 대조는 근태 이벤트가 있을 때만 한다 | `project.test.mjs` 1<br>`project.spec.mjs` 1 | SQL, 브라우저 | ◐ |
| 꺼도 이력과 분석이 남는다 | `project.test.mjs` 1 | SQL | ✅ |
| 가상 회사에 프로젝트가 더해져도 다른 수치는 그대로다 | `project.test.mjs` 1 | SQL | ✅ |

### 23. 구독 (spec `erp-subscription`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 구독은 꺼진 채 시작하고 청구가 있어야 켜진다 | `subscription.test.mjs` 1<br>`subscription.spec.mjs` 1<br>`isolation.test.mjs` 3 | SQL, 브라우저 | ✅ |
| 쓰기는 sales 와 관리자, 청구 확인은 회계도, 읽기는 모든 구성원이다 | `subscription.test.mjs` 1<br>`subscription.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 정기 청구 제품의 주문이 구독이 되고 첫 기간은 주문이 청구한다 | `subscription.test.mjs` 3<br>`subscription.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 기간마다 한 번 청구하고 청구 모듈이 청구서를 만든다 | `subscription.test.mjs` 4<br>`subscription.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 계약 기간은 기간의 마지막 날에 끝나고 갱신하거나 해지된다 | `subscription.test.mjs` 2 | SQL | ✅ |
| 품목 변경은 다음 기간부터이고 지금 적용하면 남은 날을 정산한다 | `subscription.test.mjs` 2<br>`subscription.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 일시 중지와 재개는 다음 청구일을 멈춘 날수만큼 미룬다 | `subscription.test.mjs` 1 | SQL | ✅ |
| 해지는 목록의 사유로 하고 다시 열면 오늘부터 청구한다 | `subscription.test.mjs` 1<br>`subscription.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 만기가 지난 기간은 구독을 「미납」으로 표시하되 멈추지 않는다 | `subscription.test.mjs` 1 | SQL | ✅ |
| MRR 과 그 증감은 원장에서 세고 언제나 더하면 맞는다 | `subscription.test.mjs` 2<br>`subscription.spec.mjs` 1<br>`models.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 되돌리면 구독과 청구서가 함께 돌아간다 | `subscription.test.mjs` 1 | SQL | ✅ |
| 끄면 청구가 멈추고 다시 켜면 밀린 기간을 청구한다 | `subscription.test.mjs` 1 | SQL | ✅ |
| MCP 는 구성원의 권한만큼만 한다 | `subscription.test.mjs` 2 | SQL | ✅ |
| 초안은 화면에서 금액을 미리 보고 품목은 줄 이벤트로 남는다 | `subscription.test.mjs` 1 | SQL | ✅ |

## 단계별 시험 수

| 단계 | 파일 | 시험 수 |
|---|---|---|
| SQL | `test/*.test.mjs` (43개) | 1273 |
| HTTP | `test/*.e2e.mjs` (2개) | 17 |
| 브라우저 | `e2e/tests/*.spec.mjs` (24개) | 277 |
| 합계 | 69개 | 1567 |

| 단계 | 파일별 시험 수 |
|---|---|
| HTTP | `api.e2e.mjs` 10 · `stack.e2e.mjs` 7 |
| 브라우저 | `attendance.spec.mjs` 8 · `books.spec.mjs` 10 · `crm.spec.mjs` 8 · `demo.spec.mjs` 5 · `expense.spec.mjs` 13 · `growth.spec.mjs` 10 · `history.spec.mjs` 8 · `hr.spec.mjs` 13 · `integration.spec.mjs` 3 · `krtax.spec.mjs` 8 · `ledger.spec.mjs` 7 · `master.spec.mjs` 7 · `meta.spec.mjs` 23 · `modules.spec.mjs` 16 · `mrp.spec.mjs` 15 · `pages.spec.mjs` 4 · `parity-screens.spec.mjs` 36 · `payroll.spec.mjs` 17 · `project.spec.mjs` 8 · `resilience.spec.mjs` 9 · `rollback.spec.mjs` 13 · `setup.spec.mjs` 10 · `timeoff.spec.mjs` 11 · `whatif.spec.mjs` 15 |

위 표는 실제로 돌려 센 값이다(SQL `tests 1273`, 브라우저 `277 passed`, HTTP `api.e2e.mjs` 10, `stack.e2e.mjs` 7). SQL 의 파일별 수는 다시 세지 않아 뺐다. `pricing.test.mjs` 의 `case:` 시험은 `test/pricing-cases.json` 의 사례마다 하나씩 생긴다. `isolation.test.mjs` 의 조합은 모듈의 조합마다 하나씩 생긴다. `expense-privacy.test.mjs` 의 표는 사람과 키와 읽는 길을 곱한 것이지만 시험 하나로 센다. 로컬 Postgres 의 디버거 확장(`pldbgapi2`)이 가끔 시험 하나를 떨어뜨린다. 그 파일만 다시 돌리면 통과한다.

**경비 읽기 규칙의 시험을 시험했다.** 읽는 길의 거름 조건 20개를 하나씩 빼고 `expense-privacy.test.mjs` 를 돌려 모두 실패하는 것을 확인했다(RLS 두 정책, `require_readable`, `erp_correlation`, 명령과 `erp_update` 의 범위 확인, `erp_records_at`, MCP 목록, 사가 상태 둘, `erp_references`, 가져오기, 사유 셋, 전표 적요, Storage, 글 함수, 상태의 적요, 역할). 처음에는 둘이 잡히지 않아 시험을 더했다.

openspec 명세 22개의 요구사항 383개, 시나리오 1045개. 위 표에 있는 요구사항 379개: 덮음 347 · 일부 32 · 공백 0. 각 스펙의 증거 표에 있는 시나리오 1025개: 덮음 992 · 일부 15 · 공백 18. 표에 없는 요구사항은 `erp-analytics` 3개(내년 분기 전망, 판매가 what-if, MCP 로 읽는 분석 사실)와 `erp-integration` 1개(한 업무를 사가로 묶어 한 번에 보상한다)다. 증거 표에 없는 시나리오 20개 가운데 19개가 이 두 스펙(`erp-integration` 11, `erp-analytics` 8)의 것이다.

## 남은 공백

**pg_cron.** 여러 사람이 같은 스택을 하루에 수십 번 초기화하면 `pg_cron` 이 설치 직후 잠깐 돌고 오래 멈추는 때가 있다. 워커 프로세스는 살아 있고 막힌 쿼리도 없으며, `cron.job_run_details` 에 새 행이 생기지 않는다. 원인은 찾지 못했고 DB 를 다시 시작하지 않았다. 이때 `pg_cron` 만 기다리는 `api.e2e.mjs` 3개(MCP 되돌리기, 플러그인, 제조)가 시간을 넘긴다. 위 수는 5초마다 `erp.bus_run` 을 부르는 대역을 함께 돌려 얻었으므로, **플러그인 시험은 이 판에서 `pg_cron` 자체를 증명하지 않는다.** 대역 없이 `pg_cron` 이 돌 때는 통과한 적이 있다.

시험이 없는 시나리오다. 코드를 읽어 확인한 동작이고 회귀 시험은 없다.

- `erp-ledger`: 7일이 지난 재시도 키는 잊힌다
- `erp-history`: 되돌린 문서의 번호는 다시 쓰지 않는다
- `erp-master`: 지정일이 그 달보다 크면 그 달 말일이다 · 합쳐도 발행된 문서의 거래처는 그대로다
- `erp-sales`: 가격 다시 계산은 할인 줄도 0 으로 돌리고 취소된 주문은 다시 계산을 거부한다 · 만료된 견적은 포털에서 선택 제품을 담을 수 없고 거절은 된다
- `erp-inventory`: 재고를 켜기 전의 주문은 늘어난 수량만 새 전표가 된다
- `erp-purchase`: 수량이 바뀌어 납기가 달라져도 정해진 입고 예정일은 그대로다 · 공급사 단가와 최소 수량은 구매 단위 기준이다 · 확정을 되돌리는 미리보기는 공급사에게 따로 알리라고 경고한다 · 회계 역할은 구매 문서를 읽기만 한다 · 재고나 청구가 꺼지면 그 칸이 보이지 않는다
- `erp-invoicing`: 구매 주문은 기준일 전이어도 공급사 청구서를 만들 수 있다 · 돈을 내줄 문서의 버튼은 지급 등록이다
- `erp-accounting`: 지급 탈락에 계정을 고르지 않으면 잡이익으로 잡힌다
- `erp-integration`: 끝나지 않은 트랜잭션의 이벤트는 나오지 않는다 · 피드는 호출자의 읽기 권한을 따른다
- `erp-setup`: 한도의 80% 를 넘으면 경고한다

시험이 일부만 확인하는 시나리오다. 이유는 각 스펙의 `e2e/README.md` 표 아래에 있다.

- `erp-ledger`: 이력 패널을 접고 펼친다
- `erp-history`: 재고와 미수금 화면도 그 시점을 따른다
- `erp-master`: 기본 데이터를 다시 넣어도 바꾼 이름이 돌아오지 않는다 · 되돌리기로 제품에서 빠진 변형은 찾을 수 없고 바코드를 놓는다
- `erp-sales`: 견적·주문 목록에 주문이 보인다
- `erp-inventory`: 가져오기 날짜를 비워 두면 켠 뒤의 주문만 전표가 된다
- `erp-purchase`: 잘못된 입력은 저장되지 않는다 · 잠긴 주문은 숫자와 취소가 막히고 메모는 받는다 · 서비스 줄은 직접 입력하고 입고 상태에 들어가지 않는다
- `erp-invoicing`: 미지급금은 공급사 문서의 남은 금액이다 · 막힌 되돌리기는 화면에 안내만 보여 준다
- `erp-accounting`: 장부 시작일을 고르면 그 날 이후의 이벤트만 전표가 된다

시험으로 재지 않은 것은 클라우드 Supabase, 큰 회사의 되돌리기, 실제 회사의 예측 정확도다. 메일 발송, 결제, 전자세금계산서, 은행 연동은 제품에 없다.

### 22. 관리회계 (spec `erp-analytic`)

| 요구사항 | 시험 | 단계 | |
|---|---|---|---|
| 관리회계는 꺼진 채 시작하고 회계가 있어야 켜진다 | `analytic.test.mjs` 1<br>`analytic.spec.mjs` 1<br>`isolation.test.mjs` 4 | SQL, 브라우저 | ✅ |
| 분석 분배는 계획마다 합이 100 이다 | `analytic.test.mjs` 1(`analytic-cases.json` distribution 17) | SQL | ✅ |
| 게시한 전표가 분석 줄이 된다 | `analytic.test.mjs` 5<br>`analytic.spec.mjs` 1 | SQL, 브라우저 | ◐ 시점 보기는 함수로만 |
| 기본 분배 규칙은 문서를 게시한 때의 것을 쓴다 | `analytic.test.mjs` 2 | SQL | ✅ |
| 확정한 예산은 사유와 함께만 바뀌고 그 이력이 남는다 | `analytic.test.mjs` 2<br>`analytic.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 예산 대비 실적은 분석 줄로 계산한다 | `analytic.test.mjs` 2(`analytic-cases.json` budget 5)<br>`analytic.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 예산을 넘기는 비용은 경고만 한다 | `analytic.test.mjs` 1<br>`analytic.spec.mjs` 1 | SQL, 브라우저 | ◐ 경비 승인 화면은 돌리지 않았다 |
| 돈이 보이는 것은 회계와 관리자만 본다 | `analytic.test.mjs` 1<br>`analytic.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 에이전트는 같은 권한으로 묻고 바꾼다 | `analytic.test.mjs` 1 | SQL | ✅ |
| 나중에 켜고 끈다 | `analytic.test.mjs` 2 | SQL | ✅ |
| 구매 주문의 약정 금액을 예산에 보인다 | 없음 | | ✗ 범위 밖(구매 주문 줄에 분배가 없고, 주문 줄과 청구서 줄의 대응을 구독으로 따라가야 한다. `docs/modules/analytic.md`) |

