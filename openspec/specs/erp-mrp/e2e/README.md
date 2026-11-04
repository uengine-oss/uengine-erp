# E2E — erp-mrp

자재 명세, 제조 지시, 재고 반영, 원가, 전표, 되돌리기, 사가, MCP, 모델을 실제 설치 SQL 위에서 실제 재고 모듈과 함께 확인하고, 화면으로는 S15 를 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 열린 목록에서 고른다). `mrp.test.mjs` 의 사가 시험은 지울 수 없는 문서로 시험용 유형을 쓴다. 실제 청구서의 보상은 그 모듈이 정한다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/mrp.test.mjs test/isolation.test.mjs test/rebuild-gl.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && npm --prefix web run build && lockf /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/mrp.spec.mjs
lockf /tmp/uengine-erp-e2e.lock bash -c 'node scripts/reset-local.mjs && node scripts/install-local.mjs 코드 && SETUP_CODE=코드 node --test test/api.e2e.mjs'
```

실행 환경: SQL 시험은 Supabase 로컬 스택(db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

`plpgsql_check` 의 `pldbgapi2 ... call stack` 은 다른 시험과 함께 돌 때 드물게 나는 알려진 오류다. 한 파일 안의 연결이 하나라서 그 뒤의 시험이 함께 실패한다. 그 파일만 다시 돌려 확인한다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 재고 없이는 켤 수 없다 | `mrp.test.mjs › it starts off, needs stock on, and comes and goes with its menu and commands`<br>`mrp.test.mjs › a company with no stock module among those it asks for cannot get manufacturing at the start either`<br>`isolation.test.mjs › with stock off, manufacturing cannot start; without manufacturing, stock works and the rule has no say in making`<br>`mrp.spec.mjs › S15-0. 제조를 켜기 전` | SQL, 브라우저 | ✅ |
| 끄면 막히고 데이터는 남는다 | `mrp.test.mjs › it starts off, needs stock on, and comes and goes with its menu and commands`<br>`mrp.test.mjs › manufacturing turned off: stock and its records stay, and rules set to make wait until it is back`<br>`mrp.spec.mjs › S15-11. 제조를 꺼도 기록과 이력은 남고 다시 켜면 돌아온다` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › manufacturing beside [...]` 6개 | SQL | ✅ |
| 한쪽이 다른 쪽을 부르면 시험이 실패한다 | `isolation.test.mjs › mrp does not reach into other modules`<br>`isolation.test.mjs › inventory does not reach into other modules`<br>`isolation.test.mjs › manufacturing writes no stock document and no stock total: what it has to say is in its events`<br>`isolation.test.mjs › stock does not know manufacturing: it hears three event names, and carries one word it does not read` | SQL | ✅ |
| 만들 수 없는 것을 말해 준다 | `mrp.test.mjs › what cannot be built is refused and says why`<br>`mrp.spec.mjs › S15-1. 오제조가 자재 명세를 만든다` | SQL, 브라우저 | ✅ |
| 바꾼 줄만 기록하고 열린 지시는 그대로다 | `mrp.test.mjs › changing a bill records the rows that changed and leaves open orders as they were` | SQL | ✅ |
| 여러 명세 | `mrp.test.mjs › the first of several bills goes by its order, and one put away is no longer offered`<br>`mrp.test.mjs › changing a bill records the rows that changed and leaves open orders as they were` | SQL | ✅ |
| 순환의 경로를 말한다 | `mrp.test.mjs › a loop is refused at any depth, in either direction, also when an old bill comes back`<br>`mrp.spec.mjs › S15-1. 오제조가 자재 명세를 만든다` | SQL, 브라우저 | ✅ |
| 동시에 닫아도 하나만 통과한다 | `mrp.test.mjs › two people closing a loop at the same moment cannot both succeed` | SQL | ✅ |
| 단계 펼치기 | `mrp.test.mjs › reading every level shows semi-finished parts and what a level costs` | SQL | ◐ |
| 명세 비율과 단위 | `mrp.test.mjs › a draft works out its parts from the bill, in the bill's proportions and each part's unit` | SQL | ✅ |
| 폼이 자재를 보여 주고 직접 고친 값을 지킨다 | `mrp.test.mjs › the form's preview shows the parts, follows what moved, and keeps rows someone typed until then`<br>`mrp.spec.mjs › S15-2. 제조 지시` | SQL, 브라우저 | ✅ |
| 정해진 길로만 움직인다 | `mrp.test.mjs › the states go one way, and only a draft changes freely`<br>`mrp.test.mjs › an order with nothing to use cannot be confirmed, and what cannot be made is refused at confirming too` | SQL | ✅ |
| 역할이 없으면 읽기만 한다 | `mrp.test.mjs › only manufacturing people run orders; others read them`<br>`mrp.test.mjs › only manufacturing people write bills; every member reads them`<br>`mrp.spec.mjs › S15-9. 제조 역할이 없는 사람은 읽기만 한다` | SQL, 브라우저 | ✅ |
| 부족이 보이고 완료하면 음수가 된다 | `mrp.test.mjs › short of parts: confirming, starting and finishing are not stopped, and stock goes negative the way any move would`<br>`mrp.spec.mjs › S15-2. 제조 지시`<br>`mrp.spec.mjs › S15-3. 실제 사용량을 적어 완료하면 물어보고`<br>`mrp.spec.mjs › S15-3a. 이재고의 재고 화면` | SQL, 브라우저 | ✅ |
| 다른 전표의 예약은 재고 규칙을 따른다 | `mrp.test.mjs › finishing takes parts another slip had reserved: that reservation gives way, as it does for any other move` | SQL | ✅ |
| 묻고 받는다 | `mrp.test.mjs › what was really used: the bill decides whether a difference is asked, refused or taken`<br>`mrp.spec.mjs › S15-3. 실제 사용량을 적어 완료하면 물어보고` | SQL, 브라우저 | ✅ |
| 막는다 | `mrp.test.mjs › what was really used: the bill decides whether a difference is asked, refused or taken` | SQL | ✅ |
| 적게 만들면 남은 수량을 고른다 | `mrp.test.mjs › making less means saying what becomes of the rest, and making more needs nothing`<br>`mrp.spec.mjs › S15-3b. 계획보다 적게 만들면 남은 수량을 고른다` | SQL, 브라우저 | ✅ |
| 경계값 | `mrp.test.mjs › what was really used: the bill decides whether a difference is asked, refused or taken`<br>`mrp.test.mjs › making less means saying what becomes of the rest, and making more needs nothing` | SQL | ✅ |
| 명령은 자기 이벤트만 쓴다 | `mrp.test.mjs › finishing leaves stock to stock: nothing moves until it hears, then parts go down and goods go up on slips of its own`<br>`mrp.spec.mjs › S15-3. 실제 사용량을 적어 완료하면 물어보고` | SQL, 브라우저 | ✅ |
| 같은 이벤트가 다시 와도 한 번만 움직인다 | `mrp.test.mjs › the same event heard twice moves stock once` | SQL | ✅ |
| 다른 모듈은 자기 것으로 착각하지 않는다 | `mrp.test.mjs › sales, purchasing and analytics do not take these slips for their own` | SQL | ✅ |
| 멈춘 뒤 고친다 | `mrp.test.mjs › stock stalled: the order is finished and on record, says stock has not moved, and catches up exactly once when fixed`<br>`mrp.spec.mjs › S15-5. 재고 모듈이 멈춰도 제조 기록은 남고, 고치면 이어 간다` | SQL, 브라우저 | ✅ |
| 꺼진 동안 | `mrp.test.mjs › stock turned off: orders still finish, and turning it back on works through what piled up, or skips it if asked` | SQL | ✅ |
| 두 번 만들지 않는다 | `mrp.test.mjs › a rule set to make: no vendor needed, a draft appears, stock counts it, and asking twice does not order twice`<br>`mrp.test.mjs › a draft someone is preparing by hand is theirs, and a request heard twice makes one order`<br>`mrp.spec.mjs › S15-4. 재주문 규칙의 보충 방식을 제조로 정하면`<br>`mrp.spec.mjs › S15-4a. 오제조가 규칙이 만든 초안을 연다` | SQL, 브라우저 | ✅ |
| 명세가 없어도 요청을 잃지 않는다 | `mrp.test.mjs › no bill yet: the request is not lost, the draft waits and says so` | SQL | ✅ |
| 구매로 남겨 둔 규칙은 그대로다 | `mrp.test.mjs › a rule left on buying goes to purchasing as before, and manufacturing does not touch it`<br>`mrp.test.mjs › a make rule with purchasing off and on: a vendor on the rule does not reach purchasing` | SQL | ✅ |
| 자재의 규칙이 제때 반응한다 | `mrp.test.mjs › confirmed orders speak for their parts, so a rule on a part asks in time and the sum comes back when it is done` | SQL | ✅ |
| 평균 | `mrp.test.mjs › average goods come in at what their parts cost, and their average moves as with any receipt`<br>`mrp.spec.mjs › S15-3. 실제 사용량을 적어 완료하면 물어보고` | SQL, 브라우저 | ✅ |
| 표준과 단위 | `mrp.test.mjs › standard goods stay at their standard however the parts came out`<br>`mrp.test.mjs › a unit other than the product's own still costs per the product's own` | SQL | ✅ |
| 재공품은 0 으로 끝난다 | `mrp.test.mjs › parts through work in progress into goods, ending at nothing in progress`<br>`mrp.test.mjs › a standard that differs from what went in lands on the variance account, not in progress`<br>`mrp.test.mjs › rounding in whole won still leaves nothing in progress`<br>`rebuild-gl.test.mjs › the trial balance is exactly the same however late accounting was turned on`<br>`mrp.spec.mjs › S15-7. 회계를 나중에 켜도` | SQL, 브라우저 | ✅ |
| 늦게 켜도 같다 | `mrp.test.mjs › books turned on late come out the same as books on from the start`<br>`rebuild-gl.test.mjs › the trial balance is exactly the same however late accounting was turned on` | SQL | ✅ |
| 재고가 늦게 들어도 날짜는 그날이다 | `mrp.test.mjs › the entries are dated the day the work finished, also when stock heard it later` | SQL | ✅ |
| 함께 돌아간다 | `mrp.test.mjs › rolling back a finished order takes stock, cost, slips and books back with it, and the ledger keeps all of it`<br>`mrp.spec.mjs › S15-6. 되돌리면 재고도 함께 돌아가고` | SQL, 브라우저 | ✅ |
| 재고가 듣기 전 | `mrp.test.mjs › undone before stock heard: stock never moves, and the bus skips it` | SQL | ✅ |
| 이미 팔렸다 | `mrp.test.mjs › the goods have been sold: stock would go negative, so the undo is refused and says which goods`<br>`mrp.spec.mjs › S15-6. 되돌리면 재고도 함께 돌아가고` | SQL, 브라우저 | ✅ |
| 확정만 되돌린다 | `mrp.test.mjs › undoing only the confirmation takes the plan back out of what stock counts` | SQL | ✅ |
| 상쇄 | `mrp.test.mjs › a posted bill in the same saga cannot be erased: finished work is offset through stock, and the ledger shows both`<br>`mrp.test.mjs › standard goods offset by a saga leave the variance account where it started` | SQL | ✅ |
| 막힘 | `mrp.test.mjs › the goods sold in the meantime: the saga is blocked whole with the reason, even with something to offset` | SQL | ✅ |
| 직접 부르면 | `mrp.test.mjs › the compensate command on its own is refused for finished work, and just cancels work not yet done` | SQL | ✅ |
| 에이전트가 끝까지 한다 | `mrp.test.mjs › bills and orders are among the types, the schema says what can be done, and rules come back as answers`<br>`mrp.test.mjs › an agent makes a bill and an order and finishes it, step by step, under one saga`<br>`api.e2e.mjs › Manufacturing over real HTTP: an agent with a key builds and finishes, pg_cron moves the stock, and a role is a role` | SQL, HTTP | ✅ |
| 역할이 없으면 | `mrp.test.mjs › someone without the role reads but cannot write, whichever tool they use`<br>`api.e2e.mjs › Manufacturing over real HTTP: an agent with a key builds and finishes, pg_cron moves the stock, and a role is a role` | SQL, HTTP | ✅ |
| 상태 | `mrp.test.mjs › locked, then short of evidence, and each says what it waits for`<br>`mrp.test.mjs › undone work is not evidence, offset work neither, and looking back sees what was known then`<br>`mrp.spec.mjs › S15-0. 제조를 켜기 전`<br>`mrp.spec.mjs › S15-8. 지시가 쌓이면` | SQL, 브라우저 | ✅ |
| 실측 제조 기간 | `mrp.test.mjs › with enough orders finished: how long making really takes, by product`<br>`mrp.spec.mjs › S15-8. 지시가 쌓이면` | SQL, 브라우저 | ✅ |
| 자재 소요 | `mrp.test.mjs › parts forecast: what is spoken for is certain, and the usual weeks come with a range`<br>`mrp.spec.mjs › S15-8. 지시가 쌓이면` | SQL, 브라우저 | ✅ |
| 생산량 변경 | `mrp.test.mjs › what-if: making more runs parts out sooner, by what was really used; making the same shows no effect; nothing is written`<br>`mrp.spec.mjs › S15-8. 지시가 쌓이면` | SQL, 브라우저 | ✅ |
| 모듈을 끄면 | `mrp.test.mjs › with the module off: history still answers, stale says so, and what needs today's stock locks`<br>`mrp.spec.mjs › S15-11. 제조를 꺼도 기록과 이력은 남고 다시 켜면 돌아온다` | SQL, 브라우저 | ✅ |
| 같은 수치 | `mrp.test.mjs › the story has its own stream: without the stage nothing changes, and every other step stays what it was`<br>`mrp.test.mjs › on a real database, with making added: sales and the stock of what was already sold come out the same, and profit too`<br>`hr.test.mjs › the demo: leaving the people out gives back, step for step, the story the tutorials quote` | SQL | ✅ |

**단계 펼치기 ◐:** SQL 함수의 답을 확인했고, 화면의 단계 표는 시나리오에 반제품이 없어 브라우저로 밟지 않았다.

화면 전용 확인: `mrp.spec.mjs › S15-10. 지시 화면은 작은 화면과 어두운 테마에서도 읽힌다`.

시험으로 재지 않은 것: 큰 BOM(수백 줄)의 속도, 실제 회사에서 제조 기간·자재 소요의 정확도. 근거 10건은 측정이 아니라 판단이다.
