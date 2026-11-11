# E2E — erp-helpdesk

팀과 배정, SLA 정책과 기한, 위반 이벤트, 대화와 단계, 고객 링크, 연락처, 다른 모듈과의 칸, MCP, 분석과 프로세스 마이닝을 실제 설치 SQL 위에서 확인하고, 화면으로는 S26 을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 고객은 로그인 없는 다른 창에서 링크를 연다). 기한의 경계는 `test/helpdesk-cases.json` 의 사례마다 시험 하나가 돈다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/helpdesk.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && npm --prefix web run build && lockf -t 1500 /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/helpdesk.spec.mjs
```

이 판의 출력은 `results/` 에 있다. `sql-helpdesk.txt`(43 통과), `sql-related.txt`(헬프데스크가 손댄 공유 파일을 쓰는 시험 9개 파일, 269 중 268 통과. 떨어진 하나는 로컬 Postgres 의 디버거 확장 `pldbgapi2` 가 설치 중에 낸 오류이고 `sql-crm-rerun.txt` 에서 그 파일만 다시 돌려 20 모두 통과), `browser.txt`(헬프데스크, 프로세스 마이닝 로그, 모듈 화면 29 통과).

## 시나리오 ↔ 시험

`case:` 는 `helpdesk.test.mjs › case: <사례 이름>` 이다.

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 다른 모듈 없는 회사 | `helpdesk.test.mjs › S26. it starts off, needs nothing else, hears nobody, and works with no other module` | SQL | ✅ |
| 켜기 전에는 막힌다 | `helpdesk.test.mjs › S26. it starts off, needs nothing else, hears nobody, and works with no other module`<br>`helpdesk.spec.mjs › S26-0.` | SQL, 브라우저 | ✅ |
| 다른 모듈에 손대지 않는다 | `isolation.test.mjs › helpdesk does not reach into other modules`<br>`isolation.test.mjs › nobody else reads or writes what a module keeps outside the ledger` | SQL | ✅ |
| 조회 역할 | `helpdesk.test.mjs › only helpdesk and admin write; every member reads tickets, nobody else the contact`<br>`helpdesk.spec.mjs › S26-9.` | SQL, 브라우저 | ✅ |
| 돌아가며 | `helpdesk.test.mjs › S26. round robin hands tickets out in the team's order and goes round again; an inactive member is skipped`<br>`helpdesk.spec.mjs › S26-2.`, `S26-3.` | SQL, 브라우저 | ✅ |
| 열린 티켓이 적은 사람 | `helpdesk.test.mjs › least open hands the ticket to whoever has the fewest open ones, the first in order on a tie; manual leaves it to people` | SQL | ✅ |
| 직접 맡기기 | 같은 시험 | SQL | ✅ |
| 팀이 하나뿐일 때 | 같은 시험 | SQL | ✅ |
| 값의 경계 | `helpdesk.test.mjs › edges: required fields, values and fields nobody may write, with nothing left behind by a refusal` | SQL | ✅ |
| 글의 경계 | 같은 시험 | SQL | ✅ |
| 정책의 경계 | `helpdesk.test.mjs › SLA policies: a target is needed, both are positive, the answer is not slower than the solution, and working hours read like 09:00`<br>`helpdesk.spec.mjs › S26-1.` | SQL, 브라우저 | ✅ |
| 가장 맞는 정책 | `helpdesk.test.mjs › the most specific policy wins: …`<br>`helpdesk.test.mjs › SLA policies: …`(보관) | SQL | ✅ |
| 정책을 고쳐도 판단한 티켓은 그대로다 | `helpdesk.test.mjs › the most specific policy wins: …` | SQL | ✅ |
| 근무 시간 | `case:` 근무 시간 다섯 사례 | SQL | ✅ |
| 달력 시간 | `case: 달력 시간은 주말도 센다` | SQL | ✅ |
| 우선순위 변경 | `case: 우선순위를 올리면 접수 시각부터 새 기한을 센다`<br>`case: 올린 우선순위의 기한이 이미 지났으면 그 기한으로 위반이 남는다`<br>`helpdesk.test.mjs › the most specific policy wins: …` | SQL | ✅ |
| 기한을 넘기는 대기 | `case: 고객 대기가 기한을 넘겨도 해결 시계는 멈춰 있고, 다시 시작하면 남은 시간만큼 간다` | SQL | ✅ |
| 대기 중의 첫 응답 | `case: 고객 대기 중에도 첫 응답 시계는 간다` | SQL | ✅ |
| 근무 시간 중 대기 | `case: 근무 시간: 대기한 밤은 세지 않는다` | SQL | ✅ |
| 다시 열기 | `case: 해결 뒤 다시 열면 해결 시계는 남아 있던 시간부터 간다` | SQL | ✅ |
| 정각과 1분 | `case: 첫 응답이 기한 정각에 오면 …`, `case: 기한 1분 전의 첫 응답은 …`, `case: 기한 1분 뒤에 시계가 돌면 …`<br>`helpdesk.spec.mjs › S26-6.` | SQL, 브라우저 | ✅ |
| 늦은 답장이 먼저 올 때 | `case: 시계보다 늦은 답장이 먼저 오면 답장 앞에 위반이 남는다`<br>`helpdesk.test.mjs › a breach is its own piece of work: …` | SQL | ✅ |
| 정각의 대기 | `case: 기한 정각에 고객 대기로 두면 …`, `case: 기한이 지난 뒤 고객 대기로 두면 …` | SQL | ✅ |
| 위반은 되돌리지 않는다 | `helpdesk.test.mjs › a breach is its own piece of work: …` | SQL | ✅ |
| 위반이 아닌 것 | `case: 맞는 정책이 없으면 …`, `case: 기한 전에 취소한 티켓은 …`, `case: 답장 없이 해결해도 …` | SQL | ✅ |
| cron 이 없어도 | `helpdesk.test.mjs › the minute job runs from the app's tick too, so a company without cron still gets its breaches` | SQL | ✅ |
| 4분의 1 | `case: 남은 시간이 목표의 4분의 1이면 위험이고, 1분 더 남았으면 정상이다` | SQL | ✅ |
| 화면(SLA 상자, 목록 표시) | `helpdesk.spec.mjs › S26-2.`, `S26-4.`, `S26-6.` | 브라우저 | ✅ |
| 한 티켓의 길 | `helpdesk.test.mjs › S26. a reply on a new ticket starts it and is the first response; …` | SQL | ✅ |
| 칸반 | `helpdesk.spec.mjs › S26-8.` | 브라우저 | ✅ |
| 지우기 | `helpdesk.test.mjs › only a new ticket nobody has answered can be deleted; otherwise it is cancelled` | SQL | ✅ |
| 고객이 답한다 | `helpdesk.test.mjs › S26. the customer's link: …`<br>`helpdesk.spec.mjs › S26-5.` | SQL, 브라우저 | ✅ |
| 링크의 경계 | `helpdesk.test.mjs › S26. the customer's link: …` | SQL | ◐ |
| 어디에도 값이 없다 | `helpdesk.test.mjs › the contact person stays out of the ledger, can be erased, and no door leads to them`<br>`helpdesk.spec.mjs › S26-2.`, `S26-9.` | SQL, 브라우저 | ✅ |
| 지우기와 막힘 | 같은 시험 | SQL | ✅ |
| 켜고 끄기(판매·청구 칸) | `helpdesk.test.mjs › with sales and invoicing on, a ticket names an order and an invoice; …` | SQL | ✅ |
| 끄고 켜기 | `helpdesk.test.mjs › M6, M7: turned off, commands, the link and the clock stop and the records stay; …` | SQL | ✅ |
| 에이전트가 연 티켓 | `helpdesk.test.mjs › MCP: an agent opens a ticket for a customer, reads its SLA status, replies and moves it, …`<br>`helpdesk.spec.mjs › S26-3.` | SQL, 브라우저 | ✅ |
| 말로 취소 | `helpdesk.test.mjs › saga over MCP: an agent's ticket and its moves go back by rollback, nothing to offset` | SQL | ✅ |
| 세는 법 | `helpdesk.test.mjs › SLA compliance counts decided tickets only; …` | SQL | ✅ |
| 19건과 20건 | `helpdesk.test.mjs › the SLA model: locked while off, short below 20 decided tickets, ready at 20` | SQL | ✅ |
| 화면(분석) | `helpdesk.spec.mjs › S26-6.`, `S26-7.` | 브라우저 | ✅ |
| 한 티켓의 흐름 | `helpdesk.test.mjs › process mining: the ticket notion gives one case per ticket, …`<br>`helpdesk.spec.mjs › S26-8.` | SQL, 브라우저 | ✅ |

◐ 링크의 경계: 종료된 티켓의 안내 문구는 SQL 에서 `can_comment` 가 거짓인 것만 확인했다. 그 화면은 브라우저로 열어 보지 않았다.
