# E2E — erp-project

프로젝트, 작업, 시간, 서비스 주문, 모델을 실제 설치 SQL 위에서 확인하고, 화면으로는 S14 의 프로젝트 부분을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 열린 목록에서 고른다). 서비스 주문은 실제 버스를 거친다. 근태 이벤트는 근태 모듈 계약대로 시험이 직접 쓴다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/project.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- tests/project.spec.mjs
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 켜기 전과 켠 뒤 | `project.test.mjs › S14. it starts off, needs nothing else, and the role can be given`<br>`project.spec.mjs › S14-P0.` | SQL, 브라우저 | ✅ |
| 처음부터 끝까지 | `project.test.mjs › S14. a project, its tasks moving through stages, and hours on them, with no other module on`<br>`project.spec.mjs › S14-P1.`, `S14-P2.`, `S14-P3b.` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › back office [...]` 조합<br>`isolation.test.mjs › project does not reach into other modules` | SQL | ✅ |
| 한 건만 되돌린다 | `project.test.mjs › an hour logged leaves the task's own stream alone, so undoing one entry drags nothing else with it` | SQL | ✅ |
| 인사가 꺼져 있다 | `project.test.mjs › with people off, an employee cannot be named and a member can`<br>`project.spec.mjs › S14-P1.` | SQL, 브라우저 | ✅ |
| 인사가 켜져 있다 | `project.test.mjs › with people on, work goes on an employee; named by account it still finds them; without a record the account stands`<br>`project.spec.mjs › S14-P5.` | SQL, 브라우저 | ✅ |
| 권한 | `project.test.mjs › the lead runs a project; whoever a task is on moves it and logs on it; nobody else does`<br>`project.spec.mjs › S14-P3.` | SQL, 브라우저 | ✅ |
| 시간 경계 | `project.test.mjs › hours: above nothing, up to 24, and a day has 24 across all tasks`<br>`project.spec.mjs › S14-P2.` | SQL, 브라우저 | ✅ |
| 하루 24시간 | `project.test.mjs › hours: above nothing, up to 24, and a day has 24 across all tasks`<br>`project.spec.mjs › S14-P2.` | SQL, 브라우저 | ✅ |
| 날짜 경계 | `project.test.mjs › dates: today is the last day hours can be on, and the project's dates cannot be the wrong way round`<br>`project.spec.mjs › S14-P2.` | SQL, 브라우저 | ✅ |
| 입사일과 퇴사일 | `project.test.mjs › with people on, work goes on an employee; named by account it still finds them; without a record the account stands` | SQL | ✅ |
| 프로젝트와 작업의 값 | `project.test.mjs › dates: today is the last day hours can be on, and the project's dates cannot be the wrong way round`<br>`project.spec.mjs › S14-P1.` | SQL, 브라우저 | ✅ |
| 끝나지 않은 작업 | `project.test.mjs › stages go only where they can, finished work stays finished until reopened, and a project cannot end with work open`<br>`project.spec.mjs › S14-P3b.` | SQL, 브라우저 | ✅ |
| 다시 열기 | `project.test.mjs › stages go only where they can, finished work stays finished until reopened, and a project cannot end with work open` | SQL | ✅ |
| 취소 | `project.test.mjs › cancelling a project cancels its open tasks with it, and deleting needs nothing to be there` | SQL | ✅ |
| 주문에서 프로젝트로 | `project.test.mjs › S14. a service order whose product asks for it becomes a project with a task, through the order's event`<br>`project.spec.mjs › S14-P4.` | SQL, 브라우저 | ✅ |
| 주문의 변화를 따라간다 | `project.test.mjs › the order's later events follow: a line added, a quantity changed, and cancelling, which stops at hours already worked` | SQL | ✅ |
| 주문 취소 | `project.test.mjs › the order's later events follow: a line added, a quantity changed, and cancelling, which stops at hours already worked`<br>`project.spec.mjs › S14-P4.` | SQL, 브라우저 | ✅ |
| 그때의 표시로 읽는다 | `project.test.mjs › the flag as it stood when the order was confirmed: late on reads the past the way it would have then, and only from the chosen date` | SQL | ✅ |
| 프로젝트가 멈춰도 주문은 간다 | `project.test.mjs › M5, M7: a stuck project subscriber never stops an order; turned off keeps everything and catches up as chosen` | SQL | ✅ |
| 말로 취소 | `project.test.mjs › saga over MCP: project, task and hours by an agent go back whole by rollback, nothing to offset` | SQL | ✅ |
| 모듈을 넘는 되돌리기 | `project.test.mjs › undoing a confirmation takes the project with it across the module line, and hours worked since are named and need consent` | SQL | ✅ |
| 에이전트의 권한 | `project.test.mjs › MCP: an agent has the rights of the member it speaks for` | SQL | ✅ |
| 19건과 20건 | `project.test.mjs › effort: only finished tasks with a plan and hours count; removed and undone hours do not; 19 and 20 are where it turns`<br>`project.spec.mjs › S14-P6.` | SQL, 브라우저 | ✅ |
| 사실과 모름 | `project.test.mjs › delivery risk: a date gone by is a fact; beyond that it says "unknown" until it has evidence, and then late, at risk or fine`<br>`project.spec.mjs › S14-P6.` | SQL, 브라우저 | ✅ |
| 판단 | `project.test.mjs › delivery risk: a date gone by is a fact; beyond that it says "unknown" until it has evidence, and then late, at risk or fine` | SQL | ✅ |
| 이벤트가 없다 | `project.test.mjs › attendance: compared only when its events exist, and only for those who may read them`<br>`project.spec.mjs › S14-P6.` | SQL, 브라우저 | ✅ |
| 대조 | `project.test.mjs › attendance: compared only when its events exist, and only for those who may read them` | SQL | ◐ |
| 끄고 켜기 | `project.test.mjs › M5, M7: a stuck project subscriber never stops an order; turned off keeps everything and catches up as chosen` | SQL | ✅ |
| 수치 비교 | `project.test.mjs › the demo: projects have their own random stream, and sales, stock and books come out the same` | SQL | ✅ |

◐ 대조: 근태 모듈이 이 브랜치에 없어 이벤트를 계약대로 직접 썼다. 근태 모듈과 합친 뒤 실제 이벤트로 다시 돌린다.
