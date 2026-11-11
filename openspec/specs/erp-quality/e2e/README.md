# E2E — erp-quality

검사 기준, 입고·출고·제조에서 저절로 생기는 검사, 측정값 판정과 표본, 불량 경보, 불량률과 직행률을 실제 설치 SQL 위에서 확인하고, 화면으로는 S25 의 품질 부분을 사람 속도로 밟는다. 검사는 구매 확정 → 재고(입고 전표) → 품질(검사)의 실제 버스를 거쳐 생긴다. 경계값은 `test/quality-cases.json` 에 있고 시험이 그 수만큼 돈다.

```bash
# 저장소 루트에서
source scripts/local-env.sh && node scripts/build-sql.mjs && node --test --test-force-exit test/quality.test.mjs test/isolation.test.mjs

# 브라우저는 로컬 스택의 postgres DB 를 초기화한다. 같은 스택을 함께 쓰면 잠금을 잡는다
npm --prefix web run build && lockf -t 1500 /tmp/uengine-erp-e2e.lock npx playwright test -c e2e/playwright.config.mjs e2e/tests/quality.spec.mjs
```

결과: `results/quality.test.txt`, `results/quality.spec.txt`.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 재고 없이 | `quality.test.mjs › S25. quality starts off, needs stock first, and hears stock and manufacturing` | SQL | ✅ |
| 켜기 전 | 같은 시험<br>`quality.spec.mjs › S25-6.` | SQL, 브라우저 | ✅ |
| 서로 끼어들지 않는다 | `isolation.test.mjs › quality does not reach into other modules`<br>`isolation.test.mjs › inventory does not reach into other modules`<br>`isolation.test.mjs › mrp does not reach into other modules` | SQL | ✅ |
| 기준의 경계 | `quality.test.mjs › control points: 13 cases of what a point may say` | SQL | ✅ |
| 화면에서(기준) | `quality.spec.mjs › S25-7.` | 브라우저 | ✅ |
| 입고 준비 | `quality.test.mjs › S25. a receipt that is ready makes a measurement check once, the goods go in whatever it says, and a failure opens one alert` | SQL | ✅ |
| 처리해도 하나 | 같은 시험 | SQL | ✅ |
| 취소된 입고 | `quality.test.mjs › S25. a receipt cancelled before it arrives calls off its check; returns and moves inside are not checked` | SQL | ✅ |
| 반품 | 같은 시험 | SQL | ✅ |
| 거래처를 정한 출고 기준 | `quality.test.mjs › S25. deliveries are checked for the customer the point names, and only them` | SQL | ✅ |
| 대기 중인 검사 | `quality.test.mjs › S25. a receipt that is ready makes …`<br>`quality.test.mjs › M5: a stuck quality listener holds back no receipt, and catches up with nothing lost or doubled` | SQL | ✅ |
| 불합격 | `quality.test.mjs › S25. a receipt that is ready makes …`<br>`quality.spec.mjs › S25-8.` | SQL, 브라우저 | ✅ |
| 경계 | `quality.test.mjs › measurement bounds: 13 cases, inclusive at both ends` | SQL | ✅ |
| 값의 형식 | `quality.test.mjs › S25. a receipt that is ready makes …` | SQL | ✅ |
| 화면에서(측정) | `quality.spec.mjs › S25-8.` | 브라우저 | ✅ |
| 세 번째마다 | `quality.test.mjs › S25. every third receipt is checked; the others are kept as left out of the sample, so the count can be read back` | SQL | ✅ |
| 빈도의 경계 | `quality.test.mjs › sampling: 20 cases of every time, every N-th and a share` | SQL | ✅ |
| 경보 | `quality.test.mjs › S25. a receipt that is ready makes …` | SQL | ✅ |
| 재검사 | `quality.test.mjs › S25. a retest after rework keeps the first result; failing again while the alert is open joins that alert` | SQL | ✅ |
| 해결 | `quality.test.mjs › S25. an alert is started, closed with its cause and what was done, called off only with a reason, and reopened` | SQL | ✅ |
| 다시 열기와 취소 | 같은 시험 | SQL | ✅ |
| 손으로 연 경보 | 같은 시험 | SQL | ✅ |
| 화면에서(경보) | `quality.spec.mjs › S25-9.` | 브라우저 | ✅ |
| 직행률 | `quality.test.mjs › S25. an order to make something is checked on its finished product; a cancelled order calls the check off; first-pass yield counts first results` | SQL | ✅ |
| 공급사별 | `quality.test.mjs › S25. defect rate by supplier and by product from first results, in a period, and the model card at 29 and 30` | SQL | ✅ |
| 29건과 30건 | 같은 시험 | SQL | ✅ |
| 화면에서(불량률) | `quality.spec.mjs › S25-10.` | 브라우저 | ✅ |
| 역할 | `quality.test.mjs › S25. a receipt that is ready makes …`<br>`quality.test.mjs › control points: …`<br>`quality.test.mjs › S25. an alert is started, …` | SQL | ✅ |
| 고장 난 구독 | `quality.test.mjs › M5: a stuck quality listener holds back no receipt, and catches up with nothing lost or doubled` | SQL | ✅ |
| 나중에 켜기, 끄기 | `quality.test.mjs › M6, M7: receipts before quality was on get no check; turned off it keeps everything and the rates still answer` | SQL | ✅ |
| 구매 확정 되돌리기 | `quality.test.mjs › S25. undoing a purchase confirmation takes its receipt and the check made from it` | SQL | ✅ |
| 에이전트의 측정 | `quality.test.mjs › MCP: an agent records a measurement with the rights of the member it speaks for` | SQL | ✅ |

검사가 출고를 막지 않는 것은 출고 기준 시험에서 처리한 출고로만 확인한다. 화면의 제조 검사는 시험이 없다(SQL 로만 확인).
