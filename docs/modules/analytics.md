# 분석 (`sql/70_analytics.sql`, `web/src/lib/forecast/`)

분석은 원장만 읽는다(M8). 모듈의 파생 표(`erp.quants`, `erp.gl_lines` 등)를 읽지 않으므로, 모듈을 꺼도 쌓인 이력은 그대로 쓸 수 있다. 제품·단위·창고·위치·계정과목의 현재 값은 `erp_records` 로 읽는다.

SQL 은 사실을 돌려주고, 계산은 브라우저에서 한다. 모든 함수는 호출자 권한으로 `erp_events`·`erp_records` 뷰를 읽으므로 RLS 를 그대로 따른다. 읽을 수 없는 문서 유형에서 나온 숫자는 받을 수 없다.

**아래 숫자는 전부 생성기로 만든 가상 회사의 결과다. 실제 회사의 성능이 아니다.** 생성기와 추정기는 같은 가정(부드러운 계절, 일정한 발주 방식, 품절이면 못 판 수요)을 공유하므로 실제 회사에서는 이보다 나쁠 것으로 보아야 한다.

## SQL API

날짜는 회사 시간대의 하루다. `p_as_of` 를 주면 그 시각에 시스템이 알던 것만 읽는다. 없으면 지금이다. 시계열은 `[p_from, p_to)` 구간을 받으며, 구간은 이벤트가 기록된 때로 나눈다. 소급 입력은 입력한 때의 묶음에 들어가고 자기 업무일의 행으로 나오므로, 묶음을 더하면 맞는다. 묶어 부르는 일은 `loadLedger` 가 한다.

| 함수 | 결과 |
|---|---|
| `erp_models(p_as_of)` | `[{id, kind, label, state, missing_modules, modules, stale_modules, forbidden?, evidence:{have, need, unit, message, ...}, since}]` |
| `erp_analytics_context(p_as_of)` | `{as_of, timezone, modules:{id:{enabled, periods:[{from, to}]}}, extent:{first_day, last_day}, warehouses, variants}` |
| `erp_sales_daily(p_from, p_to, p_as_of)` | `[[day, variant_id, region, warehouse_id, qty, revenue, cost]]`. 수량은 제품 단위. 취소·재확정·수량 변경·되돌리기 반영. 서비스 줄 제외 |
| `erp_stock_daily(p_from, p_to, p_as_of)` | `[[day, variant_id, warehouse_id, delta]]`. `effects.quant` 를 위치에서 창고로 올려 합친다. 내부 위치만 |
| `erp_stockout_days(p_from, p_to, p_as_of)` | `[{variant_id, warehouse_id, from, to, days}]`. `to` 는 포함하지 않는다 |
| `erp_receipts_daily(p_from, p_to, p_as_of)` | `[[day, variant_id, warehouse_id, qty, origin_type, origin_id]]` |
| `erp_lead_times(p_from, p_to, p_as_of)` | `[{po, line_id, vendor_id, variant_id, warehouse_id, ordered_on, planned_on, qty, received, first_received_on, last_received_on}]`. 미입고 줄 포함 |
| `erp_payment_delays(p_from, p_to, p_as_of)` | `[{id, partner_id, date, due_date, amount, paid, residual, paid_on, state}]`. 고객 청구서만. 미입금 포함 |
| `erp_journal_monthly(p_from, p_to, p_as_of)` | `[[month, account_id, account_type, name, amount]]`. 손익 계정만. 구간은 효과 행의 회계일(`r ->> 'date'`)로 거른다. 회계를 늦게 켜면 전표가 그때 다시 만들어지므로 기록 시각은 기간을 말해 주지 않는다 |
| `erp_reorder_rules(p_as_of)` | `[{variant_id, warehouse_id, min_qty, max_qty, vendor_id}]`. 수동 규칙 제외 |
| `erp_flow_stats(p_from, p_to, p_as_of, p_grain)` | `{grain, from, to, rows:[{period, region, product_id, qty, revenue, margin, orders}]}`. `p_grain` 은 `day week month quarter year` |
| `erp_quote_conversion(p_from, p_to, p_as_of)` | `{quotes, won, lost, open, rate, low, high, decided_rate, median_days}`. `low`·`high` 는 80% 구간 |
| `erp_headcount(p_on, p_as_of)`, `erp_headcount_trend(p_from, p_to, p_as_of)` | 그날의 재직 인원과 부서, 달별 입퇴사와 인원. 업무 날짜와 원장 시점이 따로다. `docs/modules/hr.md` 참고 |
| `erp_mrp_lead_times(p_as_of)`, `erp_mrp_materials(p_weeks, p_as_of)`, `erp_mrp_whatif(p_variant_id, p_factor, p_as_of)` | 실측 제조 기간, 자재 소요, 생산량 변경 시 자재 소진일. `docs/modules/mrp.md` 참고 |

도우미: `erp_analytics_tz`, `erp_biz_day`, `erp_undone`, `erp_module_spans`, `erp_unit_maps`, `erp_location_map`, `erp_sales_lines`, `erp_mrp_done_rows`, `erp_mrp_part_use`.

### 되돌리기

되돌린 주문은 판매에서 빠지고(`erp_undone`), 되돌리기를 되돌리면 다시 들어온다. 재고는 `Reverted` 의 반대 효과로 그 시점에 맞게 고쳐진다. 그래서 재고 이력은 "그때 시스템이 믿은 값"과 "그 뒤의 정정"을 함께 보여 준다.

### 모듈이 꺼졌을 때

`잠김`은 필요한 모듈이 한 번도 켜진 적 없을 때다. 켰다가 끈 경우는 모델마다 다르다.

- 이력만 읽는 모델(`stat_sales`, `quote_conversion`, `demand_sales`, `demand_true`, `whatif_drop`, `lead_time`, `pnl_outlook`, `stat_headcount`, `payroll_cost`, `whatif_headcount`)은 쌓인 이력으로 계속 계산하고 `stale_modules` 에 그 모듈을 적는다(M8).
- 이력만 읽는 모델(`stat_sales`, `quote_conversion`, `demand_sales`, `demand_true`, `whatif_drop`, `lead_time`, `pnl_outlook`, `depreciation_outlook`)은 쌓인 이력으로 계속 계산하고 `stale_modules` 에 그 모듈을 적는다(M8).
- 지금 재고나 미결 청구서가 있어야 하는 모델(`stockout_risk`, `whatif_policy`, `whatif_realloc`, `whatif_lead`, `reorder_plan`, `cash_in`, `whatif_terms`)은 잠긴다.
- 이력만 읽는 모델(`stat_sales`, `quote_conversion`, `demand_sales`, `demand_true`, `whatif_drop`, `lead_time`, `pnl_outlook`, `stat_headcount`, `mrp_lead_time`)은 쌓인 이력으로 계속 계산하고 `stale_modules` 에 그 모듈을 적는다(M8).
- 지금 재고나 미결 청구서가 있어야 하는 모델(`stockout_risk`, `whatif_policy`, `whatif_realloc`, `whatif_lead`, `reorder_plan`, `cash_in`, `whatif_terms`, `mrp_materials`, `whatif_production`)은 잠긴다.

문서를 읽을 권한이 없는 사람에게 그 문서로 계산하는 모델은 `state: locked, forbidden: true` 이고 건수도 0 이다.

## 브라우저 API (`web/src/lib/forecast/index.ts`)

```ts
const data = await loadLedger(rpc, { asOf, onProgress })   // rpc 는 lib/api.ts 의 것
const panel = buildPanel(data)
```

| 함수 | 입력 | `result` |
|---|---|---|
| `demandSales(panel, {days, runs, seed, gap_filter})` | | `{from, days, rows:[{variant_id, name, region, units:Band, revenue:Band, expected}], by_variant, total_units, total_revenue, sigma}` |
| `demandTrue(panel, {days, runs, seed})` | | 위와 같다 |
| `stockoutRisk(panel, {days})` | | `{rows:[{variant_id, name, warehouse_id, stock, prob_out, out_in_days:Band|null, out_on}], days}` |
| `whatIfPolicy(panel, {changes:[{variant_id, warehouse_id?, q_mult, rop_mult}], days})` | S8 증산 | `{base, scenario, delta, base_reliable}` |
| `whatIfRealloc(panel, {variant_id, from_warehouse, to_warehouse, from_mult, to_mult, days})` | S8 재배치 | 위와 같다 |
| `whatIfDrop(panel, {variant_id, substitutes?, days})` | S8 라인업 | 위 + `rates:[{to, name, rate:Band, episodes, days, lost_units}]` |
| `whatIfLead(panel, {to_days? or scale?, vendor_id?, days})` | S8 납기 | 위 + `from_mean, to_mean, scale` |
| `leadTime(panel)` | | `{all, by_vendor:[{vendor_id, received, open, median_days, p90_days, mean_days:Band, on_time}]}` |
| `reorderPlan(panel, {days, cover_days})` | | `{rows:[{variant_id, name, warehouse_id, stock, on_order, order_by, need_now, out_in_days_p10, lead_p90, suggest_qty}]}` |
| `cashIn(panel, {days})` | | `{from, days, total:Band, from_open, from_new, weekly:Band[], open_total, overdue_total, late_median, late_p90}` |
| `whatIfTerms(panel, {from_days?, to_days, partner_ids?, days})` | S8 결제 조건 | `{from_days, to_days, base, scenario, delta:Band, pass_through:Band, cases}` |
| `pnlOutlook(panel, {months, whatif?:{margin:Band}})` | 손익, what-if 환산 | `{months:[{month, revenue, profit}], revenue, cogs, opex, profit, profit_with_whatif, gross_margin_rate, opex_per_month, history_months}` |

`Measures` 는 `{revenue, margin, stockout_days, stock_value, lost_units}` 이고 각각 `Band{p10, p50, p90}` 이다.

모두 `ModelResult` 를 돌려준다.

```ts
{ id, kind, state, input,
  result,    // state 가 ready 일 때만
  range,     // 근거 부족일 때 할 수 있는 말: {low, high, unit, note}
  verdict,   // what-if: {code: up|down|indistinguishable, text}. 구간이 0 을 포함하면 "구분할 수 없음"
  evidence,  // {have, need, unit, message, from, to, cases?}
  warnings } // 사용자에게 보여 줄 문구
```

`erp_models()` 는 회사 전체의 근거를, 이 함수들은 그 제품·공급사의 근거를 본다. 그래서 `erp_models()` 가 `ready` 여도 한 제품의 단종은 `insufficient` 일 수 있다. 화면은 함수 결과의 `state` 를 따른다.

브라우저 계산은 제품 36개·지역 3·창고 3·943일에서 모델 하나에 약 1초다(로컬, 첫 호출). 화면은 Web Worker 에서 돌리고 진행률을 보여 준다. 대체 후보 쌍은 400개까지만 본다.

### 구조

| 파일 | 하는 일 |
|---|---|
| `panel.ts` | 행을 일별 배열로. 어떤 제품·지역·창고도 이름으로 알지 않는다. 행 순서와 무관하게 같은 결과 |
| `demand.ts` | 지역·계절(파동 3개)·요일·성장 포아송 회귀, 과거 시점 검증으로 오차 폭 추정 |
| `substitution.ts` | 품절을 자연 실험으로 대체율 추정 |
| `policy.ts` | 재주문 규칙 > 구매 주문 > 입고 기록 순으로 발주 방식과 납기 파악 |
| `simulate.ts`, `context.ts` | 같은 수요·같은 납기로 원안과 변경안을 나란히 돌림 |
| `whatif.ts`, `forecast.ts`, `lead.ts`, `cash.ts`, `pnl.ts` | 모델 |
| `thresholds.ts` | 근거 임계값. SQL 과 같은 값이어야 하며 시험이 확인한다 |

## 추정 방법과 고친 것

**대체율 과대 추정.** 처음 시험에서 제습기→서큘레이터를 0.37(실제 0.2)로 읽었다. 품절이 성수기에 몰리는데, 두 제품 모두 그때 평소보다 많이 팔리고, 월 단위 계절로는 그 정점을 낮게 읽기 때문이다. 고친 방법은 둘이다. 계절을 달력 월이 아니라 부드러운 파동으로 읽고, B 의 기준을 장기 곡선 대신 품절 앞뒤 21일의 B 자기 수준으로 잡는다. 시드 1~60 에서 0.22(실제 0.2), 나머지 쌍은 실제 0.15→0.15, 0.35→0.38, 0.50→0.57 이다. 아직 약간 높다.

**구간.** 첫 시험의 80% 구간은 실제를 63% 만 담았다. 한 시점·한 제품으로 오차 폭을 정했기 때문이다. 이제 과거 네 시점·전 제품을 모아 폭을 정하고, 회귀 계수의 불확실성을 따로 뽑으며, 폭 자체가 추정이므로 정규분포 대신 t 분포를 쓴다. 대체율은 품절 사례 단위로, 납기는 입고 단위로 다시 뽑는다.

**납기가 미래에서 샜다.** 첫 시험은 미입고 주문의 실제 도착일을 추정기에 넘겼다. 이제 약속일만 준다.

**미입금·미입고.** 입금된 청구서만 보면 늦게 내는 고객이 빠져 지연이 짧게 읽힌다. 미입금은 "아직 안 끝남"으로 넣는다(Kaplan-Meier).

**결제 조건.** 조건을 줄인다고 고객이 그대로 따르는지는 입금 기록 건수로 알 수 없다. 자기 조건이 바뀐 거래처만 말해 줄 수 있다. 거래처끼리 비교하면 느린 고객에게 긴 조건을 주는 경향이 섞이므로 보고만 하고 쓰지 않는다. 바뀐 거래처가 모자라면 "안 따를 때(0)~다 따를 때" 범위만 낸다.

**재현 검증.** 이 모델로 최근 180일을 돌려 실제 매출과 20% 넘게 어긋나면 경고한다. 가상 회사 60곳에서는 한 번도 안 떴고(오탐 0), 실제와 동떨어진 재주문 규칙을 준 시험에서는 떴다. 실제 회사에서 얼마나 자주 뜰지는 모른다.

## S7. 단계별 오차

품절 18% 회사 60곳(시드 1~60, 개발에 쓰지 않은 시드), 중앙값. 재고 2025-01, 구매 2025-07 에 켠다. 켜기 전의 재고는 모르는 채로 계산한다. 여름은 2026-05 말까지로 2026 여름을, 겨울은 2025-11 말까지로 그 겨울을 예측한다. 오차는 제품·지역별 실제 수요 대비(WAPE). `experiments/whatif/results-s7-x1.json`.

| 단계 | 여름 오차 (치우침) | 겨울 오차 (치우침) | 80% 구간이 실제 수요를 담은 비율 |
|---|---|---|---|
| 판매만 | 32.3% (-30.2%) | 24.9% (-21.0%) | 50% |
| 판매만 + 끊김 제외 | 9.5% (+0.9%) | 12.6% (-1.4%) | 100%, 94% |
| + 재고 | 9.5% (-0.2%) | 12.7% (-0.3%) | 83%, 72% |
| 처음부터 전부 | 9.9% (-0.4%) | 11.8% (+0.8%) | 78%, 72% |

**판매 기록의 끊김만 빼도 재고 이력과 정확도가 같다.** 이 생성기에서 품절은 며칠씩 이어지는 깨끗한 공백이기 때문이다. 판매량을 1/10 로 줄여도 판매만 35.8%, 끊김 제외 14.4%, + 재고 15.4% 로 같은 모습이다. `demand_sales` 의 기본값은 끊김 제외를 켠 것이다. 다만 이 일치는 이 생성기에서 품절이 깨끗한 공백으로 나타나기 때문이고, 실제 회사에서 일부만 품절되는 경우에는 재고 기록이 더 나을 수 있다. 실제 데이터로 다시 재야 한다.

판매만 모델의 구간은 실제 **판매**를 78%·67% 담는다. 공급이 그대로면 판매 예측으로는 쓸 만하고, 수요로 읽으면 틀린다.

| what-if (실제 변화) | + 재고 | + 구매 | 처음부터 전부 |
|---|---|---|---|
| 여름 상품 발주 2배 (+3.89억) | +3.86억, 오차 10.5%, 구간 92% | +3.87억, 12.2%, 85% | +3.85억, 11.6%, 82% |
| 보급형 단종 (-2.51억) | -2.27억, 13.4%, 83% | -2.41억, 13.2%, 85% | -2.44억, 9.8%, 83% |
| 납기 절반 (+4.21억, 품절일 -159) | 잠김 | +4.20억, 10.4%, 78%. 품절일 -161 | +4.26억, 10.2%, 77% |
| 제습기 수도권→호남 (0.00억) | 전부 "구분할 수 없음" | 전부 "구분할 수 없음" | 전부 "구분할 수 없음" |

판매만 단계의 단종은 -5.61억 ~ +5.64억 범위만 낸다. 실제(-2.51억)는 60곳 모두 범위 안이다. 쓸모가 크지 않은 넓은 범위지만 틀리지는 않는다.

**구매 없는 단계의 기준 매출은 믿으면 안 된다.** 변화 없는 시즌 매출의 오차가 10.3%, 구간 포함 23% 다(구매 있으면 2.7%, 77%). 납기와 발주점을 입고 기록에서 추정한 값이 함께 어긋나(발주점 약 1.3배, 납기 약 15일. 실제 11.5일) 변화량에서는 상쇄되지만 수준에서는 안 된다. `base_reliable: false` 와 경고를 함께 낸다.

재고가 넉넉한 회사(품절 4.6%, `results-s7-x2.5.json`)는 더 어렵다. 발주 2배(실제 +1.56억)는 + 재고 +2.81억(오차 77%, 구간 93%), + 구매 +1.63억(37%, 72%), 전부 +1.69억(29%, 70%)이다. 방향은 모두 맞다. 단종은 60곳 모두 사례가 모자라 범위만 나오고, 실제는 60곳 모두 그 범위 안이다. 품절 18% 회사는 60곳 모두 계산되며 오차 13.2%, 구간 85% 다.

## 측정한 임계값

규칙은 결과를 보기 전에 `experiments/whatif/thresholds.mjs` 머리에 적었다. "이 수준과 그 위 모든 수준이 통과하는 가장 작은 값"이다. 회사 30곳(시드 3001~3030), `results-thresholds.json`.

- 예측: 오차가 근거가 가장 많을 때의 1.25배 이하, 구간 포함 70% 이상
- what-if: 오차 30% 이하, 구간 포함 70% 이상, 방향을 말하면 90% 이상 맞음

| 모델 | 시나리오 표 | 측정 | 적용 | 임계값 아래에서 틀리는 정도 |
|---|---|---|---|---|
| `quote_conversion` | 견적 30건 | 40건 | 40건 | 30건에서 80% 구간 반폭 10.3점 |
| `demand_sales` | 판매 12개월 | 15개월 | 15개월 | 12개월 17.3%, 9개월 34.9%, 6개월 75.0% (15개월 12.9%, 24개월 10.8%). 판매량 1/10 회사는 12개월 |
| `demand_true` | 재고 90일 | 재고 30일 + 판매 12개월 | 같음 | 재고 이력은 문턱이 아니다(30일 9.6%, 517일 8.4%). 판매가 문턱이다: 첫날부터 켠 회사 270일 18.3%, 180일 81.4%, 365일 10.1% |
| `stockout_risk` | 재고 90일 | 30일 | 30일 | 30일에서도 Brier 0.04(기준 0.24), 날짜 오차 1일 |
| `whatif_policy` | 재고 90일 | 구매 없이 270일, 구매 있으면 180일 | 같음 | 구매 없이 90일 93.8%·구간 0%, 120일 79.7%·0%, 180일 33.2%·50%. 구매 있으면 90일 46.5%·0%, 120일 15.2%·60%. 판매 이력도 9개월(첫날부터 켠 회사 180일 32.9%·93%, 90일 64.5%·27%) |
| `whatif_realloc` | 창고 2곳, 재고 90일 | 180일 | 180일 | 180일 아래는 입고 사례가 없어 계산 자체가 안 된다 |
| `whatif_drop` | 품절 사례 | 5건 | 5건 | 1~2건 27.6%·구간 44%·대체율 오차 0.28, 3~4건 19.3%·67%·0.14, 5~9건 11.6%·75%·0.07. 0건은 범위만, 범위 포함 100%(1068건) |
| `lead_time` | 입고 10건 | 10건 | 10건 | 3건 13.0%·67%, 5건 7.4%·67%, 10건 4.7%·80% |
| `whatif_lead` | 입고 10건 | 5건 | 10건 | 납기 평균을 나누어 쓰므로 `lead_time` 과 맞췄다 |
| `reorder_plan` | 입고 10건 | 30건 | 30건 | 발주 기한을 지켰을 때 품절 전 도착: 10건 68%, 20건 85%, 30건 94%, 50건 98% |
| `cash_in` | 입금 30건 | 101건 | 100건 | 오차는 어디서나 작다(1~10건 6.1%, 21~30건 5.0%, 51~100건 5.3%). 구간이 좁다: 60%, 72%, 63%. 101~300건 74%, 301건 이상 86% |
| `whatif_terms` | 입금 30건 | 입금 + 조건이 바뀐 거래처 2곳 | 3곳 | 0곳 범위만, 범위 포함 100%. 1곳 36.9%·43%, 2곳 16.2%·77%, 3곳 24.8%·70% |
| `pnl_outlook` | 전표 3개월 | 1개월 | 3개월 | 1개월 7.6%. 가상 비용에는 일회성과 계절이 없어 믿지 않고 3개월을 유지했다 |
| `depreciation_outlook` | 자산 이력 12개월 | 9개월 | 12개월 | 구간 포함 3개월 53.0%, 6개월 69.5%, 9개월 73.7%, 12개월 77.1%, 36개월 79.7%. 위 30곳 측정과 별도로 회사 2000곳으로 쟀다. 지금 있는 자산의 금액은 계산이라 오차가 없다. [assets.md](assets.md) |

결과를 본 뒤 정한 것: 사례 30건 미만 칸은 판정에서 뺐다(단종의 40건 이상 칸이 13건 69.2% 로 답을 막았다). `reorder_plan` 의 기준 "기한의 90% 이상이 지켜짐"은 결과를 본 뒤 정했다. 계획이 품절 위험 약 10% 를 약속하므로 그에 맞춘 것이다. 입금 모델은 첫 측정(시드 2001~)에서 구간이 너무 좁아 개발 시드로 고친 뒤 새 시드로 다시 쟀다. `whatif_terms`·`whatif_lead`·`pnl_outlook` 의 적용값은 규칙보다 보수적이다.

## 구간 포함률

목표 80%. 시드 1~60(입금은 1~40), 품절 18% 회사.

| 무엇 | 포함률 |
|---|---|
| 수요 예측 (제품·지역별) | 여름 83%, 겨울 72% |
| 발주 2배 | + 구매 85%, 전부 82%, + 재고 92% |
| 단종 | 83~85% |
| 납기 절반 | 77~78%, 품절일 77% |
| 재배치 | 80~100% (판정을 안 하므로 넓다) |
| 변화 없는 시즌 매출 | + 구매 77%, 전부 82%, **+ 재고 23%** |
| 입금 예측 | 82.5%, 오차 2.4% |
| 결제 조건 30일→15일 | 72.5%, 오차 20.5% |
| 손익 | 90~97%, 넓다 (오차 3~8%) |
| 대체율 자체 | 제품 쌍별 65~72%, 사례 10건 이상 칸에서 77~79%. 목표보다 좁다 |
| 품절 4.6% 회사의 발주 2배·납기 | 70~73% |

## 안 되는 것

- **재배치 크기.** 회사별 오차가 약 100%, 방향은 53~55% 다. 두 창고가 모두 모자라면 한쪽의 이득이 다른 쪽의 손실이라 효과가 잡음보다 작다. 그래서 60곳 모두 "구분할 수 없음"이라고 말한다. 틀린 주장은 0건이다. 한 창고에 과잉, 다른 창고에 부족이 뚜렷한 회사에서는 판정을 내리고(옮기면 이득인 경우 27%, 나빠지는 경우 77%) 그 판정은 전부 맞았지만, 크기 오차는 이득 쪽이 65%(실제 +0.55억, 예측 +0.37억)다. 크기는 믿지 말고 방향만 읽어야 한다.
- **구매 없는 단계의 기준 매출.** 위와 같다. 변화량만 쓴다.
- **재고가 넉넉한 회사의 what-if 크기.** 효과가 작아 오차 30~37%, 구매 없으면 77% 다.
- **없는 대체 관계를 있다고 하는 경우.** 사례 3건 이상인 가짜 쌍의 7.5%(같은 분류 안), 2.8%(분류 없음)가 `usable` 이 된다. 시뮬레이션에 작은 대체율이 끼어든다.
- **주문이 기다리는 회사.** 이 ERP 는 재고가 없어도 주문을 받는다. 시뮬레이션은 못 채운 수요를 잃은 매출로 친다. 주문이 기다렸다 나가는 회사라면 발주 what-if 가 과대해진다. 품절 중 주문이 평소의 40% 를 넘으면 경고하지만 보정은 하지 않는다. 생성기에 이런 회사가 없어 오차는 재지 않았다.
- **출고 지연.** 재고는 출고 때 줄고 주문일과 어긋난다. 생성기는 같은 날이다. 재지 않았다.
- **클라우드.** 시간은 로컬에서만 쟀다.

## 속도

이벤트 241,416건(261 MB, 전표 6만 건 포함), 로컬. `results-speed.json`.

| 호출 | 가장 오래 걸린 한 번 |
|---|---|
| `erp_models` | 390 ms |
| `erp_sales_daily` (92일 묶음 11번, 8.9 MB) | 68 ms |
| `erp_stock_daily` | 34 ms |
| `erp_payment_delays` | 473 ms |
| `erp_journal_monthly` (묶음 없이 한 번) | 1,645 ms |
| `erp_stockout_days` | 180 ms |
| `erp_flow_stats` | 522 ms |

## 다시 재기

```
source scripts/local-env.sh
node experiments/whatif/s7.mjs                      # POLICY_MULT=2.5, VOLUME=0.1
node experiments/whatif/thresholds.mjs              # ONLY=stock,drop,... VOLUME=0.1
node experiments/whatif/cash.mjs
ERP_SQL_OUT=<파일> node experiments/whatif/speed.mjs
```

`run.mjs`, `results-x1.json`, `results-x2.5.json` 은 고치기 전의 첫 시험 기록이다.
