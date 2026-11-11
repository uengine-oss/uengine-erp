# E2E — erp-maintenance

설비, 고장 수리, 예방 보전 계획, 제조 작업장과의 이벤트, 고장 간격과 수리 시간을 실제 설치 SQL 위에서 확인하고, 화면으로는 S25 의 설비 보전 부분을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 목록에서 고른다). 작업장의 「보전 중」은 실제 버스를 거쳐 실제 제조 모듈이 적는다. 계획은 `erp.clock` 으로 날을 옮겨 cron 과 같은 함수를 부른다.

```bash
# 저장소 루트에서
source scripts/local-env.sh && node scripts/build-sql.mjs && node --test --test-force-exit test/maintenance.test.mjs test/isolation.test.mjs test/models.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
npm --prefix web run build && lockf -t 1500 /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/maintenance.spec.mjs
```

결과: `results/maintenance.test.txt`, `results/maintenance.spec.txt`.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 제조 없는 회사 | `maintenance.test.mjs › S25. maintenance starts off, needs nothing else, hears nobody, and works with no manufacturing` | SQL | ✅ |
| 켜기 전에는 막힌다 | `maintenance.test.mjs › S25. maintenance starts off, needs nothing else, hears nobody, and works with no manufacturing`<br>`maintenance.spec.mjs › S25-0.` | SQL, 브라우저 | ✅ |
| 서로 끼어들지 않는다 | `isolation.test.mjs › maintenance does not reach into other modules`<br>`isolation.test.mjs › mrp does not reach into other modules`<br>`isolation.test.mjs › manufacturing writes no stock document and no stock total: what it has to say is in its events` | SQL | ✅ |
| 조회 역할 | `maintenance.test.mjs › S25. equipment: a number, a unique serial, the category's technician, a cost not below zero, and history keeps it from being deleted`<br>`maintenance.test.mjs › S25. a 30-day plan makes each request a week ahead, once, whoever ticks it; dates passed over are counted, not made`<br>`maintenance.spec.mjs › S25-5.` | SQL, 브라우저 | ✅ |
| 제조 담당 | `maintenance.test.mjs › S25. equipment: …`<br>`maintenance.test.mjs › S25. a work center shows 보전 중 while a machine on it is being repaired, learnt from events only, and goes back when the work ends` | SQL | ✅ |
| 설비 등록 | `maintenance.test.mjs › S25. equipment: …`<br>`maintenance.spec.mjs › S25-1.` | SQL, 브라우저 | ✅ |
| 기록이 있는 설비 | `maintenance.test.mjs › S25. equipment: …` | SQL | ✅ |
| 고장 신고와 완료 | `maintenance.test.mjs › S25. a breakdown is reported, started and finished: downtime runs from the failure, work from the start` | SQL | ✅ |
| 시각의 경계 | 같은 시험 | SQL | ✅ |
| 예방 점검 | 같은 시험 | SQL | ✅ |
| 단계 밖의 일 | 같은 시험 | SQL | ✅ |
| 폐기 | `maintenance.test.mjs › S25. a machine beyond repair: the request ends in scrap, the machine retires, its other work is called off and its plans put away` | SQL | ✅ |
| 시작하면 보전 중, 끝나면 가동 | `maintenance.test.mjs › S25. a work center shows 보전 중 …`<br>`maintenance.spec.mjs › S25-3.` | SQL, 브라우저 | ✅ |
| 한 작업장의 두 설비 | `maintenance.test.mjs › S25. a work center shows 보전 중 …` | SQL | ✅ |
| 두 번 들어도 | `maintenance.test.mjs › S25. a work center shows 보전 중 …` | SQL | ✅ |
| 제조가 멈춰도 | `maintenance.test.mjs › S25. manufacturing works without maintenance, and a stuck manufacturing listener does not stop a repair` | SQL | ✅ |
| 서로 없이 | 같은 시험 | SQL | ✅ |
| 창의 경계 | `maintenance.test.mjs › S25. a 30-day plan makes each request a week ahead, once, whoever ticks it; dates passed over are counted, not made` | SQL | ✅ |
| 몇 번을 눌러도 하나 | 같은 시험<br>`maintenance.spec.mjs › S25-2.` | SQL, 브라우저 | ✅ |
| 밀린 예정일 | 같은 시험 | SQL | ✅ |
| 되돌린 뒤 | 같은 시험 | SQL | ✅ |
| 정한 날짜 | `maintenance.test.mjs › S25. a plan on written dates, and the jobs that run it without a person` | SQL | ✅ |
| 값의 경계 | `maintenance.test.mjs › S25. a 30-day plan …` | SQL | ✅ |
| 쉬는 계획 | `maintenance.test.mjs › S25. a plan on written dates, …`<br>`maintenance.test.mjs › S25. a machine beyond repair: …` | SQL | ◐ |
| 알고 있는 값 | `maintenance.test.mjs › S25. MTBF, MTTR, the next failure and downtime by month come from the events, and say nothing about the next failure before three` | SQL | ✅ |
| 두 번까지는 말하지 않는다 | 같은 시험 | SQL | ✅ |
| 열린 고장과 지난 시점 | 같은 시험 | SQL | ✅ |
| 겹친 정지 | 같은 시험 | SQL | ✅ |
| 끄기 | `maintenance.test.mjs › M6, M7: turned off it refuses and keeps everything, and the numbers still answer from the ledger` | SQL | ✅ |
| 시작 되돌리기 | `maintenance.test.mjs › S25. undoing a start takes the work center back with it` | SQL | ✅ |
| 에이전트의 고장 접수 | `maintenance.test.mjs › MCP: an agent reports a breakdown, starts and finishes it with the rights of the member it speaks for` | SQL | ✅ |
| 계획에서 달력까지 | `maintenance.spec.mjs › S25-2.` | 브라우저 | ✅ |
| 고장 신고에서 수리 시간까지 | `maintenance.spec.mjs › S25-3.`<br>`maintenance.spec.mjs › S25-4.` | 브라우저 | ✅ |

◐ 쉬는 계획: 꺼진 모듈과 폐기한 설비의 계획(보관됨)은 시험한다. 보관만 하고 폐기하지 않은 설비의 계획이 쉬는 것은 코드를 읽어 확인했고 시험이 없다.

pg_cron 이 정말 매일 01:20 에 부르는지는 재지 않았다. 시험은 작업이 등록되었는지(`cron.job`)와 앱의 재촉이 한 시간이 지나면 부르는지를 확인한다.
