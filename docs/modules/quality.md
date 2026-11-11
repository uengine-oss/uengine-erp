# 품질 (`sql/67i_quality.sql`)

모듈 `quality`(sort 74). 무엇을 언제 얼마나 자주 검사할지 정하면(검사 기준) 입고, 출고, 제조 때 검사가 저절로 생기고, 사람이 합격·불합격이나 측정값을 적는다. 불합격하면 불량 경보가 열리고, 원인과 시정 조치를 적어 닫는다. **재고가 켜져 있어야 켤 수 있다**(`requires: ["inventory"]`). 재고의 전표 이벤트와 제조의 지시 이벤트를 듣고 자기 문서만 쓴다. **재고와 제조는 품질을 모르고, 검사를 기다리지 않는다.** 시나리오는 S25 다.

불량률과 직행률은 어디에도 저장하지 않는다. 물을 때 원장의 검사 이벤트로 셈한다(`sql/70_analytics.sql`).

**범위.** 다음은 하지 않는다.

| 안 하는 것 | 이유와 대신할 길 |
|---|---|
| 검사가 끝나기 전이나 불합격일 때 입고·출고·제조 완료를 막기 | 재고가 품질을 알아야 한다. 아래 「결정」 |
| 격리 위치로 받기, 다단계 입고 | 재고에 다단계 입고가 없다. 불합격한 물건은 사람이 재고의 반품이나 폐기로 처리한다 |
| 작업 공정(라우팅) 단계별 검사 | 제조에 라우팅이 없다. 제조 검사는 완제품 하나에 대해서다 |
| 로트·일련번호별 검사, 검사 성적서 출력 | 검사는 전표의 제품 한 줄에 하나다 |
| 관리도(SPC), 공정 능력 지수 | 측정값은 원장에 남으므로 나중에 읽을 수 있다. 지금은 불량률만 셈한다 |
| 날짜 주기(매주 첫 입고) 표본 | 횟수와 비율만 한다 |

## 유형

| 유형 | 칸 |
|---|---|
| `quality_point` 검사 기준 | `code(QP00001), name, operation(receipt/delivery/manufacturing), product_id, category_id, partner_id, check_type(pass_fail/measure/instructions), norm_min, norm_max, unit, instructions, frequency(every/nth/percent), every_n, percent, responsible_id` |
| `quality_check` 품질 검사 | `number(QC00001), name, operation(…/manual), origin, product_id, variant_id, product_name, partner_id, partner_name, qty, check_type, norm_min, norm_max, unit, instructions, measured_value, result(pass/fail), note, checked_by, checked_at, point_id, sample_no, picking_id, manufacturing_order_id, retest_of, retest_id, alert_id, state` |
| `quality_alert` 불량 경보 | `number(QA00001), name, priority, product_id, partner_id, origin, operation, responsible_id, deadline, description, root_cause, root_cause_note, corrective_action, note, raised_on, closed_on, cancel_reason, check_id, point_id, picking_id, manufacturing_order_id, state` |

검사 상태: `todo`(검사 대기), `passed`(합격), `failed`(불합격), `skipped`(표본 제외), `cancelled`(취소). 경보 단계: `new`(신규) → `in_progress`(조치 중) → `done`(해결), 또는 `cancelled`(취소).

원인 분류는 자재·공급사, 설비, 작업 방법, 작업자, 측정, 환경, 기타다(4M1E 에 기타를 더했다).

## 명령

| 명령 | 누가 | 뜻 |
|---|---|---|
| 기준 `create`, `update`, `archive`, `unarchive` | `quality` | 측정은 하한이나 상한 중 하나가 있어야 하고 하한 ≤ 상한. N번에 한 번은 N ≥ 1 정수, 비율은 0 초과 100 이하 |
| 기준 `delete` | `quality` | 검사를 만든 기준은 `ERP_IN_USE`. 불량률이 이 기준을 읽으므로 보관한다 |
| 검사 `create` | `quality` | 손으로 만드는 검사(`operation: manual`). 기준이 없는 일회성 검사 |
| `measure{measured_value, note}` | `quality`, `inventory`, `mrp` | 측정 검사의 값. 하한 ≤ 값 ≤ 상한이면 합격, 아니면 불합격(경계 포함). 측정 검사가 아니면 값 없이 합격으로 적는다 |
| `pass{note}`, `fail{note}` | `quality`, `inventory`, `mrp` | 합격·불합격과 작업 확인. 측정 검사에 쓰면 값이 필요하고, 값이 말하는 것과 다르면 `ERP_INVALID` 로 값과 기준을 말한다 |
| `retest` | `quality` | 불합격한 검사를 다시 검사한다. 새 검사(`retest_of`)가 생기고 처음 결과는 그대로 남는다. 이미 기다리는 재검사가 있으면 거부 |
| `cancel{note}` | `quality` | 검사 대기만 |
| 검사 `update` | `quality`, `inventory`, `mrp` | 메모만. 기준은 검사 기준에서 바꾼다 |
| 검사 `delete` | `quality` | 손으로 만든 검사 중 결과가 없는 것만 |
| 경보 `create`, `update` | `quality` | 손으로 여는 경보(고객 불만 등). 끝난 경보는 메모만 |
| `start` | `quality` | 신규 → 조치 중. 담당이 없으면 시작한 사람 |
| `resolve{root_cause, root_cause_note, corrective_action}` | `quality` | 원인 분류와 시정 조치가 있어야 해결로 닫힌다 |
| `cancel{cancel_reason}` | `quality` | 사유 필수(오판, 측정기 오류 등) |
| `reopen` | `quality` | 해결·취소 → 조치 중 |
| 경보 `delete` | `quality` | 손으로 연 신규 경보만. 검사에서 나온 경보는 취소한다 |

결과를 적는 사람은 그 일을 하는 사람이다. 입고 담당(`inventory`)이 받은 물건을, 제조 담당(`mrp`)이 만든 물건을 잰다. 기준과 경보는 품질 담당이 다룬다.

## 검사가 생기는 때

| 듣는 이벤트 | 조건 | 만드는 검사 |
|---|---|---|
| `PickingStateChanged` | `picking_type` 이 `incoming`(입고) 또는 `outgoing`(출고), 반품이 아니고, 상태가 `ready` 나 `done` | 전표의 제품마다, 맞는 기준마다 하나. 수량은 요구 수량. 거래처는 전표의 거래처 |
| `PickingStateChanged` | 상태가 `cancelled` | 그 전표의 검사 대기를 취소 |
| `ManufacturingConfirmed`, `ManufacturingStarted`, `ManufacturingDone` | 완제품에 맞는 제조 기준이 있을 때 | 지시마다 하나. 수량은 완료 수량, 없으면 계획 수량 |
| `ManufacturingCancelled`, `ManufacturingReversed` | | 그 지시의 검사 대기를 취소 |

- **기준이 맞는다**는 것: 사용 중이고, 언제가 같고, 제품이 비었거나 같고, 제품 분류가 비었거나 같고(그 분류에 바로 속한 제품만), 거래처가 비었거나 같다.
- **한 번만.** 검사 ID 는 `기준 + 문서 + 변형` 에서 나온다. 준비되었을 때와 끝났을 때를 모두 듣지만 먼저 들은 쪽만 만든다. 다시 전달되어도, 재시도해도 하나다.
- 사내 이동과 제조의 자재 전표는 검사하지 않는다(`picking_type: internal`).
- 품질 구독이 멈춰도 입고와 제조는 진행된다. 고치면 이어서 한 번만 만든다.

## 얼마나 자주

기준이 만나는 대상에 차례로 번호를 매긴다(`sample_no`, 재검사는 세지 않는다). 그 번호로 정한다. 경계는 `test/quality-cases.json` 에 있다.

| 방식 | n 번째를 검사하는가 |
|---|---|
| 매번 | 언제나 |
| N번에 한 번 | `(n − 1) mod N = 0`. 첫 번째와 그 뒤 N번째마다. N = 1 이면 매번 |
| 비율 p% | `ceil(n × p/100) > ceil((n − 1) × p/100)`. 처음 n 개 중 정확히 `ceil(n × p/100)` 개를 고르게 나눠 검사하고, 첫 번째는 언제나 검사한다 |

**검사하지 않는 대상도 기록한다.** 상태 `skipped`(표본 제외)인 검사가 생긴다. 그래서 「세 번째마다」가 원장에서 다시 셀 수 있고, 무엇이 표본에서 빠졌는지 사람이 볼 수 있다. 난수를 쓰지 않으므로 같은 원장이면 언제나 같은 대상이 뽑힌다. 대신 공급사가 순서를 알면 피할 수 있다. 그게 걱정이면 매번으로 둔다.

## 불량 경보

불합격하면 같은 트랜잭션에서 경보가 하나 열린다. ID 는 검사에서 나오므로 하나다. 제목은 「제품 · 기준 이름」, 내용은 측정값과 기준, 검사자가 적은 메모, 담당은 기준의 경보 담당이다. 재검사가 다시 불합격하면 처음 경보가 열려 있는 동안은 그 경보에 묶고, 닫힌 뒤면 새 경보를 연다.

## 불량률과 직행률

`erp_quality_rates(p_from, p_to, p_as_of)`. 원장의 검사 이벤트 중 가장 새 것으로 셈한다. 되돌린 일과 지운 검사는 빠진다.

- **처음 검사만 센다.** 재검사는 재작업이 됐는지를 말할 뿐, 들어온 물건의 불량을 두 번 세지 않는다. 표본 제외와 검사 대기는 불량에 대해 아무것도 말하지 않으므로 빠진다.
- 기간은 판정한 날(`checked_at`, 회사 시간대)이다.
- **공급사별 불량률:** 입고 검사, 전표의 거래처별 `불합격 ÷ 판정한 검사`. **제품별 불량률:** 모든 검사.
- **제조 직행률(FPY):** 처음 검사가 모두 끝난 제조 지시 중 처음 검사에 하나도 떨어지지 않은 지시의 비율. 재작업 뒤 재검사에 합격해도 직행이 아니다. 기간은 그 지시의 마지막 판정일이다.
- 비율마다 80% 구간(Wilson, `erp_rate_band`)을 붙인다. 견적 전환율, CRM 과 같다.
- 모델 카드 `quality_defects`(불량률·직행률)는 판정한 처음 검사 30건부터 「사용 가능」이다. 판단이다. 30건 중 2건이 불합격이면(6.7%) 80% 구간은 2.8% ~ 15.0% 로 아직 넓다. 그보다 적으면 숫자는 보이되 「근거 부족」이라고 말한다.

## 결정

- **검사는 아무것도 막지 않는다(기록과 경보만).** 입고 확정, 출고, 제조 완료를 검사가 붙잡으려면 재고와 제조가 품질에 물어야 한다. 그러면 품질이 꺼지거나 멈출 때 창고가 멈춘다(M5). 이벤트 모델에 맞는 일반적인 붙잡기 장치를 찾았지만 없었다. 재고의 음수 허용과 같은 생각으로, 기록이 늦을 수 있고 물건은 실제로 들어왔다고 본다. 남는 공백: 불합격한 물건이 재고에 그대로 들어가 팔릴 수 있다. 사람이 경보를 보고 반품이나 폐기를 한다. 다단계 입고(검사 위치)가 재고에 생기면 그 이동을 사람이 검사 뒤에 하는 방식으로 붙잡을 수 있다. 그때도 재고는 품질을 모른다.
- **표본 제외도 문서로 남긴다.** 세는 칸을 기준에 두면 기준의 스트림에 이벤트가 쌓이고, 같은 일을 두 번 들었을 때 셌는지 알 길이 없다. 검사 문서가 있으면 그 존재가 곧 「셌다」이다.
- **검사가 생기는 때는 준비되었을 때다.** 물건이 와서 받기 전에 잴 수 있게 하려고 준비된 입고에서 만든다. 바로 처리한 입고처럼 준비를 건너뛰면 끝났을 때 만든다. 제조는 확정할 때 만들어 만드는 동안 잴 수 있게 한다.
- **측정 검사는 값이 판정한다.** 사람이 합격을 눌러도 값이 기준 밖이면 받지 않는다. MCP 의 `values.state: passed` 는 「측정값 기록」으로 가므로 에이전트는 결과 상태를 다시 읽어 판단한다.
- **손으로 만든 검사와 경보도 같은 문서다.** 기준 없이 생긴 일(고객 불만, 공정 중 발견)도 같은 불량률에 들어간다. 다만 공급사별 불량률에는 입고 검사만 들어간다.

## 나중에 켜기, 끄기

- **M6.** 켜기 전의 입고와 제조는 검사하지 않는다. 켠 뒤 준비되거나 끝난 것부터 검사가 생긴다. 켜기 전에 준비된 입고도 켠 뒤 처리하면 그때 검사가 생긴다.
- **M7.** 끄면 메뉴와 명령이 막히고 검사가 생기지 않는다. 검사, 경보, 불량률은 남는다. 다시 켤 때 밀린 것을 건너뛰면 그동안의 입고는 검사가 없다.

## 되돌리기와 사가

밖으로 나간 것이 없으므로 `compensate` 가 없고 사가는 `rollback` 이다. 구매 확정을 되돌리면 재고가 만든 입고 전표와 품질이 만든 검사가 같은 correlation 이라 함께 돌아간다. 사람이 결과를 적은 검사는 연쇄로 보여 주고 동의를 받는다.

## 화면

메타데이터 화면을 쓴다. 검사 목록에는 「검사 대기」, 「불합격」 필터가 있고, 측정 검사는 「측정값 기록」 단추만, 나머지는 「합격」과 「불합격」 단추만 보인다. 경보 목록은 조치 기한 달력과 단계별 칸반이 있다. 전용 화면은 `AnalysisView`(`/quality/analysis`, 「불량률」): 전체, 공급사별, 제품별 불량률과 제조 직행률, 기간.

## REST 와 MCP

카탈로그에서 자동으로 나온다. `erp_api_quality_point`, `erp_api_quality_check`, `erp_api_quality_alert`. 측정값은 `erp_update {values: {state: 'passed', measured_value}}` 이고 결과 상태는 값이 정한다.

## 시험

`test/quality.test.mjs`, `test/quality-cases.json`, `test/isolation.test.mjs`(정적 검사), `e2e/tests/quality.spec.mjs`.
