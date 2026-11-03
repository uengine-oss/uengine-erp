# E2E — erp-history

문서와 회사의 과거 모습, 되돌리기의 미리보기·연쇄·차단·충돌·취소, 재구축을 확인한다. SQL 시험은 커널만으로 만든 주문→출고→재고 도메인과 실제 다섯 모듈(`growth.test.mjs`)을 함께 쓴다. 브라우저 시험의 되돌리기와 시간 여행 화면은 시험용 모듈(`tm_order`, `test_order` 등)로 돌며, 판매·재고·청구와 같은 모양의 이벤트를 낸다. 실제 모듈을 넘는 되돌리기와 게시 청구서 차단은 `growth.test.mjs` 가 확인한다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/history.test.mjs test/core.test.mjs test/growth.test.mjs test/bus.test.mjs test/plugin.test.mjs
source scripts/local-env.sh && npm run test:e2e -- rollback.spec.mjs history.spec.mjs meta.spec.mjs growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 시각을 고르면 그때의 문서가 나온다 | `history.test.mjs › time travel: a record reads back exactly as it stood at each moment`<br>`core.test.mjs › time travel folds the stream up to a moment` | SQL | ✅ |
| 같은 순간의 이벤트도 버전으로 구분한다 | `history.test.mjs › time travel: stepping by version separates events with the same timestamp`<br>`history.spec.mjs › 문서 슬라이더는 버전으로 읽어서, 같은 순간의 이벤트도 구분한다` | SQL, 브라우저 | ✅ |
| 슬라이더로 고른 시점의 문서는 읽기 전용이다 | `meta.spec.mjs › 슬라이더로 과거를 고르면 읽기 전용으로 그 시점을 보여 준다` | 브라우저 | ✅ |
| 이력 항목을 누르면 그 시점으로 간다 | `meta.spec.mjs › 이력 항목을 눌러도 그 시점으로 간다` | 브라우저 | ✅ |
| 회사가 그때 어땠는지 보인다 | `growth.test.mjs › S6. time travel shows the company as it was` | SQL | ✅ |
| 날짜를 고르면 목록이 그 시점으로 바뀌고 쓰기 버튼이 사라진다 | `history.spec.mjs › 날짜를 고르면 목록이 그 시점으로 바뀌고 쓰기 버튼이 모두 사라진다`<br>`history.test.mjs › time travel: the whole company list reads back as of a moment, including records that did not exist yet` | SQL, 브라우저 | ✅ |
| 그때의 문서는 읽기 전용이고 없던 문서와 새 문서는 안내한다 | `history.spec.mjs › 그 시점의 문서는 읽기 전용이고, 그때 없던 문서와 새 문서는 안내한다` | 브라우저 | ✅ |
| 입력 중이던 내용은 과거를 보고 돌아와도 남는다 | `history.spec.mjs › 입력 중이던 내용은 과거를 보고 돌아와도 남아 있다` | 브라우저 | ✅ |
| 원장과 홈도 그 시점까지만 보인다 | `history.spec.mjs › 원장과 홈도 그 시점까지만 보여 주고, 아무것도 없던 날은 빈 상태로 안내한다` | 브라우저 | ✅ |
| 시점 읽기가 실패하면 오늘의 값을 보여 주지 않는다 | `history.spec.mjs › 시점 읽기가 실패하면 오류와 다시 시도를 보여 주고, 읽기 권한도 그대로 지킨다` | 브라우저 | ✅ |
| 볼 수 없는 유형은 과거에도 볼 수 없다 | `history.spec.mjs › 조회 역할도 과거를 볼 수 있지만, 볼 수 없는 유형은 과거에도 볼 수 없다` | 브라우저 | ✅ |
| 파생 합계도 시점별로 다시 계산된다 | `history.test.mjs › time travel: derived totals such as stock can be recomputed for any past moment` | SQL | ✅ |
| 재고와 미수금 화면도 그 시점을 따른다 | `growth.spec.mjs › S6. 시점을 고르면 재고와 미수금도 그날 기준으로 보이고, 구매 입고 입력은 수량을 줄별로 묻는다` | 브라우저 | ◐ |
| 휴대폰 폭과 어두운 테마에서도 시점 보기가 된다 | `history.spec.mjs › 휴대폰 폭과 어두운 테마에서도 시점 보기가 된다` | 브라우저 | ✅ |
| 잘못 확정한 주문을 모듈을 넘어 되돌린다 | `growth.test.mjs › S6. rollback crosses module lines and a posted invoice stops it`<br>`rollback.spec.mjs › S6. 잘못 확정한 주문을 되돌린다: 미리보기가 모듈을 넘어 보여 주고, 사유를 받고, 원장에 남긴다`<br>`history.test.mjs › undo a business action: confirming an order is reversed across every aggregate it touched, atomically` | SQL, 브라우저 | ✅ |
| 사유 없이는 되돌리지 않는다 | `rollback.spec.mjs › S6. 잘못 확정한 주문을 되돌린다: 미리보기가 모듈을 넘어 보여 주고, 사유를 받고, 원장에 남긴다`<br>`history.test.mjs › only an admin can roll back, a reason is required, and a viewer sees nothing of it` | SQL, 브라우저 | ✅ |
| 되돌려도 원장은 지워지지 않는다 | `history.test.mjs › history is not rewritten: the past still shows what really happened before the undo`<br>`rollback.spec.mjs › S6. 잘못 확정한 주문을 되돌린다: 미리보기가 모듈을 넘어 보여 주고, 사유를 받고, 원장에 남긴다` | SQL, 브라우저 | ✅ |
| 되돌린 주문은 다시 확정할 수 있다 | `history.test.mjs › a rolled-back order can simply be confirmed again, and reactions fire again` | SQL | ✅ |
| 되돌리기는 연쇄 반응을 일으키지 않는다 | `history.test.mjs › undoing does not fire reactions, so no new shipment appears from the compensating events` | SQL | ✅ |
| 이미 되돌린 작업은 할 일이 없다고 말한다 | `history.test.mjs › running the same undo twice does nothing the second time`<br>`rollback.spec.mjs › 이미 되돌린 작업은 되돌릴 내용이 없다고 말한다` | SQL, 브라우저 | ✅ |
| 되돌린 문서의 번호는 다시 쓰지 않는다 | ✗ | — | ✗ |
| 뒤따른 작업이 있으면 동의해야 실행된다 | `rollback.spec.mjs › 뒤따른 작업이 있으면 범위를 보여 주고, 동의해야 실행한다` | 브라우저 | ✅ |
| 출고까지 끝난 주문을 되돌리면 재고도 돌아온다 | `growth.test.mjs › S6. rollback crosses module lines and a posted invoice stops it`<br>`history.test.mjs › causal safety: goods already shipped means undoing the confirmation must also undo the shipment` | SQL | ✅ |
| 인과가 없어도 재고가 음수가 되면 막는다 | `history.test.mjs › shared totals: undoing a receipt whose goods already shipped on another order is refused, not left negative` | SQL | ✅ |
| 재고가 다시 채워지면 같은 되돌리기가 된다 | `history.test.mjs › shared totals: the same undo is allowed once enough stock has come back` | SQL | ✅ |
| 게시된 청구서가 얽히면 막고 대변 메모를 안내한다 | `growth.test.mjs › S6. rollback crosses module lines and a posted invoice stops it`<br>`history.test.mjs › posted documents cannot be rolled back; the preview says what to do instead`<br>`rollback.spec.mjs › 게시된 청구서가 얽히면 막고 대변 메모를 안내한다` | SQL, 브라우저 | ✅ |
| 고객에게 이미 보낸 견적은 경고만 한다 | `history.test.mjs › things already told to the outside world raise a warning in the preview`<br>`rollback.spec.mjs › 고객에게 이미 보낸 견적은 경고한다` | SQL, 브라우저 | ✅ |
| 미리보기 뒤에 문서가 바뀌면 거부하고 다시 보여 준다 | `history.test.mjs › a stale preview is refused if someone changed the data in between`<br>`rollback.spec.mjs › 미리보기 뒤에 문서가 바뀌면 거부하고 다시 보여 준다` | SQL, 브라우저 | ✅ |
| 미리보기를 읽지 못하면 오류와 다시 시도를 보여 준다 | `rollback.spec.mjs › 미리보기를 읽지 못하면 오류와 다시 시도를 보여 준다` | 브라우저 | ✅ |
| 관리자가 아니면 되돌리기를 부를 수 없고 버튼도 없다 | `history.test.mjs › only an admin can roll back, a reason is required, and a viewer sees nothing of it`<br>`rollback.spec.mjs › 되돌릴 수 없는 유형과 비관리자에게는 되돌리기 버튼이 없다` | SQL, 브라우저 | ✅ |
| 구성원은 되돌리기 대상이 아니다 | `rollback.spec.mjs › 되돌릴 수 없는 유형과 비관리자에게는 되돌리기 버튼이 없다` | 브라우저 | ✅ |
| 고른 버전의 모습으로 돌아가고 버전은 늘어난다 | `history.test.mjs › record rollback: a document goes back to a chosen version` | SQL | ✅ |
| 이력과 슬라이더 양쪽에서 버전을 고른다 | `rollback.spec.mjs › 이 버전으로 되돌리기: 이력과 슬라이더 양쪽에서 고른 모습으로 돌아간다` | 브라우저 | ✅ |
| 고른 날짜 이후를 회사 전체에서 되돌린다 | `history.test.mjs › company rollback to a moment: everything after it is undone, with a preview first`<br>`rollback.spec.mjs › 회사 전체 되돌리기: 날짜를 고른 뒤 관리자만, 사유를 적어야 실행한다` | SQL, 브라우저 | ✅ |
| 구성원과 모듈은 그대로다 | `history.test.mjs › company rollback leaves people and company settings alone`<br>`rollback.spec.mjs › 회사 전체 되돌리기: 날짜를 고른 뒤 관리자만, 사유를 적어야 실행한다` | SQL, 브라우저 | ✅ |
| 회사가 생기기 전으로는 되돌릴 수 없다 | `rollback.spec.mjs › 회사가 생기기 전으로는 되돌릴 수 없다고 말한다` | 브라우저 | ✅ |
| 되돌린 것을 다시 되돌리면 상태와 합계가 돌아온다 | `history.test.mjs › undo of the undo restores the state and re-applies the stock effects` | SQL | ✅ |
| 원장 화면에서 되돌리고 다시 되돌린다 | `rollback.spec.mjs › 원장 화면에서도 되돌리고, 되돌리기 자체를 다시 되돌린다` | 브라우저 | ✅ |
| 휴대폰 폭과 어두운 테마에서도 미리보기가 읽힌다 | `rollback.spec.mjs › 휴대폰 폭과 어두운 테마에서도 미리보기가 읽힌다` | 브라우저 | ✅ |
| 구독자가 만든 문서도 함께 되돌아간다 | `bus.test.mjs › a subscriber event carries the source correlation, cause and actor; rollback takes it along` | SQL | ✅ |
| 전달 전에 되돌린 이벤트는 전달되지 않는다 | `bus.test.mjs › rollback before delivery: the undone event is skipped, not delivered` | SQL | ✅ |
| 되돌리기를 되돌리면 그 이벤트가 전달된다 | `bus.test.mjs › rolling back the rollback before delivery: the event stands again and is delivered` | SQL | ✅ |
| 다시 만들면 상태와 합계가 글자까지 같다 | `history.test.mjs › rebuild: drop every projection, replay the ledger, and get byte-identical state and totals` | SQL | ✅ |

- 「재고와 미수금 화면도 그 시점을 따른다」: 브라우저 시험은 고른 날짜가 오늘이라 과거 수량 자체를 확인하지 않는다. 안내 문구, 버튼이 사라지는 것, 기준일 전달만 확인한다. 과거 시점의 미수금 값은 `erp-invoicing` 이, 파생 합계의 시점 계산은 「파생 합계도 시점별로 다시 계산된다」 가 확인한다.
- 「되돌린 문서의 번호는 다시 쓰지 않는다」: 시험이 없다. 되돌리기가 번호 시퀀스를 건드리지 않는 것을 SQL 에서 확인했다.
- 「관리자가 아니면 되돌리기를 부를 수 없고 버튼도 없다」: `history.test.mjs` 는 이름과 달리 조회 역할이 아니라 영업 역할로 확인한다.
