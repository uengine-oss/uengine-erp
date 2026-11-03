# E2E — erp-ledger

원장이 추가만 되는지, 명령이 한 트랜잭션인지, 별도 연결 수십 개로 동시에 보낸 요청이 규칙을 넘지 못하는지, 재시도 키·상태 코드·앱과 DB 의 버전 확인이 동작하는지 확인한다. SQL 시험은 PostgREST 가 하는 대로 요청마다 트랜잭션·역할·JWT 를 설정해 부르고, HTTP 시험은 실제 게이트웨이를 거치며, 브라우저 시험은 프로덕션 빌드의 폼·목록·원장 화면을 쓴다. 화면 시험의 문서는 대부분 시험용 유형(`test_order` 등)이고 카탈로그로 그려지는 같은 화면이다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/core.test.mjs test/concurrency.test.mjs test/bus.test.mjs
source scripts/local-env.sh && SETUP_CODE=<설치 코드> node --test test/stack.e2e.mjs   # scripts/reset-local.mjs, scripts/install-local.mjs <설치 코드> 뒤에. test/api.e2e.mjs 도 같은 순서로 따로 돌린다. 로컬 스택의 postgres DB 를 쓴다
source scripts/local-env.sh && npm run test:e2e -- meta.spec.mjs ledger.spec.mjs modules.spec.mjs resilience.spec.mjs growth.spec.mjs demo.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, HTTP 시험은 로컬 스택의 API(:56321), 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 고치면 이전 값과 이후 값이 이벤트에 남는다 | `core.test.mjs › create and update emit events with field-level before/after` | SQL | ✅ |
| 바뀐 것이 없으면 이벤트도 없다 | `core.test.mjs › an update that changes nothing writes no event` | SQL | ✅ |
| 소유자도 원장을 고치거나 지울 수 없다 | `core.test.mjs › events cannot be rewritten, not even by the owner` | SQL | ✅ |
| 관리자의 브라우저도 이벤트를 위조할 수 없다 | `concurrency.test.mjs › the browser cannot forge an event: every direct path is refused`<br>`core.test.mjs › members cannot write the tables directly, only through commands`<br>`stack.e2e.mjs › a member reads through views but cannot write to them` | SQL, HTTP | ✅ |
| 요청 본문으로 다른 사람 행세를 할 수 없다 | `concurrency.test.mjs › a caller cannot pass another user id, role, or actor through the API` | SQL | ✅ |
| 실패한 명령은 이벤트·상태·문서 번호를 남기지 않는다 | `concurrency.test.mjs › all or nothing: a failure rolls back events, projection, and document numbers` | SQL | ✅ |
| 연쇄 반응이 실패하면 원래 명령도 취소된다 | `concurrency.test.mjs › a failing reaction in another aggregate undoes the original command too` | SQL | ✅ |
| 연쇄로 생긴 이벤트는 같은 작업 번호와 원인을 가리킨다 | `concurrency.test.mjs › reactions share one correlation id and point at the event that caused them` | SQL | ✅ |
| 수량 10 에서 동시에 50번 빼면 10번만 성공한다 | `concurrency.test.mjs › last-unit race: 50 simultaneous takes of 10 units sell exactly 10` | SQL | ✅ |
| 동시에 40번 써도 잃어버리는 쓰기가 없다 | `concurrency.test.mjs › no lost update: 40 simultaneous writes all land, in an unbroken version sequence` | SQL | ✅ |
| 유일한 값은 동시에 만들어도 하나만 생긴다 | `concurrency.test.mjs › unique value race: 20 simultaneous creates of one name make exactly one record` | SQL | ✅ |
| 옛 버전을 보낸 저장은 거부된다 | `core.test.mjs › optimistic concurrency rejects a stale expected version`<br>`api.e2e.mjs › REST: status codes a client can act on` | SQL, HTTP | ✅ |
| 같은 폼을 동시에 저장하면 한 사람만 이긴다 | `concurrency.test.mjs › two people save the same form: with a version check exactly one wins` | SQL | ✅ |
| 입력 중에 다른 사람이 고치면 알리고 새로 고침을 제공한다 | `meta.spec.mjs › 다른 사람이 먼저 고치면 충돌을 알리고 새로 고침을 제공한다` | 브라우저 | ✅ |
| 입력 중이 아니면 다른 사람의 변경이 바로 반영된다 | `meta.spec.mjs › 입력 중이 아니면 다른 사람의 변경이 자동으로 반영된다` | 브라우저 | ✅ |
| 응답을 잃어 다시 보내도 문서는 하나다 | `bus.test.mjs › unknown fields are refused, and a lost response can be replayed without a duplicate` | SQL | ✅ |
| 다른 사람의 같은 키는 다른 요청이다 | `bus.test.mjs › unknown fields are refused, and a lost response can be replayed without a duplicate` | SQL | ✅ |
| 7일이 지난 재시도 키는 잊힌다 | ✗ | — | ✗ |
| 모르는 필드를 넣은 명령은 거부된다 | `bus.test.mjs › unknown fields are refused, and a lost response can be replayed without a duplicate` | SQL | ✅ |
| 입력 오류는 코드로 구분된다 | `core.test.mjs › validation: required, enum, number, unique` | SQL | ✅ |
| 클라이언트는 상태 코드로 오류를 구분한다 | `api.e2e.mjs › REST: status codes a client can act on` | HTTP | ✅ |
| 화면은 서버 문구만 보여 주고 칸을 표시한다 | `meta.spec.mjs › 필수값이 빠지면 서버 문구만 보여 주고 해당 칸을 표시한다` | 브라우저 | ✅ |
| 서버가 거절한 변경은 사유를 보여 주고 입력을 되돌릴 수 있다 | `meta.spec.mjs › 서버가 거절한 상태 변경은 사유를 보여 준다` | 브라우저 | ✅ |
| 다른 문서가 참조하는 레코드는 지울 수 없다 | `core.test.mjs › referenced records cannot be deleted` | SQL | ✅ |
| 명령마다 역할을 확인한다 | `core.test.mjs › roles are enforced per command` | SQL | ✅ |
| 읽기 제한 유형은 어디서도 보이지 않는다 | `concurrency.test.mjs › read roles: a member only sees aggregate types their role may read, including in the ledger` | SQL | ✅ |
| 조회 역할은 쓰기 버튼이 없고 읽기 제한 유형은 안내만 본다 | `meta.spec.mjs › 조회 역할은 쓰기 버튼이 없고, 읽기 제한 유형은 빈 상태 문구로 안내한다` | 브라우저 | ✅ |
| 원장을 유형·출처·이벤트·행위자로 거른다 | `ledger.spec.mjs › 원장 표와 필터` | 브라우저 | ✅ |
| 이벤트를 누르면 원본과 인과 사슬이 보인다 | `ledger.spec.mjs › 행을 누르면 원본 JSON 과 인과 사슬 트리가 나온다` | 브라우저 | ✅ |
| 이력은 사람과 에이전트, 사유를 구분해 보여 준다 | `ledger.spec.mjs › 이력은 출처와 사유를 구분해 보여 준다`<br>`meta.spec.mjs › 저장하면 번호가 붙고 주소가 바뀌며 이력이 시작된다` | 브라우저 | ✅ |
| 값을 바꾸면 이력에 라벨과 이전·이후가 남는다 | `meta.spec.mjs › 값을 바꾸면 이력에 라벨과 이전→이후가 남는다` | 브라우저 | ✅ |
| 현재 상태는 원장 재생과 같다 | `core.test.mjs › the projection always equals a replay of the ledger` | SQL | ✅ |
| 무결성 검증이 몰래 고친 값을 찾아낸다 | `ledger.spec.mjs › 무결성 검증은 진행률과 결과를 보여 주고, 손상을 찾아낸다` | 브라우저 | ✅ |
| 카탈로그에 있는 유형만 메뉴에 나타난다 | `meta.spec.mjs › 카탈로그에 있는 유형이 메뉴에 나타나고, 없는 유형은 숨는다` | 브라우저 | ✅ |
| 줄을 넣으면 서버가 계산한 값이 화면에 나타난다 | `growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다`<br>`meta.spec.mjs › 줄을 넣으면 서버가 계산한 단가·합계가 300ms 뒤 화면에 나타난다` | 브라우저 | ✅ |
| 저장하면 번호가 붙고 주소가 바뀌며 이력이 시작된다 | `meta.spec.mjs › 저장하면 번호가 붙고 주소가 바뀌며 이력이 시작된다`<br>`growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다` | 브라우저 | ✅ |
| 상태 변경 버튼은 지금 상태에 맞는 것만 나온다 | `meta.spec.mjs › 전이 버튼은 현재 상태에 맞는 것만 나오고, 대화상자와 확인을 거친다` | 브라우저 | ✅ |
| 참조 칸은 키보드만으로 고른다 | `meta.spec.mjs › 참조 입력은 키보드만으로 고른다` | 브라우저 | ✅ |
| 줄 표는 Tab 으로 늘리고 구역·메모 줄을 넣는다 | `meta.spec.mjs › 마지막 칸에서 Tab 을 누르면 새 줄이 생기고 구역·메모 줄을 넣고 지울 수 있다` | 브라우저 | ✅ |
| 추가 명령과 위험 동작은 더 보기에 있다 | `meta.spec.mjs › 추가 명령·보관·삭제는 더 보기에 있고 위험 동작은 확인한다` | 브라우저 | ✅ |
| 저장 안 한 변경이 있으면 떠나기 전에 묻는다 | `meta.spec.mjs › 저장 안 한 변경이 있으면 떠나기 전에 묻는다` | 브라우저 | ✅ |
| 빈 목록은 할 일을 알려 준다 | `meta.spec.mjs › 빈 목록은 할 일을 알려 준다` | 브라우저 | ✅ |
| 없는 주소는 안내 화면을 보여 준다 | `meta.spec.mjs › 없는 주소는 안내 화면을 보여 준다` | 브라우저 | ✅ |
| 목록 조건이 주소에 남는다 | `meta.spec.mjs › 목록: 검색, 정렬, 상태 필터, 쪽 넘김이 조건과 함께 주소에 남는다` | 브라우저 | ✅ |
| 목록은 금액·상태·참조 이름을 읽기 좋게 보여 준다 | `meta.spec.mjs › 목록: 금액 오른쪽 정렬, 상태 알약, 참조 이름, 보관 포함` | 브라우저 | ✅ |
| CSV 는 이름으로 내려받고 수식 주입을 막는다 | `meta.spec.mjs › CSV 는 이름으로 내려받고 수식 주입을 막는다` | 브라우저 | ✅ |
| 인쇄는 문서만 남긴다 | `meta.spec.mjs › 인쇄는 메뉴와 버튼을 뺀 문서만 남긴다` | 브라우저 | ✅ |
| 이력 패널을 접고 펼친다 | `meta.spec.mjs › 이력 패널을 접으면 표가 넓어지고 다시 펼칠 수 있다` | 브라우저 | ◐ |
| 다른 사람이 만든 문서가 목록과 원장에 바로 나타난다 | `resilience.spec.mjs › 실시간: 다른 사람이 만든 문서가 내 목록과 원장에 바로 나타난다` | 브라우저 | ✅ |
| 실시간 연결이 막혀도 앱은 돌아간다 | `resilience.spec.mjs › 실시간 연결이 막혀도 앱은 그대로 돌아간다` | 브라우저 | ✅ |
| 쓰는 중에 연결이 끊겨도 입력은 남는다 | `resilience.spec.mjs › 쓰는 중에 연결이 끊겨도 입력은 그대로 있고, 재시도할 수 있다` | 브라우저 | ✅ |
| 일시 오류는 한 번 스스로 다시 보낸다 | `demo.spec.mjs › 실제 회사로 시작하면 가상 회사 표시도 데모 코드도 없고, 일반 쓰기는 같은 오류를 한 번 스스로 넘긴다` | 브라우저 | ✅ |
| 오래된 앱의 명령은 거부된다 | `bus.test.mjs › an app older than the database supports is refused` | SQL | ✅ |
| 화면의 모든 명령이 앱 버전을 싣는다 | `modules.spec.mjs › 명령이 끝나면 전달을 재촉하고, 실시간이 꺼져 있어도 열린 문서에 다른 모듈의 결과가 나타난다` | 브라우저 | ✅ |
| DB 가 최소 버전을 높이면 열린 앱은 쓰기를 멈춘다 | `modules.spec.mjs › DB 가 앱보다 최소 버전을 높이면 쓰기를 막고 새로 고침을 안내한다` | 브라우저 | ✅ |
| DB 가 앱보다 낮으면 업그레이드할 때까지 쓰기를 막는다 | `modules.spec.mjs › DB 가 앱보다 낮으면 업그레이드 배너에 더해 쓰기 버튼을 막는다` | 브라우저 | ✅ |

- 「이력 패널을 접고 펼친다」: 시험 이름은 표가 넓어진다고 하지만 본문은 패널이 사라졌다 나타나는 것만 확인한다. 스펙은 본문대로 적었다.
- 「수량 10 에서 동시에 50번 빼면 10번만 성공한다」 등 동시성 시나리오는 시험용 유형으로 커널의 잠금을 확인한다. 실제 재고의 동시성은 `erp-inventory`, 입금의 동시성은 `erp-invoicing` 에 있다.
- 「7일이 지난 재시도 키는 잊힌다」: 시험이 없다. 전달 작업이 7일 넘은 키를 지우는 것을 SQL 에서 확인했다.

## 시나리오에 대응하지 않는 시험

- `modules.spec.mjs › 쓰기는 한 곳에서만 나간다: 화면에 erp_command 호출이 없다`: 앱 소스의 구조 검사다.
