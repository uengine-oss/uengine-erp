# E2E — erp-attendance

출퇴근, 정정, 주 52시간, 휴가와의 관계, 월 마감을 실제 설치 SQL 위에서 시각을 돌려 가며 확인한다. 화면으로는 S12 를 사람 속도로 밟는다. 시각이 진짜인 브라우저 시험에서 지난달과 긴 주는 인사 담당자의 명령으로 넣고, 사람이 하는 일은 누른다. 날짜와 시각 칸은 로캘에 따라 배치가 달라 값으로 넣는다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/attendance.test.mjs test/isolation.test.mjs

source scripts/local-env.sh && npm --prefix web run build && lockf /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/attendance.spec.mjs
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 켜기 | `attendance.test.mjs › S12. it needs people`<br>`attendance.spec.mjs › S12-0` | SQL, 브라우저 | ✅ |
| 하루 | `attendance.test.mjs › S12. clocking in and out`, `Article 54`<br>`attendance.spec.mjs › S12-1` | SQL, 브라우저 | ✅ |
| 밤 근무와 잊은 퇴근 | `attendance.test.mjs › a night shift` | SQL | ✅ |
| 퇴근 누락 | `attendance.test.mjs › S12. a correction needs a reason`<br>`attendance.spec.mjs › S12-3` | SQL, 브라우저 | ✅ |
| 동료 | `attendance.test.mjs › S12. a person sees their own days`<br>`attendance.spec.mjs › S12-2` | SQL, 브라우저 | ✅ |
| 긴 주 | `attendance.test.mjs › S12. the week`<br>`attendance.spec.mjs › S12-5` | SQL, 브라우저 | ✅ |
| 판례의 주 | `attendance.test.mjs › the Supreme Court` | SQL | ✅ |
| 달의 날들 | `attendance.test.mjs › S12. a day of approved leave`, `S12. with leave off`, `a day before the module was on`<br>`attendance.spec.mjs › S12-7` | SQL, 브라우저 | ✅ |
| 마감 | `attendance.test.mjs › S12. closing a month`, `a closed month says which days`<br>`attendance.spec.mjs › S12-3`, `S12-4` | SQL, 브라우저 | ✅ |
| 늦게 켠 달과 마감 뒤 휴가 | `attendance.test.mjs › the month a module came on` | SQL | ✅ |
| 끄고 켜기 | `attendance.test.mjs › M7. turned off` | SQL | ✅ |
| 추이 | `attendance.test.mjs › M8. the models go locked`<br>`attendance.spec.mjs › S12-6` | SQL, 브라우저 | ✅ |
| 조합 | `isolation.test.mjs › leave and attendance as` 6, `attendance does not reach into other modules`, `neither of the two modules` | SQL | ✅ |
