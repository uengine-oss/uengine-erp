# E2E — erp-integration

REST 자원과 MCP 함수가 PostgREST 가 부르는 방식대로 동작하는지 SQL 로 확인하고, 실제 게이트웨이·PostgREST·GoTrue 를 거치는 HTTP 와 공식 MCP SDK 로 다시 확인한다. 연동 화면은 브라우저로 키를 만들고 실제 HTTP 로 쓴 뒤 폐기한다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/api.test.mjs test/bus.test.mjs test/growth.test.mjs
source scripts/local-env.sh && SETUP_CODE=<설치 코드> node --test test/api.e2e.mjs   # scripts/reset-local.mjs, scripts/install-local.mjs <설치 코드> 뒤에. 로컬 스택의 postgres DB 를 쓴다
source scripts/local-env.sh && npm run test:e2e -- integration.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, HTTP 시험은 로컬 스택의 API(:56321) + `@modelcontextprotocol/sdk`, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 표준 CRUD 가 명령이 되어 원장에 남는다 | `api.test.mjs › REST resources: create, read, update and delete all become commands in the ledger`<br>`api.e2e.mjs › REST: status codes a client can act on` | SQL, HTTP | ✅ |
| 상태 변경은 업무 동작이 되어 한 번에 처리된다 | `api.test.mjs › REST: a state change means the business action, with its params, in one transaction` | SQL | ✅ |
| 넓은 필터로 여러 건을 바꿀 수 없다 | `api.test.mjs › REST: a loose filter cannot rewrite many rows, and nothing changes when it tries`<br>`api.e2e.mjs › REST: loose filters are refused, a retried request is not a second record` | SQL, HTTP | ✅ |
| If-Match 로 옛 버전의 수정을 막는다 | `api.e2e.mjs › REST: status codes a client can act on`<br>`api.test.mjs › REST resources: create, read, update and delete all become commands in the ledger` | SQL, HTTP | ✅ |
| Idempotency-Key 로 다시 보내도 한 건이다 | `api.test.mjs › REST: a retried request with the same key does not create a second record`<br>`api.e2e.mjs › REST: loose filters are refused, a retried request is not a second record` | SQL, HTTP | ✅ |
| 역할과 모듈과 공개 키의 제한이 그대로다 | `api.test.mjs › REST: roles, modules and the public key still apply`<br>`api.e2e.mjs › REST: status codes a client can act on` | SQL, HTTP | ✅ |
| 제품과 함께 설치된 자원에도 쓸 수 있다 | `api.test.mjs › REST: resources installed with the product keep their write access after the grants run` | SQL | ✅ |
| API 가 자기 모양을 설명한다 | `api.e2e.mjs › REST: the API describes itself from the catalog` | HTTP | ✅ |
| 공식 클라이언트가 접속해 도구 4개를 본다 | `api.e2e.mjs › MCP over HTTP with a login token: CRUD with the official SDK`<br>`api.test.mjs › MCP: the handshake, four tools, and resources for what is turned on` | SQL, HTTP | ✅ |
| 켜진 모듈의 유형만 도구와 리소스에 나온다 | `api.test.mjs › MCP: the handshake, four tools, and resources for what is turned on`<br>`api.e2e.mjs › MCP over HTTP with a login token: CRUD with the official SDK` | SQL, HTTP | ✅ |
| 읽기·쓰기·상태 변경·이력·시점을 도구로 한다 | `api.test.mjs › MCP: CRUD, a state change as an update, history, time travel and resources` | SQL | ✅ |
| 규칙 오류는 에이전트가 읽을 수 있는 도구 결과로 온다 | `api.test.mjs › MCP: CRUD, a state change as an update, history, time travel and resources`<br>`api.e2e.mjs › MCP over HTTP with a login token: CRUD with the official SDK` | SQL, HTTP | ✅ |
| 에이전트가 주문을 확정하고 전표가 이어진다 | `growth.test.mjs › S9. MCP: an agent confirms an order with CRUD, and sees only modules that are on` | SQL | ✅ |
| 조회 역할은 읽기만 하고 읽기 제한 유형은 보이지 않는다 | `api.test.mjs › MCP: a viewer reads but cannot write, and types they may not read stay hidden` | SQL | ✅ |
| 모르는 메서드는 표준 오류로 답한다 | `api.test.mjs › MCP: the handshake, four tools, and resources for what is turned on` | SQL | ✅ |
| 키로 로그인 없이 쓰고 행위자는 그 구성원이다 | `api.test.mjs › MCP keys: work without a login, act as the member, can be revoked, and stay out of the ledger`<br>`api.e2e.mjs › MCP over HTTP with a long-lived key and no login at all` | SQL, HTTP | ✅ |
| 키는 저장되지 않고 원장에 남지 않는다 | `api.test.mjs › MCP keys: work without a login, act as the member, can be revoked, and stay out of the ledger`<br>`integration.spec.mjs › 키를 만들면 한 번만 보여 주고, 고른 구성원의 권한으로 동작하며, 폐기하면 끊긴다` | SQL, 브라우저 | ✅ |
| 키는 구성원 권한을 넘지 못하고 구성원이 사라지면 끊긴다 | `api.test.mjs › MCP keys: a key does not get more than its member, and a removed member loses access`<br>`api.e2e.mjs › MCP over HTTP with a long-lived key and no login at all` | SQL, HTTP | ✅ |
| 잘못된 키와 없는 키와 폐기한 키는 거부된다 | `api.test.mjs › MCP keys: work without a login, act as the member, can be revoked, and stay out of the ledger`<br>`api.e2e.mjs › MCP over HTTP with a long-lived key and no login at all` | SQL, HTTP | ✅ |
| 관리자만 키를 만든다 | `api.test.mjs › MCP keys: work without a login, act as the member, can be revoked, and stay out of the ledger` | SQL | ✅ |
| 연동 화면이 주소와 헤더와 자원을 안내한다 | `integration.spec.mjs › 연동 키가 없으면 안내하고, 주소와 헤더, REST 자원을 보여 준다` | 브라우저 | ✅ |
| 키는 만들 때 한 번만 보여 준다 | `integration.spec.mjs › 키를 만들면 한 번만 보여 주고, 고른 구성원의 권한으로 동작하며, 폐기하면 끊긴다` | 브라우저 | ✅ |
| 폐기하면 바로 끊긴다 | `integration.spec.mjs › 키를 만들면 한 번만 보여 주고, 고른 구성원의 권한으로 동작하며, 폐기하면 끊긴다` | 브라우저 | ✅ |
| 관리자가 아니면 연동 메뉴가 없고 실패와 작은 화면에도 읽힌다 | `integration.spec.mjs › 비관리자에게는 메뉴가 없고, 목록을 읽지 못하면 오류를 보여 주며, 휴대폰과 어두운 테마에서도 읽힌다` | 브라우저 | ✅ |
| 커서로 이어 읽는다 | `bus.test.mjs › the feed gives settled events and a cursor, within read rights` | SQL | ✅ |
| 끝나지 않은 트랜잭션의 이벤트는 나오지 않는다 | ✗ | — | ✗ |
| 피드는 호출자의 읽기 권한을 따른다 | ✗ | — | ✗ |

- 「끝나지 않은 트랜잭션…」, 「피드는 호출자의 읽기 권한…」: 시험 이름 `the feed gives settled events and a cursor, within read rights` 는 그렇게 말하지만 본문은 관리자의 커서만 확인한다. 두 동작은 코드를 읽고 임시 DB 로 한 번 확인했다. 회귀 시험은 없다.
- 브라우저 시험의 폐기 확인은 `refused.status === 200 ? !!body.error : true` 로 느슨하다. 폐기한 키의 401 은 HTTP 시험이 확인한다.
