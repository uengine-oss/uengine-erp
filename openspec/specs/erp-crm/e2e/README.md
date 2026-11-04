# E2E — erp-crm

리드, 단계, 수주·실주, 판매로 가는 견적, 연락처, 모델을 실제 설치 SQL 위에서 확인하고, 화면으로는 S14 의 CRM 부분을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 칸반 단추를 누른다). 수주는 실제 버스를 거쳐 실제 판매 모듈로 간다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/crm.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- tests/crm.spec.mjs
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 판매 없는 회사 | `crm.test.mjs › S14. it starts off, needs nothing else, and works with no sales module` | SQL | ✅ |
| 켜기 전에는 막힌다 | `crm.test.mjs › S14. it starts off, needs nothing else, and works with no sales module`<br>`crm.spec.mjs › S14-0.` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 서로 끼어들지 않는다 | `isolation.test.mjs › back office [...]` 조합<br>`isolation.test.mjs › crm does not reach into other modules`<br>`isolation.test.mjs › sales does not reach into other modules` | SQL | ✅ |
| 조회 역할 | `crm.test.mjs › only sales and admin write; every member reads the deal, nobody else the contact`<br>`crm.spec.mjs › S14-6.` | SQL, 브라우저 | ✅ |
| 단계 이동 | `crm.test.mjs › S14. a lead moves through the stages, forward, skipping and back, and every step says what it is now` | SQL | ✅ |
| 칸반 | `crm.spec.mjs › S14-2.` | 브라우저 | ✅ |
| 값의 경계 | `crm.test.mjs › edges: amount and fields, with nothing left behind by a refusal`<br>`crm.spec.mjs › S14-1.` | SQL, 브라우저 | ✅ |
| 수주 경계 | `crm.test.mjs › winning: needs someone to bill, a date no later than today and no earlier than the lead` | SQL | ✅ |
| 실주 사유 | `crm.test.mjs › losing: the reason is required, one of the list, and "other" says what`<br>`crm.spec.mjs › S14-3.` | SQL, 브라우저 | ✅ |
| 다시 열기 | `crm.test.mjs › losing: the reason is required, one of the list, and "other" says what`<br>`crm.spec.mjs › S14-3.` | SQL, 브라우저 | ✅ |
| 견적 초안 | `crm.test.mjs › S14. a win becomes a draft quote: sales listens, the deal is untouched, and it can be turned off per win`<br>`crm.spec.mjs › S14-4.` | SQL, 브라우저 | ✅ |
| 끄고 수주 | `crm.test.mjs › S14. a win becomes a draft quote: sales listens, the deal is untouched, and it can be turned off per win` | SQL | ✅ |
| 회사명만 있을 때 | `crm.test.mjs › a win with only a company name finds that customer or makes one, once` | SQL | ✅ |
| 다시 열면 | `crm.test.mjs › reopening cancels a draft nobody has sent, and leaves one that has gone out`<br>`crm.spec.mjs › S14-5.` | SQL, 브라우저 | ✅ |
| 판매가 고장 나도 수주는 된다 | `crm.test.mjs › a stuck sales subscriber does not stop a win; it catches up with nothing lost or doubled` | SQL | ✅ |
| 판매를 나중에 켠다 | `crm.test.mjs › M6, M7: sales turned on later drafts only what is won after; crm turned off keeps everything and answers from the ledger` | SQL | ✅ |
| 어디에도 값이 없다 | `crm.test.mjs › a contact person stays out of the ledger, can be erased, and no door leads to them`<br>`crm.spec.mjs › S14-1.`<br>`crm.spec.mjs › S14-6.` | SQL, 브라우저 | ✅ |
| 지우기 | `crm.test.mjs › a contact person stays out of the ledger, can be erased, and no door leads to them` | SQL | ✅ |
| 연락처가 있으면 삭제와 등록 되돌리기가 막힌다 | `crm.test.mjs › a contact person stays out of the ledger, can be erased, and no door leads to them` | SQL | ✅ |
| 말로 취소 | `crm.test.mjs › saga over MCP: register, move, win with a quote, then undo: all of it goes back by rollback, nothing to offset` | SQL | ✅ |
| 사람이 만진 견적 | `crm.test.mjs › undoing a win after someone worked on the quote names that work and needs consent` | SQL | ✅ |
| 에이전트의 권한 | `crm.test.mjs › MCP: an agent has the rights of the member it speaks for` | SQL | ✅ |
| 세는 법 | `crm.test.mjs › conversion by stage: reaching counts by how far a deal got; open deals are not lost; the band is honest about small numbers`<br>`crm.spec.mjs › S14-7.` | SQL, 브라우저 | ✅ |
| 알고 있는 수주율 | `crm.test.mjs › a known win rate: the band holds it, and deals go in as the ledger says, not as the screen remembers` | SQL | ✅ |
| 19건과 20건 | `crm.test.mjs › the forecast: below 20 decided it gives only the range; at 20 it gives a figure and a band; 19 and 20 are where it turns`<br>`crm.spec.mjs › S14-7.` | SQL, 브라우저 | ✅ |
| 누가 후보인가 | `crm.test.mjs › repurchase: locked without sales; those overdue against their own habit, not those being talked to or on one order`<br>`crm.spec.mjs › S14-7.` | SQL, 브라우저 | ✅ |
| 바로 만들기 | `crm.spec.mjs › S14-7.` | 브라우저 | ✅ |
| 끄고 켜기 | `crm.test.mjs › M6, M7: sales turned on later drafts only what is won after; crm turned off keeps everything and answers from the ledger` | SQL | ✅ |
| 수치 비교 | `crm.test.mjs › the demo: deals have their own random stream, and with them sales and stock come out the same` | SQL | ✅ |
