# E2E — erp-read-models

읽기 모델이 지금 시점의 원장과 같은 답을 하는지, 명령을 늦추지 않는지, 권한을 지키는지, 현황판과 관리자 화면이 그대로 보여 주는지 확인한다. SQL 시험은 실제 모듈로 무작위 업무를 돌린 뒤 같은 질문을 원장과 읽기 모델에 던져 행을 비교한다. 분석 로더 시험은 정답을 아는 가상 회사(`experiments/whatif`)를 쓴다. 측정은 `experiments/read-models/measure.mjs`, 결과는 같은 폴더의 `results.json` 과 `README.md` 다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test --test-force-exit test/read-models.test.mjs test/read-models-web.test.mjs
RM_SEEDS=1,2,3,4 RM_STEPS=200 node --test --test-force-exit --test-name-pattern=randomized test/read-models.test.mjs   # 씨앗을 더 돌려 본다
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- read-models.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 무작위로 섞은 업무 뒤에도 세 모델이 원장과 같다 | `read-models.test.mjs › randomized work (seed 11, 29, 47)`<br>`read-models.test.mjs › everyone gets from the read model what the ledger gives them, no more` | SQL | ✅ |
| 되돌리기는 손댄 모든 문서에 반대 효과를 남긴다 | `read-models.test.mjs › Reverted lands on every stream the rollback touched, with the effects negated` | SQL | ✅ |
| 되돌린 작업의 이벤트가 다른 문서에 있어도 주문이 빠진다 | `read-models.test.mjs › work undone whose Reverted sits on other documents still leaves the orders it touched` | SQL | ✅ |
| 단위 배수와 시간대가 바뀌면 곧바로 반영된다 | `read-models.test.mjs › a unit counted differently and a new time zone are taken in at once` | SQL | ✅ |
| 먼저 커밋된 이벤트도 열린 트랜잭션을 기다린다 | `read-models.test.mjs › an open transaction holds the cursor back: nothing behind it is skipped` | SQL | ✅ |
| 주문을 확정해도 읽기 모델은 그대로이고 대기 건수를 말한다 | `read-models.test.mjs › a command writes nothing on the read side; the model says it is behind until the worker runs` | SQL | ✅ |
| 다른 반영이 돌고 있으면 기다리지 않는다 | `read-models.test.mjs › a worker already applying a model is not waited for` | SQL | ✅ |
| 데모를 만들거나 파생 표를 다시 만드는 동안에는 반영하지 않는다 | `read-models.test.mjs › while the demo is being built or derived tables rebuilt, the worker waits` | SQL | ✅ |
| 재고 모델이 실패해도 매출 모델은 따라간다 | `read-models.test.mjs › a failing model stops at its batch, says why, and the others carry on` | SQL | ✅ |
| 다시 만들어도 같은 행이 나온다 | `read-models.test.mjs › a rebuild from the first event gives back exactly what the increments built`<br>`read-models.test.mjs › through the API, as PostgREST runs it: refresh and rebuild pass its guards` | SQL | ✅ |
| 계산 방식이 바뀐 모델은 처음부터 다시 채운다 | `read-models.test.mjs › a new version of a model starts it again from the first event` | SQL | ✅ |
| 사람마다 원장에서 얻는 만큼만 얻는다 | `read-models.test.mjs › everyone gets from the read model what the ledger gives them, no more` | SQL | ✅ |
| 읽기 역할을 건 문서 종류는 읽기 모델에서도 닫힌다 | `read-models.test.mjs › a document type closed to a role is closed in the read model too` | SQL | ✅ |
| 레코드마다 읽기를 정하는 종류가 섞이면 원장으로 돌아간다 | `read-models.test.mjs › a type someone may read only record by record sends them back to the ledger` | SQL | ✅ |
| 다시 만들기와 비교는 관리자만 한다 | `read-models.test.mjs › rebuilding and comparing are for admins; sizes and errors too` | SQL | ✅ |
| 한 번에 읽어도 예측과 what-if 가 같다 | `read-models-web.test.mjs › today: one call instead of the batches, and every model gives the same answer` | SQL + 모델 | ✅ |
| 과거 시점은 원장에서 읽는다 | `read-models-web.test.mjs › a date in the past reads the ledger, as before` | SQL + 모델 | ✅ |
| 읽기 모델이 늦으면 원장에서 읽는다 | `read-models-web.test.mjs › a model that is behind sends the loader back to the ledger, with the same numbers` | SQL + 모델 | ✅ |
| 현황판이 분석의 첫 화면이고 신선도와 읽은 시간을 말한다 | `read-models.spec.mjs › 현황판은 첫 메뉴이고, 한 번에 읽어 신선도와 읽은 시간을 말한다` | 브라우저 | ✅ |
| 다른 사람이 주문을 확정하면 몇 초 안에 따라온다 | `read-models.spec.mjs › 다른 사람이 주문을 확정하면 몇 초 안에 새로 고침 없이 따라온다` | 브라우저 | ✅ |
| 볼 수 있는 부분만 보인다 | `read-models.spec.mjs › 역할 없는 구성원: 장부 부분과 관리자 화면은 보이지 않는다`<br>`read-models.test.mjs › the dashboard shows a section only to someone who may read what it is made of` | 브라우저, SQL | ✅ |
| 휴대폰 폭과 어두운 화면에서도 넘치지 않는다 | `read-models.spec.mjs › 휴대폰 폭과 어두운 화면에서도 넘치지 않는다` | 브라우저 | ✅ |
| 비교는 두 시간과 같은 값인지를 보여 준다 | `read-models.spec.mjs › 관리자 화면: 모델마다 대기와 행 수, 다시 만들기, 같은 질문을 두 길로 재기`<br>`read-models.test.mjs › the comparison asks the same question both ways and gets the same answer` | 브라우저, SQL | ✅ |
| 다시 만들기는 확인을 받고 끝나면 알린다 | `read-models.spec.mjs › 관리자 화면: 모델마다 대기와 행 수, 다시 만들기, 같은 질문을 두 길로 재기` | 브라우저 | ✅ |
| 관리자가 아니면 메뉴도 화면도 없다 | `read-models.spec.mjs › 역할 없는 구성원: 장부 부분과 관리자 화면은 보이지 않는다` | 브라우저 | ✅ |

요구사항 본문의 「과거 시점을 보는 동안에는 지금 기준 화면이라고 알린다」 는 `read-models.spec.mjs › 과거 시점을 보는 동안에는 지금 기준 화면이라고 알린다` 가 덮는다.

## 남은 공백

- 무작위 업무는 판매·재고·청구·회계 흐름을 섞는다. 구매 입고, 제조, 급여·경비가 만드는 재고·장부 효과는 같은 덧셈 경로를 타지만 이 시험의 무작위 업무에는 없다.
- 읽기 모델을 MCP 로 읽는 길은 아직 없다. 에이전트는 전처럼 `erp_read {analytics}` 로 원장을 읽는다.
