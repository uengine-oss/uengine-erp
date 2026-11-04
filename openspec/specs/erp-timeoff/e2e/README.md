# E2E — erp-timeoff

연차 계산을 손으로 계산한 표와 대조하고, 신청과 결정, 사유가 닿는 범위, 되돌리기, 사가를 실제 설치 SQL 위에서 확인한다. 화면으로는 S11 을 사람 속도로 밟는다(메뉴를 누르고, 한 글자씩 치고, 단추를 누른다). 시연 영상은 이 순서를 따른다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/timeoff.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
source scripts/local-env.sh && npm --prefix web run build && lockf /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/timeoff.spec.mjs
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 인사 없이는 켜지지 않는다 | `timeoff.test.mjs › S11. it needs people`<br>`timeoff.spec.mjs › S11-0` | SQL, 브라우저 | ✅ |
| 늦게 켠 회사 | `timeoff.test.mjs › M6. turned on late` | SQL | ✅ |
| 날짜가 되면 생긴다 | `timeoff.test.mjs › M6. turned on late` | SQL | ✅ |
| 경계 | `timeoff.test.mjs › Civil Act 160`, `Article 60(1) and (4)`, `by start date` 2, `the Act's fifteen days wait` | SQL | ✅ |
| 80% 정확히와 그 아래 | `timeoff.test.mjs › Article 60(1): at 80 percent`, `Article 60(2): just under`, `the first year` | SQL | ✅ |
| 근로 의무가 정지된 기간은 소정근로일에서 뺀다 | `timeoff.test.mjs › a suspension of the duty to work` | SQL | ✅ |
| 일부만 덮는 마감은 판정하지 않는다 | `timeoff.test.mjs › a month attendance covered only in part` | SQL | ✅ |
| 고용노동부 답변의 예 | `timeoff.test.mjs › by fiscal year` 2 | SQL | ✅ |
| 미달 | `timeoff.test.mjs › a fiscal-year company` | SQL | ✅ |
| 끄고 켜기 | `timeoff.test.mjs › policy`<br>`timeoff.spec.mjs › S11-1` | SQL, 브라우저 | ✅ |
| 박영업의 신청 | `timeoff.test.mjs › S11. an ordinary member`, `S11. over what is left`, `a request reaches only`<br>`timeoff.spec.mjs › S11-2` | SQL, 브라우저 | ✅ |
| 반차와 겹침 | `timeoff.test.mjs › half a day`, `types without a balance` | SQL, 브라우저 | ✅ |
| 경로 | `timeoff.test.mjs › no boss`, `a one-person company`<br>`timeoff.spec.mjs › S11-3` | SQL, 브라우저 | ✅ |
| 시작한 휴가 | `timeoff.test.mjs › cancelling`, `leaving` | SQL | ✅ |
| 어디를 뒤져도 | `timeoff.test.mjs › the words of a reason`, `a reason said in the command`, `a person can have the words erased`, `MCP: the tools name`<br>`isolation.test.mjs › why someone asked for leave`<br>`timeoff.spec.mjs › S11-4`, `S11-5` | SQL, 브라우저 | ✅ |
| 동료의 달력 | `timeoff.test.mjs › the team calendar`<br>`timeoff.spec.mjs › S11-3`, `S11-4` | SQL, 브라우저 | ✅ |
| 잘못 승인 | `timeoff.test.mjs › S11. a wrong approval undone`, `undoing a request that has words`, `undoing a hire`<br>`timeoff.spec.mjs › S11-6` | SQL, 브라우저 | ✅ |
| 사가 | `timeoff.test.mjs › MCP: an agent asking`, `MCP: with words beside it`, `MCP: once a person has approved it`<br>`timeoff.spec.mjs › S11-7` | SQL, 브라우저 | ✅ |
| 세 상태 | `attendance.test.mjs › M8. the models go locked`<br>`timeoff.spec.mjs › S11-0`, `S11-8`, `S11-9` | SQL, 브라우저 | ✅ |
| what-if | `attendance.test.mjs › M8. the models go locked`<br>`timeoff.spec.mjs › S11-8` | SQL, 브라우저 | ✅ |
| 어떤 조합에서도 | `isolation.test.mjs › leave and attendance as` 6, `timeoff does not reach into other modules`, `neither of the two modules` | SQL | ✅ |
| 도구 목록 | `timeoff.test.mjs › MCP: the tools name` | SQL | ✅ |
| 같은 수치 | `attendance.test.mjs › the demo on a real database`, `the story the demo really tells`, `hr.test.mjs › the demo` | SQL | ✅ |

법 계산의 시험은 일수를 손으로 계산해 숫자로 적었다. 계산식을 다시 돌려 맞추지 않는다.
