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

브라우저 시험은 한 번에 하나만 돈다(`workers: 1`). 같은 스택을 쓰는 다른 작업이 있으면 돌리지 않는다.

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
| 켜기 전에 무엇이 열리고 무엇을 다시 만들 수 없는지 알려 준다 | `modules.spec.mjs` 1<br>`growth.spec.mjs` 1<br>`accounting.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 켠 모듈은 그 뒤의 이벤트부터 받고 고른 만큼만 과거를 읽는다 | `modules.spec.mjs` 1<br>`bus.test.mjs` 5<br>`growth.test.mjs` 2<br>`growth.spec.mjs` 1 | SQL, 브라우저 | ✅ |
| 모듈 사이의 통로는 원장 이벤트 하나다 | `growth.test.mjs` 1<br>`growth.spec.mjs` 1<br>`bus.test.mjs` 1 | SQL, 브라우저 | ✅ |
| 다섯 모듈의 어떤 조합도 동작한다 | `isolation.test.mjs` 32 | SQL | ✅ |
| 구독자가 실패해도 다른 일은 멈추지 않는다 | `growth.test.mjs` 1<br>`modules.spec.mjs` 2<br>`bus.test.mjs` 3 | SQL, 브라우저 | ✅ |
| 전달은 재촉과 정기 실행으로 이어지고 순서를 지킨다 | `modules.spec.mjs` 2<br>`api.e2e.mjs` 1<br>`bus.test.mjs` 2 | SQL, HTTP, 브라우저 | ✅ |
| 끄면 막히되 데이터는 남고 다시 켤 때 밀린 일을 고른다 | `modules.spec.mjs` 1<br>`growth.spec.mjs` 1<br>`bus.test.mjs` 1 | SQL, 브라우저 | ✅ |
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

## 단계별 시험 수

| 단계 | 파일 | 시험 수 |
|---|---|---|
| SQL | `test/*.test.mjs` (18개) | 597 |
| HTTP | `test/*.e2e.mjs` (2개) | 13 |
| 브라우저 | `e2e/tests/*.spec.mjs` (13개) | 130 |
| 합계 | 33개 | 740 |

| 단계 | 파일별 시험 수 |
|---|---|
| SQL | `accounting.test.mjs` 27 · `api.test.mjs` 11 · `bus.test.mjs` 18 · `concurrency.test.mjs` 11 · `core.test.mjs` 18 · `demo.test.mjs` 4 · `growth.test.mjs` 11 · `history.test.mjs` 21 · `inventory.test.mjs` 63 · `invoicing.test.mjs` 51 · `isolation.test.mjs` 39 · `master.test.mjs` 45 · `models.test.mjs` 36 · `plugin.test.mjs` 8 · `pricing.test.mjs` 145 · `purchase.test.mjs` 30 · `rebuild-gl.test.mjs` 8 · `sales.test.mjs` 51 |
| HTTP | `api.e2e.mjs` 6 · `stack.e2e.mjs` 7 |
| 브라우저 | `demo.spec.mjs` 5 · `growth.spec.mjs` 10 · `history.spec.mjs` 8 · `integration.spec.mjs` 3 · `ledger.spec.mjs` 7 · `master.spec.mjs` 7 · `meta.spec.mjs` 23 · `modules.spec.mjs` 16 · `pages.spec.mjs` 4 · `resilience.spec.mjs` 9 · `rollback.spec.mjs` 13 · `setup.spec.mjs` 10 · `whatif.spec.mjs` 15 |

SQL 은 `node --test` 의 `tests 597`, 브라우저는 `npx playwright test --list` 의 `Total: 130 tests in 13 files` 로 세었다. HTTP 는 초기화한 스택이 있어야 돌므로 소스의 `test()` 를 세었다. `pricing.test.mjs` 의 `case:` 시험은 `test/pricing-cases.json` 의 사례마다 하나씩 생긴다. `isolation.test.mjs` 의 32개는 다섯 모듈의 조합마다 하나씩 생긴다.

openspec 명세 12개의 요구사항 212개: 덮음 183 · 일부 29 · 공백 0. 시나리오 633개: 덮음 603 · 일부 12 · 공백 18.

## 남은 공백

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
