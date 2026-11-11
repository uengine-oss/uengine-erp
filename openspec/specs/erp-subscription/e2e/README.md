# E2E — erp-subscription

정기 청구 제품, 주문에서 생기는 구독, 기간마다의 청구와 청구 모듈이 만드는 청구서, 변경과 일할 정산, 일시 중지·해지·다시 열기, 입금 상태와 미납, MRR 과 그 증감을 실제 설치 SQL 위에서 확인한다. 날짜는 `erp.clock` 으로 옮긴다. 화면으로는 S24 를 사람 속도로 밟는다(모듈을 켜고, 제품에 주기를 고르고, 주문을 확정하고, 수량을 고쳐 지금 적용하고, 사유를 골라 해지하고, MRR 분석을 연다). 청구는 실제 버스를 거쳐 실제 청구 모듈로 간다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/subscription.test.mjs test/isolation.test.mjs test/models.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
npm --prefix web run build
source scripts/local-env.sh && lockf -t 1500 /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/subscription.spec.mjs
```

실행 기록은 `results/` 에 있다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 켜기 전에는 막힌다 | `subscription.test.mjs › S24. off by default, needs invoicing, and nothing of it shows or runs while off`<br>`subscription.spec.mjs › S24-0.` | SQL, 브라우저 | ✅ |
| 청구 없이 켜기 | `subscription.test.mjs › S24. off by default, needs invoicing, and nothing of it shows or runs while off` | SQL | ✅ |
| 켜면 주기가 생긴다 | `subscription.test.mjs › S24. off by default, needs invoicing, and nothing of it shows or runs while off`<br>`subscription.spec.mjs › S24-0.` | SQL, 브라우저 | ✅ |
| 조회 역할 | `subscription.test.mjs › sales and admin write; accounting may run the billing; every member reads`<br>`subscription.spec.mjs › S24-6.` | SQL, 브라우저 | ✅ |
| 회계 역할 | `subscription.test.mjs › sales and admin write; accounting may run the billing; every member reads` | SQL | ✅ |
| 주문 확정 | `subscription.test.mjs › S24. a confirmed order with a recurring product becomes a subscription; sales knew nothing; the order bills the first month`<br>`subscription.spec.mjs › S24-1.` | SQL, 브라우저 | ✅ |
| 주문의 청구서가 첫 기간이다 | `subscription.test.mjs › S24. a confirmed order with a recurring product becomes a subscription; sales knew nothing; the order bills the first month` | SQL | ✅ |
| 주문 취소 | `subscription.test.mjs › a cancelled order closes a subscription that billed nothing of its own, and flags one that did` | SQL | ✅ |
| 켜기 전의 주문 | `subscription.test.mjs › M6, M7: orders before turning on stay orders; turned off keeps records, stops billing; back on catches up` | SQL | ✅ |
| 다음 달 | `subscription.test.mjs › S24. a confirmed order with a recurring product becomes a subscription; sales knew nothing; the order bills the first month`<br>`subscription.spec.mjs › S24-3.` | SQL, 브라우저 | ✅ |
| 같은 청구가 두 번 전달된다 | `subscription.test.mjs › S24. a confirmed order with a recurring product becomes a subscription; sales knew nothing; the order bills the first month` | SQL | ✅ |
| 밀린 기간 | `subscription.test.mjs › catch-up after downtime bills each missed period once, on its own date; month ends hold` | SQL | ✅ |
| 지난 시작일과 청구 시작일 | `subscription.test.mjs › a past start bills what is due; billing_from leaves earlier periods to whoever billed them; the option posts the invoices` | SQL | ✅ |
| 바로 게시 | `subscription.test.mjs › a past start bills what is due; billing_from leaves earlier periods to whoever billed them; the option posts the invoices` | SQL | ✅ |
| 청구가 잠깐 꺼진다 | `subscription.test.mjs › invoicing off for a while: billings wait on the bus and become invoices when it is back` | SQL | ✅ |
| 종료일의 경계 | `subscription.test.mjs › terms: an end date is the last day of a period, or the refusal names the nearest ones` (사례 11개) | SQL | ✅ |
| 만료와 갱신 | `subscription.test.mjs › a fixed term closes on the day after its last day, or renews for the same term; a plan sets the default` | SQL | ✅ |
| 1년 주기 | `subscription.test.mjs › a fixed term closes on the day after its last day, or renews for the same term; a plan sets the default` | SQL | ✅ |
| 다음 기간부터 | `subscription.test.mjs › a change waits for the next period by default, takes effect there, and can be cancelled`<br>`subscription.spec.mjs › S24-2.` | SQL, 브라우저 | ✅ |
| 변경 취소 | `subscription.test.mjs › a change waits for the next period by default, takes effect there, and can be cancelled` | SQL | ✅ |
| 지금 적용 | `subscription.test.mjs › a change applied now is charged or credited for the days left, rounded as the cases say`<br>`subscription.spec.mjs › S24-2.` | SQL, 브라우저 | ✅ |
| 반올림의 경계 | `subscription.test.mjs › a change applied now is charged or credited for the days left, rounded as the cases say` (사례 24개) | SQL | ✅ |
| 고칠 수 없는 것 | `subscription.test.mjs › a change waits for the next period by default, takes effect there, and can be cancelled` | SQL | ✅ |
| 40일 멈춤 | `subscription.test.mjs › pause and resume move the next billing day by the days paused; nothing bills while paused` | SQL | ✅ |
| 날짜를 주고 멈추기 | `subscription.test.mjs › pause and resume move the next billing day by the days paused; nothing bills while paused` | SQL | ✅ |
| 해지 | `subscription.test.mjs › closing needs a reason from the list; it can give the unused days back; reopening bills a new period from today`<br>`subscription.spec.mjs › S24-4.` | SQL, 브라우저 | ✅ |
| 해지한 구독 | `subscription.test.mjs › closing needs a reason from the list; it can give the unused days back; reopening bills a new period from today`<br>`subscription.spec.mjs › S24-4.` | SQL, 브라우저 | ✅ |
| 다시 열기 | `subscription.test.mjs › closing needs a reason from the list; it can give the unused days back; reopening bills a new period from today` | SQL | ✅ |
| 15일 조건 | `subscription.test.mjs › a period paid late marks the subscription 미납 without stopping it, and payment clears it` | SQL | ✅ |
| 대변 메모로 돌려준 청구 | `subscription.test.mjs › a period paid late marks the subscription 미납 without stopping it, and payment clears it` | SQL | ✅ |
| 넉 달의 흐름 | `subscription.test.mjs › MRR on any day and its movement: new, expansion, contraction, churn, reactivation, churn rate and NRR, all adding up` | SQL | ✅ |
| 원장과 레코드가 같다 | `subscription.test.mjs › MRR on any day and its movement: new, expansion, contraction, churn, reactivation, churn rate and NRR, all adding up` | SQL | ✅ |
| 그때 알던 것 | `subscription.test.mjs › MRR on any day and its movement: new, expansion, contraction, churn, reactivation, churn rate and NRR, all adding up` | SQL | ✅ |
| 해지율의 근거 | `subscription.test.mjs › the retention card needs three months of history; the MRR card is ready with any`<br>`models.test.mjs › SQL: what the ledger says › nothing is open before any module is on` | SQL | ✅ |
| MRR 분석 화면 | `subscription.spec.mjs › S24-5.` | 브라우저 | ✅ |
| 주문 확정 되돌리기 | `subscription.test.mjs › rolling back the order takes the subscription with it; rolling back a billing takes its invoice, and the period bills again` | SQL | ✅ |
| 한 기간의 청구 되돌리기 | `subscription.test.mjs › rolling back the order takes the subscription with it; rolling back a billing takes its invoice, and the period bills again` | SQL | ✅ |
| 껐다 켜기 | `subscription.test.mjs › M6, M7: orders before turning on stay orders; turned off keeps records, stops billing; back on catches up` | SQL | ✅ |
| 에이전트 | `subscription.test.mjs › MCP: an agent lists subscriptions, reads MRR, creates one, changes it and closes it, with the rights of its member` | SQL | ✅ |
| 초안 편집 | `subscription.test.mjs › draft edits: lines are line events, the form preview works out amounts, and the plan sets the period` | SQL | ✅ |

모듈 경계(구독이 판매·청구의 함수와 표를 부르지 않고, 판매와 청구도 구독의 것을 부르지 않는다)는 `isolation.test.mjs › subscription does not reach into other modules` 와 `… sales/invoicing does not reach into other modules` 가 확인한다.
