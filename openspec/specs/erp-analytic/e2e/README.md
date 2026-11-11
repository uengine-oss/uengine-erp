# E2E — erp-analytic

분석 분배, 분석 줄, 기본 분배 규칙, 예산과 그 변경 이력을 실제 설치 SQL 위에서 확인하고, 화면으로는 S23 을 사람이 하듯 밟는다(모듈 카드로 켜고, 분석 계정과 예산을 문서 화면에서 만들고, 청구서 줄을 분배 편집 창에서 60/40 으로 나눈다). 전표는 실제 버스를 거쳐 실제 회계 모듈이 만들고, 관리회계가 그 전표를 듣는다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test --test-force-exit test/analytic.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
npm --prefix web run build
source scripts/local-env.sh && lockf -t 1500 /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/analytic.spec.mjs
```

결과: `results/sql.txt`(`analytic.test.mjs` 16), `results/isolation.txt`(`isolation.test.mjs` 159), `results/browser.txt`(`analytic.spec.mjs` 6).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 켜기 전에는 막히고 칸이 없다 | `analytic.test.mjs › S23. it starts off, needs accounting, and the field appears on documents only while it is on`<br>`analytic.spec.mjs › S23-0.` | SQL, 브라우저 | ✅ |
| 회계가 먼저다 | `analytic.test.mjs › S23. it starts off, needs accounting, …` | SQL | ✅ |
| 켜는 창이 과거를 말한다 | `analytic.spec.mjs › S23-0.` | 브라우저 | ✅ |
| 모듈 경계 | `isolation.test.mjs › analytic does not reach into other modules`, `… accounting/invoicing/expense does not reach into other modules`<br>`analytic.test.mjs › S23. it starts off, …`(구독 이벤트 둘) | SQL | ✅ |
| 분배의 경계 | `analytic.test.mjs › a distribution: each plan adds up to exactly 100, on every document that has one`(`analytic-cases.json` 17개 × 청구서 줄·수동 전표 줄·규칙) | SQL | ✅ |
| 한 줄을 60/40 으로 | `analytic.test.mjs › S23. bills and invoices give each department its share; …`<br>`analytic.spec.mjs › S23-2.` | SQL, 브라우저 | ✅ |
| 분석 계정별 손익 | `analytic.test.mjs › S23. bills and invoices give each department its share; …`<br>`analytic.spec.mjs › S23-2.` | SQL, 브라우저 | ✅ |
| 정정은 반대 줄로 | `analytic.test.mjs › S23. credit notes, back to draft, cancel and a second delivery: …` | SQL | ✅ |
| 수동 전표와 역분개 | `analytic.test.mjs › hand-written entries: a distribution on any line, …` | SQL | ✅ |
| 두 번 전달돼도 한 번 | `analytic.test.mjs › S23. credit notes, back to draft, cancel and a second delivery: …` | SQL | ✅ |
| 되돌리면 함께 돌아간다 | `analytic.test.mjs › an expense claim: its distribution goes to cost on approval; …` | SQL | ✅ |
| 원장에서 다시 만든다 | `analytic.test.mjs › rebuilt from the ledger the lines are the same, …` | SQL | ✅ |
| 시점 보기 | `analytic.test.mjs › rebuilt from the ledger the lines are the same, and the report at an earlier moment shows that moment` | SQL | ◐ 화면의 시점 보기로는 돌리지 않았다(같은 함수에 시각을 넘긴다) |
| 계획마다 다른 규칙 | `analytic.test.mjs › default rules: each plan takes the first rule that fits; …`, `… a product rule fits the product and every product under its category` | SQL | ✅ |
| 규칙을 나중에 고쳐도 지난 줄은 그대로 | `analytic.test.mjs › default rules: …` | SQL | ✅ |
| 줄에 적으면 그것이 전부다 | `analytic.test.mjs › default rules: …` | SQL | ✅ |
| 줄의 경계 | `analytic.test.mjs › budget lines: a month, a range of account codes, and the boundaries of over-budget` | SQL | ✅ |
| 확정하면 고칠 수 없다 | `analytic.test.mjs › S23. a budget is planned, confirmed, …` | SQL | ✅ |
| 예산 변경 | `analytic.test.mjs › S23. a budget is planned, confirmed, …`<br>`analytic.spec.mjs › S23-3.` | SQL, 브라우저 | ✅ |
| 변경을 되돌리면 | `analytic.test.mjs › S23. a budget is planned, confirmed, …` | SQL | ✅ |
| 마감하면 끝이다 | `analytic.test.mjs › S23. a budget is planned, confirmed, …` | SQL | ✅ |
| 넘은 것과 꼭 맞은 것 | `analytic.test.mjs › S23. a budget is planned, confirmed, …`<br>`analytic.spec.mjs › S23-3.` | SQL, 브라우저 | ✅ |
| 초과의 경계 | `analytic.test.mjs › budget lines: …`(`analytic-cases.json` budget 5개) | SQL | ✅ |
| 달과 계정 범위 | `analytic.test.mjs › budget lines: …` | SQL | ✅ |
| 그때의 예산 | `analytic.test.mjs › S23. a budget is planned, confirmed, …` | SQL | ✅ |
| 넘기는 청구서 | `analytic.spec.mjs › S23-4.`<br>`analytic.test.mjs › a soft warning before a cost goes over: …` | 브라우저, SQL | ✅ |
| 꼭 계획까지 | `analytic.test.mjs › a soft warning before a cost goes over: …` | SQL | ✅ |
| 회계가 아닌 사람 | `analytic.test.mjs › a soft warning before a cost goes over: …` | SQL | ◐ 경비 승인 화면에서 팀장으로는 돌리지 않았다 |
| 조회 역할 | `analytic.test.mjs › only accounting and admin read the reports and budgets; …`<br>`analytic.spec.mjs › S23-5.` | SQL, 브라우저 | ✅ |
| 고칠 수 없는 것 | `analytic.test.mjs › only accounting and admin read the reports and budgets; …` | SQL | ✅ |
| 마케팅 예산 | `analytic.test.mjs › MCP: an agent reads accounts and lines, makes and revises a budget with a reason, and asks how much is left` | SQL | ✅ |
| 사유 없는 변경 | `analytic.test.mjs › MCP: …` | SQL | ✅ |
| 회계가 아닌 구성원의 에이전트 | `analytic.test.mjs › MCP: …` | SQL | ✅ |
| 늦게 켠 회사 | `analytic.test.mjs › M6, M7: turned on late, the past has no lines; …` | SQL | ✅ |
| 껐다 켠다 | `analytic.test.mjs › M6, M7: …` | SQL | ✅ |
| 다시 설치 | `analytic.test.mjs › installing again changes nothing`, `install-parts.test.mjs` | SQL | ✅ |

## 바꾼 이웃 모듈의 회귀

청구(줄 사실에 분배), 회계(전표 줄에 분배와 제품, 수동 전표 게시에 `reversal_of`·`kind`, 수동 전표 줄 칸), 경비(칸과 사실), 커널 칸 유형 `distribution`(`clean_value`, REST 뷰, 표 가져오기), MCP(`erp_read {budget}`)를 고쳤다. 돌린 파일: `invoicing`, `accounting`, `rebuild-gl`, `books`, `voucher`, `expense`, `expense-privacy`, `master`, `import`, `api`, `event-labels`, `install-parts`, `isolation`, `krtax`, `saga`, `history`, `assets`, `process-log`, `read-models`, `tax-parity`, `bank`, `review-fixes`, `line-preview`, `event-log`, `payroll`. 함께 돌릴 때 `pldbgapi2` 오류 1, 시간 한도 1(`master`), 읽기 모델 6이 떨어졌고 그 파일만 다시 돌리면 모두 통과했다(다른 작업과 같은 VM 을 쓴 탓으로 본다).
