# E2E — erp-setup

새 회사가 처음 지나는 길을 프로덕션 빌드로 끝까지 걷는다. Supabase 대시보드에 SQL 을 붙여 넣는 한 단계만 시험이 대신 실행한다. 공개 키만으로 무엇이 닫혀 있는지는 실제 HTTP(`stack.e2e.mjs`)와 함수 권한 검사로 본다. 가상 회사는 짧은 이야기로 끝까지 만들어 장부와 재고를 확인한다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/core.test.mjs test/concurrency.test.mjs test/demo.test.mjs
source scripts/local-env.sh && SETUP_CODE=<설치 코드> node --test test/stack.e2e.mjs   # scripts/reset-local.mjs, scripts/install-local.mjs <설치 코드> 뒤에. 로컬 스택의 postgres DB 를 쓴다
source scripts/local-env.sh && npm run test:e2e -- setup.spec.mjs pages.spec.mjs resilience.spec.mjs ledger.spec.mjs demo.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, HTTP 시험은 로컬 스택의 API(:56321, 메일 확인 켜짐), 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택. 클라우드 Supabase 에서는 돌리지 않았다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 처음 접속하면 연결 화면이 나온다 | `setup.spec.mjs › 처음 접속하면 연결 화면이 나오고 찾는 곳을 안내한다` | 브라우저 | ✅ |
| 비밀 키는 보내지도 저장하지도 않는다 | `setup.spec.mjs › 비밀 키는 네트워크로 보내지도 저장하지도 않고 거부한다` | 브라우저 | ✅ |
| 잘못된 주소와 키 형식을 알려 준다 | `setup.spec.mjs › 잘못된 주소와 키 형식을 알려 준다` | 브라우저 | ✅ |
| 함수가 없으면 설치 단계로 가고 실행하면 다음으로 넘어간다 | `setup.spec.mjs › 함수가 없으면 설치 단계로 가고, 복사한 SQL 을 실행하면 자동으로 다음 단계로 넘어간다` | 브라우저 | ✅ |
| 다른 브라우저에서 설치했으면 설치 코드를 다시 발급한다 | `resilience.spec.mjs › 다른 브라우저에서 설치했으면 설치 코드를 다시 발급한다` | 브라우저 | ✅ |
| 틀린 설치 코드로는 회사를 차지할 수 없다 | `stack.e2e.mjs › a wrong setup code cannot claim the company` | HTTP | ✅ |
| 회사가 있으면 두 번째 회사를 만들 수 없다 | `core.test.mjs › setup creates the company, an admin, and refuses a second bootstrap` | SQL | ✅ |
| 공개 키로는 설치 여부만 물을 수 있다 | `stack.e2e.mjs › anon can ask whether the ERP is installed`<br>`core.test.mjs › setup creates the company, an admin, and refuses a second bootstrap` | SQL, HTTP | ✅ |
| 같은 SQL 을 다시 돌리면 업그레이드되고 데이터는 그대로다 | `resilience.spec.mjs › DB 스키마가 앱보다 낮으면 업그레이드를 안내하고, 같은 SQL 을 다시 돌리면 데이터는 그대로다`<br>`master.test.mjs › running the install script again changes no data` | SQL, 브라우저 | ✅ |
| 통화로 자릿수가 정해지고 자동으로 로그인한다 | `setup.spec.mjs › 회사를 만들면 통화 자릿수가 정해지고 자동으로 로그인한다` | 브라우저 | ✅ |
| 메일 없이 관리자 계정이 만들어진다 | `stack.e2e.mjs › bootstrap creates an admin who can sign in without any email being sent` | HTTP | ✅ |
| 직원을 추가하면 메일 없이 바로 로그인한다 | `setup.spec.mjs › 직원을 추가하면 메일 없이 바로 그 계정으로 로그인한다`<br>`stack.e2e.mjs › admin adds an employee who can sign in immediately, with no email` | HTTP, 브라우저 | ✅ |
| 직원에게는 관리자 동작이 보이지 않는다 | `setup.spec.mjs › 직원에게는 관리자 동작이 보이지 않는다` | 브라우저 | ✅ |
| 비활성화한 직원은 더 로그인하지 못한다 | `setup.spec.mjs › 비활성화한 직원은 더 로그인하지 못한다`<br>`core.test.mjs › a deleted member cannot read or write` | SQL, 브라우저 | ✅ |
| 관리자는 자기 자신을 잠글 수 없다 | `core.test.mjs › an admin cannot lock themselves out` | SQL | ✅ |
| 비밀번호는 원장에 남지 않는다 | `core.test.mjs › passwords never reach the event ledger` | SQL | ✅ |
| 공개 키만으로는 읽거나 쓰지 못한다 | `core.test.mjs › anon sees nothing and cannot write`<br>`stack.e2e.mjs › public key alone reads nothing through the REST API`<br>`setup.spec.mjs › 회사가 생긴 뒤에는 공개 키로 가입도, 조회도 되지 않는다` | SQL, HTTP, 브라우저 | ✅ |
| 허용된 공개 함수 밖은 닫혀 있다 | `core.test.mjs › every public function is closed to anon except the setup and portal allow-list`<br>`core.test.mjs › no function in the private schema is executable by anon, or by members beyond the role checks` | SQL | ✅ |
| 내부 스키마는 REST 로 닿지 않는다 | `stack.e2e.mjs › the private schema and base tables are unreachable through REST` | HTTP | ✅ |
| 로그인했어도 구성원이 아니면 읽을 수 없다 | `core.test.mjs › a logged-in stranger who is not a member reads nothing` | SQL | ✅ |
| 회사가 생긴 뒤에는 자가 가입이 막힌다 | `concurrency.test.mjs › sign-ups are closed once the company exists: only an admin can add an account`<br>`setup.spec.mjs › 회사가 생긴 뒤에는 공개 키로 가입도, 조회도 되지 않는다` | SQL, 브라우저 | ✅ |
| 어느 경로에 올려도 동작한다 | `pages.spec.mjs › 어느 경로에 올려도 동작한다: 모든 자산이 그 경로 아래에서 온다` | 브라우저 | ✅ |
| 글꼴은 자체 제공 Pretendard 로 그려진다 | `pages.spec.mjs › 글꼴은 자체 제공 Pretendard 로 그려진다` | 브라우저 | ✅ |
| CSP 가 정해진 그대로이고 인라인 스크립트가 없다 | `pages.spec.mjs › CSP 메타 태그가 정해진 그대로 있고 인라인 스크립트가 없다` | 브라우저 | ✅ |
| 소스와 빌드에 위험한 것이 없다 | `pages.spec.mjs › 소스와 빌드에 v-html·eval·제3자 주소·키·금지된 제품 이름이 없다` | 브라우저 | ✅ |
| 초대 링크는 주소를 확인시키고 접속 정보를 넘긴다 | `resilience.spec.mjs › 초대 링크는 주소를 확인시키고 접속 정보를 넘긴다 (예전 anon 키도 허용)` | 브라우저 | ✅ |
| 비밀 키가 든 초대 링크는 거부하고 주소에서 지운다 | `resilience.spec.mjs › 비밀 키가 든 초대 링크는 거부하고 주소에서 지운다` | 브라우저 | ✅ |
| 접속 해제하면 토큰과 접속 정보가 사라진다 | `setup.spec.mjs › 접속 해제하면 이 브라우저에서 토큰과 접속 정보가 사라진다` | 브라우저 | ✅ |
| 프로젝트가 일시 중지되면 안내하고 살아나면 돌아온다 | `resilience.spec.mjs › 프로젝트가 일시 중지되면 재시도와 재개 안내를 보여 주고, 살아나면 돌아온다` | 브라우저 | ✅ |
| 일시 중지 응답도 같은 안내로 처리한다 | `resilience.spec.mjs › 일시 중지 응답(540)도 같은 안내로 처리한다` | 브라우저 | ✅ |
| 사용량은 500 MB 대비 막대와 안내를 보여 준다 | `ledger.spec.mjs › 사용량은 500MB 대비 막대와 무료 플랜 안내를 보여 준다` | 브라우저 | ✅ |
| 한도의 80% 를 넘으면 경고한다 | ✗ | — | ✗ |
| 백업은 묶음으로 받아 NDJSON.gz 파일로 저장한다 | `ledger.spec.mjs › 백업은 묶음으로 받아 NDJSON.gz 파일로 저장한다` | 브라우저 | ✅ |
| 회사 정보를 고치면 표시줄에 바로 반영된다 | `ledger.spec.mjs › 회사 정보는 저장되고 통화는 읽기 전용이며 표시줄에 바로 반영된다` | 브라우저 | ✅ |
| 고르면 용량을 알리고 고르지 않으면 데모 코드를 받지 않는다 | `demo.spec.mjs › 회사를 만들기 전에 가상 회사를 고르면 용량을 알리고, 고르지 않으면 데모 코드를 받지 않는다` | 브라우저 | ✅ |
| 묶음으로 보내며 진행을 보여 주고 오류와 시간 제한을 스스로 넘긴다 | `demo.spec.mjs › 가상 회사를 만들면 묶음으로 보내며 진행을 보여 주고, 오류와 시간 제한을 스스로 넘긴다` | 브라우저 | ✅ |
| 다 만들면 다섯 모듈이 켜진 가상 회사다 | `demo.spec.mjs › 가상 회사를 만들면 묶음으로 보내며 진행을 보여 주고, 오류와 시간 제한을 스스로 넘긴다`<br>`demo.test.mjs › a short company runs through every stage with nothing stuck` | SQL, 브라우저 | ✅ |
| 가상 회사는 실제 명령으로 만들어져 숫자가 맞는다 | `demo.test.mjs › a short company runs through every stage with nothing stuck`<br>`demo.test.mjs › the books, the stock and the history add up` | SQL | ✅ |
| 고칠 수 없는 오류는 다시 시도하고 탭을 닫아도 이어 간다 | `demo.spec.mjs › 고칠 수 없는 오류는 보여 주고 다시 시도할 수 있으며, 탭을 닫았다 와도 이어서 만든다` | 브라우저 | ✅ |
| 중간에 멈춘 회사는 관리자에게 알리고 거기까지로 끝낼 수 있다 | `demo.spec.mjs › 중간에 멈춘 회사는 관리자에게 알리고, 여기까지만 만들고 둘러볼 수 있다` | 브라우저 | ✅ |
| 실제 회사에는 가상 회사 표시도 데모 코드도 없다 | `demo.spec.mjs › 실제 회사로 시작하면 가상 회사 표시도 데모 코드도 없고, 일반 쓰기는 같은 오류를 한 번 스스로 넘긴다` | 브라우저 | ✅ |
| 열기 전에는 단계를 넣을 수 없고 관리자만 연다 | `demo.test.mjs › steps are refused until the demo is opened, and only an admin can open it` | SQL | ✅ |
| 업무 데이터가 있는 회사는 가상 회사가 될 수 없다 | `demo.test.mjs › a company with real work cannot be turned into a demo, and steps are refused once it closes` | SQL | ✅ |

- 「한도의 80% 를 넘으면 경고한다」: 시험이 없다. 사용량 화면의 조건과 문구를 앱 코드에서 확인했다.
- `demo.spec.mjs` 는 시험 시간을 줄이려고 짧은 이야기(`erp.demo.stages`)로 돈다. 3년치 전체는 브라우저 시험에서 만들지 않는다.
- 「다 만들면…」: 첫 이벤트 날짜는 브라우저 시험이 확인하고, 회사 이름과 표시도 같은 시험이 확인한다.
