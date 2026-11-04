# E2E — erp-expense

신청, 승인, 지급, 영수증, 전표, 되돌리기를 실제 설치 SQL 위에서 확인하고, 화면으로는 S13 의 경비 부분을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 파일 창에서 고른다). 파일은 로컬 스택의 실제 Storage API 로 올라간다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/expense.test.mjs test/expense-privacy.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- tests/expense.spec.mjs
```

실행 환경: SQL 시험은 Supabase 로컬 스택(db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321) + Storage API(`supabase/config.toml` 의 `[storage] enabled = true`).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 인사 없이는 켤 수 없다 | `expense.test.mjs › S13. it starts off, cannot be turned on before people, and people cannot be turned off under it`<br>`expense.spec.mjs › S13-0. 인사 없이는 경비를 켤 수 없고, 메뉴에도 없으며 통계는 잠겨 있다` | SQL, 브라우저 | ✅ |
| 인사를 경비 아래에서 끌 수 없다 | `expense.test.mjs › S13. it starts off, cannot be turned on before people, and people cannot be turned off under it`<br>`expense.spec.mjs › S13-0.` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › back office [...]: ...` 조합<br>`isolation.test.mjs › expense does not reach into other modules` | SQL | ✅ |
| 남의 일을 대신하지 못한다 | `expense.test.mjs › nobody stands in for anyone else: not the claim, not the approval, not the payment` | SQL | ✅ |
| 직원이 연결되지 않은 계정 | `expense.test.mjs › nobody stands in for anyone else: not the claim, not the approval, not the payment` | SQL | ✅ |
| 본인 승인 | `expense.test.mjs › an admin approves what nobody else was asked to, and never their own when a manager exists` | SQL | ✅ |
| 버튼은 승인할 사람에게만 보인다 | `expense.spec.mjs › S13-1.`<br>`expense.spec.mjs › S13-3c.` | 브라우저 | ✅ |
| 퇴사자 | `expense.test.mjs › a person who has left gets no new claim, but what they filed before can still finish` | SQL | ✅ |
| 금액 경계 | `expense.test.mjs › amounts: one won is a claim, nothing and less than nothing are not, and fractions round first` | SQL | ✅ |
| 날짜 경계 | `expense.test.mjs › dates: today is the last day a claim can carry, and only real dates are dates` | SQL | ✅ |
| 회계일과 지급일 경계 | `expense.test.mjs › accounting and payment dates: the same day passes, a day either side does not` | SQL | ✅ |
| 단계는 순서대로만 간다 | `expense.test.mjs › the steps go in order and a refused or unknown field leaves nothing behind` | SQL | ✅ |
| 영수증 없이 신청 | `expense.test.mjs › S13. someone files with a receipt, their manager approves, accounting pays, and each step says what happened`<br>`expense.spec.mjs › S13-1.` | SQL, 브라우저 | ✅ |
| 파일 이름은 원장에 없다 | `expense.test.mjs › a receipt: its name and place stay out of the ledger, only its fingerprint goes in`<br>`expense.spec.mjs › S13-1.` | SQL, 브라우저 | ✅ |
| 같은 파일은 한 번만 | `expense.test.mjs › receipt edges: size, type, fingerprint, how many, and one receipt pays once`<br>`expense.spec.mjs › S13-1.` | SQL, 브라우저 | ✅ |
| 파일 경계 | `expense.test.mjs › receipt edges: size, type, fingerprint, how many, and one receipt pays once` | SQL | ✅ |
| 저장소에 없는 파일 | `expense.test.mjs › where the project has storage, a record of a file that is not there is refused` | SQL | ✅ |
| 다른 직원은 못 연다 | `expense.test.mjs › who reads a receipt: the same people who read the claim`<br>`expense.spec.mjs › S13-2.` | SQL, 브라우저 | ✅ |
| 상사는 신청된 뒤에 연다 | `expense.test.mjs › who reads a receipt: the same people who read the claim`<br>`expense.spec.mjs › S13-3.` | SQL, 브라우저 | ✅ |
| 지우기 | `expense.test.mjs › removing a receipt: free while it is your draft, after filing only accounting, and the reason stays out of the ledger` | SQL | ✅ |
| 쌍둥이 표시 | `expense.test.mjs › the same person, day and amount is put in front of the approver, and does not count once refused` | SQL | ✅ |
| 승인과 지급의 사실 | `expense.test.mjs › S13. someone files with a receipt, their manager approves, accounting pays, and each step says what happened` | SQL | ✅ |
| 승인과 지급의 전표 | `expense.test.mjs › books: approval owes the person, payment settles it, from the account the category names`<br>`expense.spec.mjs › S13-5.` | SQL, 브라우저 | ✅ |
| 나중에 켜도 같다 | `expense.test.mjs › the promise behind turning accounting on late: the same work gives the same books, whenever it comes on`<br>`expense.spec.mjs › S13-5.` | SQL, 브라우저 | ✅ |
| 회계가 고장 나도 경비는 간다 | `expense.test.mjs › a stopped accounting module never stops a claim, and catches up without loss or double entries` | SQL | ✅ |
| 취소 | `expense.test.mjs › books: cancelling a paid claim takes both entries out of their own days, and the books read as if it never was`<br>`expense.spec.mjs › S13-6.` | SQL, 브라우저 | ✅ |
| 마감한 달의 경비 | `expense.test.mjs › a closed period: approval, payment and cancelling stop at it, and a later date gets past` | SQL | ✅ |
| 말로 취소 | `expense.test.mjs › saga over MCP: an agent files, gets it approved and paid, then one word undoes it: compensation, books back to zero, a warning about the money` | SQL | ✅ |
| 지급 전 되돌리기 | `expense.test.mjs › undoing: what has not been paid goes back whole, with its entry; paid money cannot just vanish` | SQL | ✅ |
| 잠긴 사가 | `expense.test.mjs › saga: an approval nothing was paid on goes back by rollback, a claim with words on it is cancelled, and a closed period stops it and says what to do` | SQL | ✅ |
| 영수증이 남아 있다 | `expense.test.mjs › undoing past a receipt is refused until the receipt is gone, because the file does not come back with the ledger` | SQL | ✅ |
| 신청한 사람의 에이전트가 자기 일을 되돌린다 | `expense-privacy.test.mjs › the claimant's agent undoes its own work by key: cancelled, the reason kept outside, its name kept off the plan for what it may not read` | SQL | ✅ |
| 사람과 길의 표 | `expense-privacy.test.mjs › the matrix, by login: every generic read path shows each person what they may see and nothing else`<br>`expense-privacy.test.mjs › the matrix, by agent key: the same people, every way an agent can ask`<br>`expense-privacy.test.mjs › receipts: the table and storage follow the same decision`<br>`api.e2e.mjs › Back office over real HTTP` | SQL, HTTP | ✅ |
| 묻는 것으로 알 수 없다 | `expense-privacy.test.mjs › out of scope and no such claim get the same answer, whichever door, so nothing can be learned by asking` | SQL | ✅ |
| 가져오기로 맞혀 보지 못한다 | `expense-privacy.test.mjs › import: naming a key does not turn a claim someone may not read into an answer` | SQL | ✅ |
| 화면 | `expense.spec.mjs › S13-2.` | 브라우저 | ✅ |
| 원장을 찾아본다 | `expense-privacy.test.mjs › the words are in no event, no record and no reply, and the amount is in the ledger on purpose`<br>`expense-privacy.test.mjs › journal entries say the number and the kind, and only accounting reads them` | SQL | ✅ |
| 지운다 | `expense-privacy.test.mjs › erasing: the words go for good, for those who may, the ledger says only that it happened, and the claim still stands`<br>`expense.spec.mjs › S13-9.` | SQL, 브라우저 | ✅ |
| 사유 없는 명령에 사유 | `expense-privacy.test.mjs › a reason is words too: the commands that take one keep it outside, the rest refuse it` | SQL | ✅ |
| 누구의 숫자인지 말한다 | `expense-privacy.test.mjs › the trend and its model: accounting sees the company, anyone else their own share, and is told which`<br>`expense.spec.mjs › S13-7.`<br>`expense.spec.mjs › S13-8.` | SQL, 브라우저 | ✅ |
| 에이전트의 권한 | `expense.test.mjs › MCP: the agent has the rights of the member it speaks for, and no more` | SQL | ✅ |
| 세 상태 | `expense.test.mjs › stat_expense: locked until the module has been on, short until three months, then a trend by department`<br>`expense.spec.mjs › S13-0.`<br>`expense.spec.mjs › S13-7.` | SQL, 브라우저 | ✅ |
| 부서는 그때의 부서다 | `expense.test.mjs › stat_expense: locked until the module has been on, short until three months, then a trend by department` | SQL | ✅ |
| 유형 | `expense.test.mjs › categories: accounting owns them, a new company has the usual ones, a name is unique` | SQL | ✅ |
| 수치 비교 | `expense.test.mjs › the demo: its claims have their own random stream and every other step stays where it was`<br>`expense.test.mjs › the demo on a real database: claims book, and sales and stock come out to the same figures` | SQL | ✅ |
