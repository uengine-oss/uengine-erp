# E2E — erp-payroll

급여 대장, 명세서, 전표, 이체 파일, 원천세, 4대보험 자료를 실제 설치 SQL 위에서 확인하고, 화면으로는 S17 을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 파일을 실제로 내려받는다). 금액 시험은 별표 2 를 옮긴 시험 자료와 손 계산을 대조한다. 민감 정보 시험은 다른 곳에 없는 값을 넣고 전 표와 읽는 길을 모두 훑는다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/payroll.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
npm --prefix web run build
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs tests/payroll.spec.mjs
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 인사 없이는 켜지 않는다 | `payroll.test.mjs › S17. it starts off, cannot be turned on without people`<br>`payroll.spec.mjs › S17-0. 인사 없이는 켜지 않고` | SQL, 브라우저 | ✅ |
| 나중에 켜면 이미 있는 직원이 보인다 | `payroll.test.mjs › S17. it starts off`<br>`payroll.spec.mjs › S17-0. 직원은 인사에서 온다` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › payroll beside [...]` 5개<br>`isolation.test.mjs › payroll does not reach into other modules`<br>`isolation.test.mjs › what one person earns stays inside payroll` | SQL | ✅ |
| 자료가 없으면 확정되지 않는다 | `payroll.test.mjs › the product ships no rate and no table` | SQL | ✅ |
| 세액표를 파일로 넣는다 | `payroll.test.mjs › a table that does not join up`<br>`payroll.spec.mjs › S17-2. 요율과 세액표를 출처와 함께 넣는다` | SQL, 브라우저 | ✅ |
| 대장이 자료의 이름과 출처를 보여 준다 | `payroll.test.mjs › S17. one register, worked by hand`<br>`payroll.spec.mjs › S17-3. 대장을 만들면`<br>`payroll.spec.mjs › S17-2. 효력이 있는 자료가 없는 달은` | SQL, 브라우저 | ✅ |
| 한 대장을 손으로 계산한다 | `payroll.test.mjs › S17. one register, worked by hand`<br>`payroll.spec.mjs › S17-3. 대장을 만들면` | SQL, 브라우저 | ✅ |
| 자녀 공제로 음수가 되면 0 이다 | `payroll.test.mjs › S17. one register, worked by hand`<br>`payroll.spec.mjs › S17-3. 대장을 만들면` | SQL, 브라우저 | ✅ |
| 세액표의 경계와 공식 | `payroll.test.mjs › income tax: the table, the children` | SQL | ✅ |
| 4대보험의 경계 | `payroll.test.mjs › premiums: the agency example` | SQL | ✅ |
| 비과세 한도를 넘으면 과세한다 | `payroll.test.mjs › non-taxable above its limit is taxed` | SQL | ✅ |
| 월 중 입사와 퇴사 | `payroll.test.mjs › joining or leaving partway through a month`<br>`payroll.spec.mjs › S17-3. 대장을 만들면` | SQL, 브라우저 | ✅ |
| 일용근로와 상여 | `payroll.test.mjs › a day worker or a final settlement`<br>`payroll.test.mjs › a bonus is not looked up in the monthly table` | SQL | ✅ |
| 초과근무 | `payroll.test.mjs › closed attendance fills the hours` | SQL | ✅ |
| 고치고 다시 계산하고 비운다 | `payroll.test.mjs › a cell a person changes is marked`<br>`payroll.test.mjs › while a run is a draft`<br>`payroll.spec.mjs › S17-3. 대장을 만들면` | SQL, 브라우저 | ✅ |
| 요율이 바뀐다 | `payroll.test.mjs › S17. the data in force is picked by date`<br>`payroll.spec.mjs › S17-3. 확정하면 명세서가 나가고` | SQL, 브라우저 | ✅ |
| 고유한 값을 넣고 찾는다 | `payroll.test.mjs › S17. one person's pay, account and family reach their own tables` | SQL | ✅ |
| 초안의 합계를 쓰지 않는다 | `payroll.test.mjs › while a run is a draft` | SQL | ✅ |
| 사유로 새지 않는다 | `payroll.test.mjs › a reason given in passing carries no amount` | SQL | ✅ |
| 본인과 타인 | `payroll.test.mjs › a person reads their own confirmed slip`<br>`payroll.spec.mjs › S17-8. 직원은 자기 명세서만 본다`<br>`payroll.spec.mjs › S17-8. 계정만 있고` | SQL, 브라우저 | ✅ |
| 계정이 바뀌면 따라간다 | `payroll.test.mjs › a person reads their own confirmed slip` | SQL | ✅ |
| 계좌 칸에 주민등록번호 | `payroll.test.mjs › a registration number has no field anywhere`<br>`payroll.spec.mjs › S17-2. 직원별 금액과 계좌` | SQL, 브라우저 | ✅ |
| 지운다 | `payroll.test.mjs › profile: the ledger hears which fields`<br>`payroll.test.mjs › a slip can be erased` | SQL | ✅ |
| 확정과 지급 | `payroll.test.mjs › S17. confirming books wages`<br>`payroll.spec.mjs › S17-5. 이체 파일은` | SQL, 브라우저 | ✅ |
| 회계를 언제 켜도 시산표가 같다 | `payroll.test.mjs › accounting turned on from the start`<br>`payroll.spec.mjs › S17-4. 회계를 나중에 켜도` | SQL, 브라우저 | ✅ |
| 항목의 계정 | `payroll.test.mjs › an item names its account` | SQL | ✅ |
| 회계가 꺼져 있다 | `payroll.test.mjs › with accounting off nothing waits` | SQL | ✅ |
| 내려받기 | `payroll.test.mjs › S17. the app moves no money`<br>`payroll.spec.mjs › S17-5. 이체 파일은` | SQL, 브라우저 | ✅ |
| 지급 완료 | `payroll.test.mjs › S17. confirming books wages`<br>`payroll.spec.mjs › S17-5. 이체 파일은` | SQL, 브라우저 | ✅ |
| 정정한다 | `payroll.test.mjs › a confirmed register stays`<br>`payroll.spec.mjs › S17-6. 마감을 해제하면` | SQL, 브라우저 | ✅ |
| 닫힌 기간 | `payroll.test.mjs › a closed period holds` | SQL | ✅ |
| 귀속월마다 정기 대장 하나 | `payroll.test.mjs › only one regular register a month` | SQL | ✅ |
| 에이전트가 확정하고 지급한 대장을 되돌린다 | `payroll.test.mjs › S18 for payroll` | SQL | ✅ |
| 초안만 있던 사가 | `payroll.test.mjs › a draft in a saga goes by the same road` | SQL | ✅ |
| 마감한 달 | `payroll.test.mjs › what a filed month holds stops a saga` | SQL | ✅ |
| 코드와 귀속 월 | `payroll.test.mjs › S17. the month paid gives the form's figures`<br>`payroll.spec.mjs › S17-6. 원천세` | SQL, 브라우저 | ✅ |
| 인원을 두 번 세지 않는다 | `payroll.test.mjs › S17. the month paid gives the form's figures` | SQL | ✅ |
| 줄을 누르면 대장 | `payroll.test.mjs › S17. the month paid gives the form's figures`<br>`payroll.spec.mjs › S17-6. 원천세` | SQL, 브라우저 | ✅ |
| 마감과 해제 | `payroll.test.mjs › closing a month leaves WithholdingFiled`<br>`payroll.test.mjs › closing a month and confirming into it cannot pass each other`<br>`payroll.spec.mjs › S17-6. 원천세`<br>`payroll.spec.mjs › S17-6. 마감을 해제하면` | SQL, 브라우저 | ✅ |
| 목록 | `payroll.test.mjs › S17. who joined and who left in a period`<br>`payroll.spec.mjs › S17-7. 4대보험 자료` | SQL, 브라우저 | ✅ |
| 세 상태 | `payroll.test.mjs › S13. labour cost`<br>`payroll.spec.mjs › S17-0. 인사 없이는`<br>`payroll.spec.mjs › S13. 인건비 전망: 근거가 모자라면`<br>`payroll.spec.mjs › S13. 인건비 전망: 3개월이 쌓이면` | SQL, 브라우저 | ✅ |
| 인원 증감 | `payroll.test.mjs › S13. labour cost`<br>`payroll.spec.mjs › S13. 인건비 전망: 3개월이 쌓이면` | SQL, 브라우저 | ✅ |
| 모듈을 꺼도 답한다 | `payroll.test.mjs › S13. labour cost` | SQL | ✅ |
| 끄고 켠다 | `payroll.test.mjs › M7. off: commands stop` | SQL | ✅ |
| 구독자 장애 | `payroll.test.mjs › a broken subscriber stops only itself` | SQL | ✅ |
| 항목 지우기 | `payroll.test.mjs › an item in use is not deleted` | SQL | ✅ |
| REST | `payroll.test.mjs › REST: a run takes the same road` | SQL | ✅ |

## 시험하지 않는 것

- **세법의 옳고 그름.** 시험은 코드가 근거 문서대로 계산하는지 본다. 근거 해석은 전문가 검수가 필요하다.
- **실제 은행, 홈택스, 위택스, 4대사회보험 정보연계센터.** 앱이 그쪽으로 아무것도 보내지 않고, 내보낸 파일을 그쪽이 받는지도 확인하지 않았다.
- **근태 모듈과 맞물린 실제 흐름.** `AttendanceClosed` 는 시험이 직접 낸다. 근태 모듈이 합쳐지면 필드 이름을 맞추고 다시 돌린다.
