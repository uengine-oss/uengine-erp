# 경비 (`sql/67d_expense.sql`)

모듈 `expense`(sort 64). 직원이 영수증을 첨부해 경비를 신청하고, 상사가 승인하고, 경리가 지급을 기록한다. 인사가 있어야 켠다(`requires: ["hr"]`). 아무 이벤트도 듣지 않는다. 회계가 이 모듈의 이벤트를 듣는다.

**범위.** 경비 한 건은 영수증 한 번의 지출이다. 다음은 하지 않는다.

| 안 하는 것 | 이유와 대신할 길 |
|---|---|
| 여러 건을 묶는 경비 보고서 | 승인과 전표의 단위가 둘이 되어 되돌리기와 사가가 복잡해진다. 한 건씩 승인한다 |
| 회사 카드 결제 경비 | 직원에게 줄 돈이 없다. 매입 전표(S16, 증빙유형 신용카드)로 넣는다 |
| 부가세 공제 분리 | 경비 금액은 합계 하나다. 공제받을 영수증은 S16 매입 전표로 넣는다 |
| 마일리지 단가 계산, 고객 재청구, 다른 통화 | 금액을 직접 적는다. 통화는 회사 통화뿐이다 |
| 한도와 다단계 승인 | 승인은 상사 한 번이다 |
| 영수증 OCR | 파일을 보관만 한다 |
| 은행 이체 | 앱은 돈을 옮기지 않는다. 사람이 이체한 뒤 지급 완료를 누른다 |

## 유형

`expense_category`(경비 유형): `name`(유일), `account_id`(회계가 켜져 있을 때만 보인다). 새 회사에 식대, 교통비, 출장비, 접대비, 통신비, 소모품, 기타 경비가 들어 있다. 쓰기는 `accounting`.

`expense`(경비): `number`(`EX00001`), `employee_id, date, title, category_id, amount, note, no_receipt_reason`. 나머지는 서버가 쓴다: `employee_name, employee_user_id, department_id, department_name, category_name, account_id, receipts, receipt_count, possible_duplicates, approver_id, approver_name, approver_user_id, approved_by_name, accounting_date, paid_on, paid_from, refused_reason, cancelled_from, state`.

## 상태와 권한

```
draft → submitted → approved → paid
          ↓  ↑(고쳐서 다시)
        refused        어느 단계에서든 → cancelled
```

명령의 역할은 `member`(구성원 누구나)이고 처리기가 누구의 경비인지 가린다. 커널의 역할 검사는 문서를 모르기 때문이다.

| 명령 | 누가 | 뜻 |
|---|---|---|
| `create`, `update`, `delete` | 본인, `hr`, `accounting` | `employee_id` 를 비우면 이 계정의 재직 직원 기록이다. `update` 는 작성 중과 반려만, `delete` 는 작성 중이고 영수증이 없을 때만 |
| `attach_receipt`, `remove_receipt` | 본인, `hr`, `accounting` | 아래 「영수증」 |
| `submit` | 본인, `hr`, `accounting` | 영수증이나 없는 사유가 있어야 한다. 그때의 상사를 승인자로 적는다 |
| `approve{accounting_date}` | 승인자, `admin` | 비우면 지출일이다. 지출일 이상, 오늘 이하, 잠기지 않은 날. `ExpenseApproved` |
| `refuse`(사유 필수) | 승인자, `admin` | 신청한 사람이 고쳐서 다시 신청한다 |
| `pay{paid_on, paid_from}` | `accounting` | 회계일 이상, 오늘 이하, 잠기지 않은 날. `paid_from` 은 `bank`(기본) 또는 `cash`. `ExpensePaid` |
| `cancel`(승인 뒤에는 사유 필수) | 신청 전후는 본인·승인자·`hr`·`accounting`, 승인 뒤는 승인자·`accounting`, 지급 뒤는 `accounting` | `ExpenseCancelled`. 전표가 지워진다 |

**본인 승인.** 상사가 있으면 관리자여도 본인 것을 승인하지 못한다. 상사가 없는 사람(대표)의 경비는 관리자가 승인하며, 그 관리자가 본인이면 이벤트에 `self_approved: true` 가 남는다. 상사에게 ERP 계정이 없으면 관리자가 승인한다.

**퇴사자.** 새 경비를 올릴 수 없다. 이미 만든 것은 인사나 회계 담당자가 이어서 처리한다.

**같은 날 같은 금액.** 같은 사람, 같은 지출일, 같은 금액의 진행 중 경비가 있으면 막지 않고 `possible_duplicates` 에 번호를 적어 승인자에게 보여 준다. 택시 두 번일 수 있어서다. 같은 파일은 막는다.

**읽기 권한의 한계.** 커널의 읽기 권한은 유형 단위라서 **경비의 금액, 적요, 직원 이름은 모든 구성원이 읽는다.** 민감한 것은 영수증이고, 영수증만 행 단위로 막는다. 금액까지 가리려면 커널에 행 단위 읽기 규칙을 더해야 한다.

## 영수증: 왜 Supabase Storage 인가

저장소가 없었으므로 정해야 했다.

| 방식 | 판단 |
|---|---|
| 원장에 넣기 | 안 된다. 지울 수 없고 500 MB 를 금방 채운다 |
| DB 표에 넣기 | 지울 수는 있지만 사진 한 장 200 KB 면 2,500장에 무료 DB 500 MB 가 찬다. 찬 DB 는 쓰기가 멈춘다 |
| **Supabase Storage** | 고객 프로젝트에 이미 있고 무료 1 GB 다. 서버를 따로 띄우지 않는다. 브라우저가 고객 프로젝트로 직접 올리므로 CSP 도 그대로다. 정책을 SQL 로 건다 |

그래서 **Storage 를 도입한다.** 설치 SQL 이 비공개 버킷 `erp-receipts`(10 MB, JPG·PNG·WEBP·HEIC·PDF)와 `storage.objects` 정책을 만든다. 저장소가 없는 DB(시험용 임시 DB)에서는 건너뛰고 설치는 계속된다. 로컬 스택도 `supabase/config.toml` 의 `[storage] enabled = true` 로 바꿨다.

| 무엇 | 어디에 | 누가 읽는가 |
|---|---|---|
| 파일 | Storage `expense/<경비 ID>/<영수증 ID>` | 본인, 승인자, `hr`, `accounting`, `admin`. 정책이 `public.erp_receipt_may` 를 부른다 |
| 파일 이름, 위치 | `erp.expense_receipts`(원장 밖) | 같은 사람들. RLS |
| 지문(sha256), 크기, 형식 | 원장 | 모든 구성원 |

파일 이름은 원장에 넣지 않는다. 사람 이름이나 카드 번호가 들어 있을 수 있어서다. 지문은 승인한 뒤 파일이 바뀌지 않았다는 증거다. 인사 모듈의 민감 정보 패턴을 따르되 칸이 아니라 파일이라서 다음이 다르다.

- **올리는 순서.** 경비를 저장하고, 브라우저가 지문을 계산해 올리고, `attach_receipt` 로 등록한다. 등록이 거부되면 올린 파일을 지운다. 저장소가 있는 프로젝트에서는 파일이 실제로 있어야 등록된다.
- **지우기.** 작성 중과 반려 상태에서는 본인이 사유 없이 지운다. 신청한 뒤에는 증빙이므로 `hr`, `accounting` 이 사유를 적어 지우고, 사유에 파일 이름을 적으면 거부한다. 원장에는 지웠다는 사실과 지문이 남는다.
- **같은 영수증.** 취소되지 않은 다른 경비에 같은 지문이 있으면 `ERP_DUPLICATE` 다. 동시에 올려도 잠금으로 막는다.
- **되돌리기.** 파일은 함께 돌아오지 않으므로, 되돌릴 시점에 없던 영수증이 남아 있으면 `revert_check_fn` 이 막고 먼저 지우라고 말한다.
- **MCP.** `attach_receipt` 는 `erp_update` 의 `action` 으로 부를 수 있지만 파일을 올리는 길은 없다. 에이전트는 Storage 에 쓰지 못하므로 사람이 올리거나 `no_receipt_reason` 을 적는다. MCP 로 파일 이름을 읽는 길도 없다.

**한계.** 원장 내보내기에 파일은 들어가지 않는다. 받아 두려면 Storage 에서 따로 받는다. Storage 의 파일을 지워도 Supabase 의 물리 백업과 받아 둔 사본까지 지우지는 못한다. 무료 플랜 1 GB 를 넘으면 올리기가 실패하고 화면이 그 문구를 보여 준다. 사용량 화면은 아직 Storage 를 세지 않는다. 증빙 보존 기간 판단은 회사가 한다.

## 전표

회계가 `ExpenseApproved`, `ExpensePaid`, `ExpenseCancelled` 를 구독한다(`erp.books_on_expense`). 처리기는 이벤트만 읽으므로 회계를 언제 켜도 같은 전표가 나온다(`test/expense.test.mjs` 가 세 회사로 확인한다).

| 이벤트 | 날짜 | 차변 | 대변 |
|---|---|---|---|
| `ExpenseApproved` | `accounting_date` | 유형의 계정(없으면 잡비) | 미지급금 |
| `ExpensePaid` | `paid_on` | 미지급금 | 보통예금 또는 현금 |
| `ExpenseCancelled` | 원래 날짜 | 그 경비의 열린 전표를 지운다(`erp.books_withdraw`) | |

승인할 때의 유형 계정을 이벤트에 싣는다. 전표의 거래처는 비어 있다. 직원은 거래처가 아니고 적요에 이름이 남는다. 그래서 **직원별 미지급 잔액 보고서는 없다.** 경비 목록의 승인 상태로 본다.

회계 구독에 더한 것은 이벤트 이름 셋, 처리기 하나, 시드 계정(미지급금, 복리후생비, 여비교통비, 기업업무추진비, 통신비, 소모품비, 잡비)이다.

## 되돌리기와 사가

| 상황 | 방식 |
|---|---|
| 아직 지급하지 않음 | `rollback`. 경비와 전표가 함께 돌아간다 |
| 지급함 | `revert_blocked_states: ["paid"]`. 돈이 이미 나갔으므로 되돌리지 않고 `compensate`: `cancel` 을 실행한다. 지급 기록은 남고 장부는 0 이 된다. **돈을 되찾는 일은 사람이 한다고 경고한다** |
| 잠긴 기간의 전표가 얽힘 | `lock_fn` 이 막는다. `blocked`. 이유를 말한다 |
| 영수증이 남아 있음 | `revert_check_fn` 이 되돌리기를 막는다. 사가에서는 `cancel` 로 상쇄한다 |

## 나중에 켜기, 끄기

- **M6.** 켜기 전의 경비는 원장에 없다. 회계를 나중에 켜면 그때까지의 승인과 지급으로 전표를 다시 만든다. 켤 때 묻는 것은 없다.
- **M7.** 끄면 메뉴와 명령이 막힌다. 레코드, 이력, 파일, 추이는 남는다. 인사는 경비를 끄기 전에 끌 수 없다(`ERP_IN_USE`).

## 모델

`stat_expense` 부서별 경비 추이. `public.erp_expense_trend(p_from, p_to, p_as_of)` 가 `ExpenseApproved` 이벤트만 읽는다. 달은 지출일, 부서는 승인할 때의 부서다. 취소하거나 되돌린 건은 빠진다. 근거는 승인 경비가 있었던 달 3개월이다. 통계라 정답을 재서 정한 값이 아니라 추이에 점이 셋은 있어야 한다는 판단이다. 근거가 모자라면 합계는 사실이므로 보여 주고 추이라고 말하지 않는다.

## 화면

메타데이터 화면에 전용 부분이 둘이다. `ExpenseReceiptPanel`: 파일을 올리고 여는 일은 폼 칸으로 할 수 없다. `TrendView`: 달과 부서의 표. 승인과 반려 단추는 승인자와 관리자에게만 보인다(`CommandUi.showIf`). 결정은 데이터베이스가 한다.

## 시험과 데모

시험은 `test/expense.test.mjs`, `test/isolation.test.mjs`, `e2e/tests/expense.spec.mjs`. 브라우저 시험은 실제 Storage API 에 파일을 올린다. 데모는 `web/src/lib/demo/backoffice.ts`.
