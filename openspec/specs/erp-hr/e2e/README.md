# E2E — erp-hr

부서와 직원, 입퇴사, 이벤트 계약, 시점과 통계, 개인정보를 실제 설치 SQL 위에서 확인하고, 화면으로는 S10 을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 열린 목록에서 고른다). 개인정보 시험은 다른 곳에 없는 값을 넣고 원장, 전 표, 시점 함수, 피드, 내보내기, REST, MCP 에서 찾는다. 지우기 전에는 그 표 하나에서 찾히므로 훑기가 제대로 도는 것도 함께 확인된다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/hr.test.mjs test/isolation.test.mjs

# 브라우저와 HTTP 는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- tests/hr.spec.mjs
lockf /tmp/uengine-erp-e2e.lock bash -c 'node scripts/reset-local.mjs && node scripts/install-local.mjs 코드 && SETUP_CODE=코드 node --test test/api.e2e.mjs'
```

실행 환경: SQL 시험은 Supabase 로컬 스택(db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 켜기 전에는 막히고 켜면 열린다 | `hr.test.mjs › S10. the module starts off, needs no other module, and turning it on opens employees and departments`<br>`hr.spec.mjs › S10-0. 인사를 켜기 전: 메뉴에 없고 인원 통계는 잠겨 있으며, 켜면 다른 모듈 없이 열린다` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › people beside [...]: neither side's work touches the other` 5개<br>`isolation.test.mjs › hr does not reach into other modules`<br>`isolation.test.mjs › nobody else reads or writes the private table, and its module neither hears nor needs anyone` | SQL | ✅ |
| 영업 사원은 읽기만 한다 | `hr.test.mjs › only hr and admin write; every member reads names and departments; the private table answers only hr and admin`<br>`hr.spec.mjs › S10 권한: 영업 사원은 이름과 부서를 보되 개인정보 칸도, 등록 단추도 없고, 직접 물어도 답이 없다` | SQL, 브라우저 | ✅ |
| 사번 경계 | `hr.test.mjs › employee numbers: unique for good, numbered when left empty, and a typed number does not trip the sequence`<br>`hr.spec.mjs › S10-1. 직원을 차례로 등록한다` | SQL, 브라우저 | ✅ |
| 잘못된 값은 칸 이름으로 알려 주고 아무것도 남기지 않는다 | `hr.test.mjs › required and malformed values are refused in words a person can act on`<br>`hr.spec.mjs › S10-1. 직원을 차례로 등록한다` | SQL, 브라우저 | ✅ |
| 순환과 자기 자신을 막는다 | `hr.test.mjs › a manager cannot be yourself, cannot close a loop of any length, and cannot be someone who left`<br>`hr.spec.mjs › 상사가 순환하거나 자기 자신이면 저장하면서 막히고, 고른 칸이 어디인지 보인다` | SQL, 브라우저 | ✅ |
| 동시 요청이 규칙을 넘지 못한다 | `hr.test.mjs › two requests at once cannot make a loop or leave someone reporting to a person who has gone` | SQL | ✅ |
| 경계값 | `hr.test.mjs › departure dates: on the day of joining and on today are fine, a day either side is not` | SQL | ✅ |
| 지우지 않고 남긴다 | `hr.test.mjs › leaving is a change of state, not a deletion; the name stays on past documents and old rows stay readable`<br>`hr.spec.mjs › S10-2. 퇴사는 지우지 않고 남기며` | SQL, 브라우저 | ✅ |
| 부하가 있으면 먼저 상사를 바꾼다 | `hr.test.mjs › someone who still has people reporting to them cannot leave until those people have another manager`<br>`hr.spec.mjs › S10-2. 퇴사는 지우지 않고 남기며` | SQL, 브라우저 | ✅ |
| 사유를 말하면 거부한다 | `hr.test.mjs › a reason given in passing never carries private matters into the ledger`<br>`hr.test.mjs › departure dates: on the day of joining and on today are fine, a day either side is not`<br>`hr.spec.mjs › S10-2. 퇴사는 지우지 않고 남기며` | SQL, 브라우저 | ✅ |
| 계정은 그대로이고 화면이 알린다 | `hr.spec.mjs › 되돌리기: 관리자가 퇴사를 되돌리면 재직으로 돌아오고 인원도 돌아오며, 계정이 켜져 있으면 알려 준다` | 브라우저 | ✅ |
| 퇴사하면 연결을 내놓는다 | `hr.test.mjs › one account belongs to one person working here now, and leaving gives it up` | SQL | ✅ |
| 부서 경계 | `hr.test.mjs › departments: unique names, none archived with people in them, and old references keep them from deletion`<br>`hr.spec.mjs › S10-1. 한인사가 부서 셋을 넣고 이름이 겹치면 화면이 그렇게 말한다` | SQL, 브라우저 | ✅ |
| 계약 그대로 실린다 | `hr.test.mjs › each event carries every fact the contract names, so a subscriber never has to come back and ask`<br>`hr.spec.mjs › 이벤트 계약: 화면으로 등록한 직원의 입사 이벤트에 계약의 사실이 실리고 개인정보 칸은 없다` | SQL, 브라우저 | ✅ |
| 다음 모듈은 이벤트만으로 만들 수 있다 | `hr.test.mjs › a later module can be built from the events alone: it reads the past, keeps up, and its failure stops nobody` | SQL | ✅ |
| 입사일과 퇴사일 당일이 경계다 | `hr.test.mjs › who was here on a day goes by the dates people joined and left, and both of those days count`<br>`hr.spec.mjs › S10-3. 어느 날의 인원을 고르고 부서별로 보며, 통계 카드에서도 같은 화면으로 간다` | SQL, 브라우저 | ✅ |
| 부서는 발령일을 따른다 | `hr.test.mjs › a move counts from the date it took effect, even when it was entered later, and departments add up`<br>`hr.test.mjs › moving department without saying when counts from today; a person who never moved follows a corrected start date` | SQL | ✅ |
| 기록되기 전 시점에서 보면 아직 재직이다 | `hr.test.mjs › the moment looked from matters too: looking from before a departure was recorded, that person is still here`<br>`hr.test.mjs › the ordinary time view reads an employee and the list as they stood then`<br>`hr.spec.mjs › S10-3. 어느 날의 인원을 고르고 부서별로 보며, 통계 카드에서도 같은 화면으로 간다` | SQL, 브라우저 | ✅ |
| 달별 추이 | `hr.test.mjs › the month by month view counts joins, departures and who was left at the end, for each month`<br>`hr.spec.mjs › S10-3. 어느 날의 인원을 고르고 부서별로 보며, 통계 카드에서도 같은 화면으로 간다` | SQL, 브라우저 | ✅ |
| 정확히 3개월에 열린다 | `hr.test.mjs › the statistic is locked without the module, short with too little history, and ready at exactly three months`<br>`hr.spec.mjs › S10-0. 인사를 켜기 전`<br>`hr.spec.mjs › S10-3. 어느 날의 인원을 고르고` | SQL, 브라우저 | ✅ |
| 퇴사를 되돌리고 그것을 또 되돌린다 | `hr.test.mjs › undoing a departure puts the person back in the count and undoing that takes them out again`<br>`hr.spec.mjs › 되돌리기: 관리자가 퇴사를 되돌리면` | SQL, 브라우저 | ✅ |
| 개인정보가 남은 입사는 먼저 지워야 되돌린다 | `hr.test.mjs › undoing a hire is refused while a private row remains; once erased it goes, and the number can be used again` | SQL | ✅ |
| 끄고 다시 켠다 | `hr.test.mjs › M7. turned off: commands stop, the menu types go, history and counts stay, and it comes back with everything`<br>`hr.test.mjs › M6. turned on years in: the card says what the past cannot give back, and entering old dates counts from then`<br>`hr.spec.mjs › M7. 끄면 메뉴가 사라지고 직접 들어가도 막히지만, 통계와 이력은 남고 다시 켜면 그대로다` | SQL, 브라우저 | ✅ |
| 값은 표에만 있다 | `hr.test.mjs › private values reach the table and nothing else; the ledger hears which fields, and who`<br>`hr.test.mjs › a retried request keeps no private value in the replay table`<br>`hr.spec.mjs › S10 개인정보` | SQL, 브라우저 | ✅ |
| 권한 | `hr.test.mjs › only hr and admin write; every member reads names and departments; the private table answers only hr and admin`<br>`hr.test.mjs › no way of reading the past or the ledger shows a private value: as-of, versions, stream, correlation, feed, export`<br>`api.e2e.mjs › People over real HTTP: resources and tools appear by themselves, and private values cross no read path` | SQL, HTTP | ✅ |
| 열린 양식과 부딪히지 않는다 | `hr.test.mjs › a change to private details is not on the document's own stream, so it neither conflicts with an open form nor rolls back`<br>`hr.spec.mjs › S10 개인정보` | SQL, 브라우저 | ✅ |
| 화면이 한계를 말한다 | `hr.spec.mjs › S10 개인정보: 넣는 자리에 무엇이 남고 무엇이 지워지지 않는지 말하고, 저장해도 원장에는 값이 없다` | 브라우저 | ✅ |
| 어떤 길로도 들어가지 않는다 | `hr.test.mjs › there is no field for a resident registration number, and one typed into free text is refused without being repeated`<br>`hr.spec.mjs › S10 개인정보` | SQL, 브라우저 | ✅ |
| 지운다 | `hr.test.mjs › erasing: needs hr, needs a reason, cannot be smuggled into that reason, and leaves no value anywhere`<br>`hr.spec.mjs › 지우기: 사유 없이는 안 되고, 사유에 값을 적어도 안 되며, 지우면 값은 어디에도 없고 지웠다는 기록만 남는다` | SQL, 브라우저 | ✅ |
| 전 표를 훑어도 없다 | `hr.test.mjs › after erasing in a company of its own, a scan of every table finds no value at all`<br>`hr.test.mjs › a rebuild leaves the private table alone, and neither restores nor loses what is in it` | SQL | ✅ |
| 지우기는 되돌리지 못한다 | `hr.test.mjs › a change to private details is not on the document's own stream, so it neither conflicts with an open form nor rolls back` | SQL | ✅ |
| 시점과 피드 | `hr.test.mjs › no way of reading the past or the ledger shows a private value: as-of, versions, stream, correlation, feed, export`<br>`api.e2e.mjs › People over real HTTP` | SQL, HTTP | ✅ |
| MCP 와 REST | `hr.test.mjs › MCP: an agent can set and erase what it is allowed to, but no read tool ever shows it a private value, not even an admin's`<br>`hr.test.mjs › REST: the resources exist without any hand-written API, follow the same rules, and hold no private column`<br>`api.e2e.mjs › People over real HTTP` | SQL, HTTP | ✅ |
| REST | `hr.test.mjs › REST: the resources exist without any hand-written API, follow the same rules, and hold no private column`<br>`api.e2e.mjs › People over real HTTP` | SQL, HTTP | ✅ |
| MCP | `hr.test.mjs › MCP: tools and resources name the new types with no change to the tools, and rules come back as answers`<br>`api.e2e.mjs › People over real HTTP` | SQL, HTTP | ✅ |
| 표 파일 | `hr.test.mjs › importing a table of staff goes through the same rules and has no way in for private fields` | SQL | ✅ |
| 단계가 바이트 단위로 같다 | `hr.test.mjs › the demo: leaving the people out gives back, step for step, the story the tutorials quote` | SQL | ✅ |
| 실제 DB 에서 수치가 같다 | `hr.test.mjs › the demo on a real database: with people added, sales, stock and books come out to the same figures` | SQL | ✅ |
| 직원만 있어도 업무 데이터로 본다 | `hr.test.mjs › a company that has employees and nothing else still cannot be turned into a demo` | SQL | ✅ |

## 시험이 확인하지 못하는 것

- 지운 값은 이 DB 의 표에서 사라진다. Supabase 의 물리 백업과 받아 둔 파일까지는 시험하지 않는다.
- 전체 3년치 데모를 실제 HTTP 로 다시 만들어 what-if 수치를 비교하지는 않았다. 생성기 단계가 해시로 같고, 짧은 단계의 실제 DB 수치가 같은 것으로 확인했다.
