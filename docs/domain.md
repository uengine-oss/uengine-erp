# uEngine ERP 도메인 계약

모듈은 이 문서의 이벤트·애그리거트·필드 이름을 공통 언어로 쓴다. 바꾸려면 이 문서를 먼저 고친다.

## 1. 구조 원칙

- 서버가 없다. 브라우저(Vue 3, GitHub Pages)와 사용자 소유 Supabase 프로젝트뿐이다.
- 업무 규칙은 전부 Postgres PL/pgSQL 안에 있다. 브라우저 코드는 믿을 수 없기 때문이다. plv8 은 쓰지 않는다(Postgres 17 에서 지원 종료 예정).
- 쓰기는 `public.erp_command(type, id, command, payload, expected_version, reason, source, correlation_id)` 하나로만 한다. 조회는 `public.erp_records`, `public.erp_events` 뷰와 `public.erp_*` 함수로 한다.
- 비공개 스키마는 `erp`, 공개 API 는 `public.erp_*` 이다. 접근 권한은 `sql/99_grants.sql` 이 한곳에서 닫는다.
- Supabase API 문장 제한은 8초다. 오래 걸리는 작업은 묶음으로 나눠 호출하게 만든다.

### 커널 약속 (`sql/00_core.sql`)

| 함수 | 뜻 |
|---|---|
| `erp.emit(type, id, event, data)` | 유일한 쓰기. 이벤트 추가 → `records` 갱신 → `project` 훅 → `react` 훅 |
| `erp.apply(state, data)` | 유일한 리듀서. `set`·`unset`·`col{name:{add,set,del}}` 만 상태를 바꾼다. 그 밖의 `data` 키는 분석용 사실 |
| `erp.fold(id, at)` | 재생. 시점 조회와 무결성 검증이 같은 리듀서를 쓴다 |
| `erp.register_hook('project'\|'react', stream_type, fn)` | `fn(ev erp.events, before jsonb, after jsonb)`. 다른 모듈의 스트림에도 걸 수 있다 |
| `erp.h_<type>(id, command, payload) returns uuid` | 있으면 그 유형의 명령 처리기. 없으면 `erp.h_generic` |
| `erp.preview_<type>(payload) returns jsonb` | 저장 없이 계산만 한다(화면용 금액 계산) |
| `erp.catalog_put(doc)` | 메타데이터 등록. 화면과 MCP 가 이것으로 동작한다 |
| `erp.now()`, `erp.today()` | 업무 시각. `now()`·`current_date` 를 쓰지 말 것(과거 이력 시드가 불가능해진다) |
| `erp.money(n)` | 회사 통화 자릿수로 반올림(half away from zero). `erp.num(jsonb, default)` |
| `erp.next_number(code, format, pad)` | 트랜잭션 안에서 빈 번호 없는 채번 |
| `erp.fail(code, message)` | 오류. 형식 `ERP_코드: 한국어 문구`. 코드에 따라 HTTP 403·404·409·422·400 으로 나간다 |
| `erp.require_state(id, type)` | 상태를 읽고 없으면 `ERP_NOT_FOUND` |

규칙:
- **효과(effects).** 파생 합계(재고, 총계정원장)는 이벤트의 `data.effects = {"<kind>": [{문자열 차원..., 숫자 측정값...}]}` 로만 바뀐다. `erp.register_effect(kind, apply_fn(ev, row), reset_fn(), check_fn(rows))` 로 등록한다. 차원은 반드시 문자열, 측정값은 반드시 숫자다(되돌리기는 숫자를 부호 반전한다). 시점 합계는 `erp.effects_at(kind, at)`.
- **되돌리기 호환.** 처리기와 훅은 이벤트 이름이 아니라 `state`·`effects` 로 파생 값을 만든다. `Reverted` 이벤트는 react 를 일으키지 않는다. 합계가 음수가 되면 안 되는 kind 는 `check_fn` 을 둔다. 되돌리면 안 되는 상태는 카탈로그 `revert_blocked_states`·`revert_blocked_reason`, 외부에 알려진 이벤트는 `external_events`, 아예 되돌리지 않는 유형은 `revertible:false`.
- **동시성.** `erp.dispatch` 가 처리기 호출 전에 그 애그리거트 행을 잠근다. 처리기는 잠금 뒤 상태를 읽고 규칙을 확인하고 emit 한다. 다른 애그리거트나 파생 표의 값으로 판단할 때(재고 예약 등)는 그 행도 잠근다: `select ... for update` 또는 `update ... where qty - reserved >= n` 후 행 수 확인. 처리기와 판단 함수는 `stable` 로 선언하지 않는다(안정 함수는 호출 시점 스냅샷을 써서 잠금 뒤 최신 값을 못 본다). `erp.require_state` 처럼 읽기만 하는 도우미는 예외다.
- **읽기 권한.** 카탈로그에 `read_roles` 가 있는 유형은 그 역할과 admin 만 읽는다. `security definer` 로 데이터를 돌려주는 공개 함수는 RLS 를 우회하므로 `erp.require_readable(id)` 나 `erp.readable_types()` 또는 `erp.has_role(...)` 로 직접 확인한다.
- **이벤트는 사실이다.** 나중에 재생해도 결과가 같도록, 계산 결과(단가·세액·합계)를 이벤트에 그대로 싣는다. 리듀서는 다른 표를 읽지 않는다.
- **줄 변경은 줄 이벤트로.** 화면이 줄 전체를 보내도 처리기는 차이를 계산해 `...LineAdded/Changed/Removed` 를 낸다. 이력 분석의 재료다.
- **변화가 없으면 이벤트도 없다.**
- 모듈 간 연결은 **구독**뿐이다(`docs/modules/events.md`, `docs/scenario.md` 3절). `react` 훅은 한 모듈 안에서만 쓴다.
- 파생 표(재고 수량 등)는 `project` 훅으로 갱신하고, 이벤트에서 다시 만들 수 있어야 한다.
- 파일은 여러 번 실행해도 같아야 한다: `create table if not exists`, `create or replace`, `drop trigger if exists`, `on conflict do nothing`. **데이터를 지우는 문장 금지.**
- 공개 저장소다. 코드·주석·문구·시험에 특정 경쟁 제품 이름을 쓰지 않는다.

### 카탈로그 문서 형식

```json
{"type":"partner","module":"master","sort":10,"label":"연락처","label_en":"Contact",
 "fields":[{"name":"name","label":"이름","type":"text","required":true,"list":true,"search":true},
           {"name":"parent_id","label":"소속 회사","type":"ref","ref":"partner"},
           {"name":"lines","label":"품목","type":"lines","columns":[{"name":"qty","label":"수량","type":"number"}]}],
 "states":[{"value":"draft","label":"견적","color":"gray"}],
 "transitions":[{"command":"confirm","to":"sale","from":["draft","sent"],"label":"주문 확정","roles":["sales"],"primary":true,
                 "params":[{"name":"x","label":"..","type":"text"}]}],
 "commands":{"create":{"roles":["sales"]},"update":{"roles":["sales"]},"delete":{"roles":["sales"]}},
 "extra_commands":{"update_prices":{"roles":["sales"],"label":"가격 다시 계산"}},
 "write_roles":["sales"]}
```

필드 유형: `text number money integer boolean date datetime enum ref refs tags json lines password`. 추가 속성: `required list search default readonly options[{value,label}] ref unique create_only computed columns help`.

화면 전용 속성(웹 앱 `MetaForm`·`MetaList` 가 읽는다, 없어도 동작한다):
- 필드: `multiline`(긴 입력칸), `hidden`(화면에서 숨김), `sections`(`lines` 에 구역·메모 줄 허용. 열에 `display_type` 을 넣어도 같다), `options_from{path,field}`(같은 줄의 `field` 가 가리키는 레코드의 `state[path]` 에서 선택지를 가져온다).
- 전이·추가 명령: `danger`(위험 표시, 확인·사유 대화상자), `confirm`(확인 문구). `cancel delete reverse void revert reset_to_draft archive merge` 로 시작하는 명령은 자동으로 위험 동작으로 본다.
- 유형: `hidden`(메뉴에서 숨김), `singleton`, `read_roles`. 메뉴는 카탈로그로 설치 여부만 판단하고 역할로 숨기지 않으며, 읽을 수 없으면 목록의 빈 상태 문구가 안내한다.
- 금액 표시: `lines` 가 있는 유형의 `money` + `computed`(또는 `readonly`) 필드는 줄 표 아래 합계 칸에 나오고 마지막 필드가 총계다. `erp.preview_<type>` 은 같은 필드 이름으로 값을 돌려주면 화면에 반영된다.

**MCP 규칙:** 모든 업무 행위는 CRUD 로 표현할 수 있어야 한다.
- 상태 전이: `update` + `{"state": "<to>"}` → 카탈로그 `transitions` 로 명령을 찾는다.
- 다른 문서를 만드는 행위: `create` 로 표현한다(예: `account_move` create `{from_sales_order, method}`, `payment` create, 반품은 `picking` create `{return_of}`).

역할: `admin sales purchase inventory accounting viewer`. `admin` 은 모든 쓰기가 가능하다. 읽기 기본값은 모든 구성원이며, 회계 문서·구매 문서처럼 민감한 유형은 `read_roles` 로 좁힌다.

## 2. 기초데이터 (`sql/10_master.sql`)

| 유형 | 필드 |
|---|---|
| `uom` | `name, category(unit/weight/time/length/volume), ratio, rounding`. `ratio` 는 분류 기준 단위 대비 배수 |
| `product_category` | `name, parent_id, income_account_id, expense_account_id, cost_method(standard/average)` |
| `tag` | `name, color` |
| `account` | `code(unique), name, account_type(asset_receivable, asset_cash, asset_current, asset_non_current, liability_payable, liability_current, equity, income, expense), reconcile, tax_ids, tags`. 매출채권·매입채무는 `reconcile` 을 끌 수 없다 |
| `account_group` | `name, code_prefix_start, code_prefix_end`. 같은 자릿수끼리 겹치지 않고, 계정은 코드가 들어가는 가장 좁은 그룹에 속한다 |
| `bank` | `name, bic` |
| `partner_bank` | `partner_id, acc_number, bank_id, holder_name, trusted`. 새 계좌와 번호를 바꾼 계좌는 믿지 않는다. 명령 `trust`, `untrust` |
| `saved_search` | `name, report, filters, group_by, is_default, shared, owner_id` |
| `tax` | `name, scope(sale/purchase/none), amount_type(percent/fixed/division/group), amount, price_include, include_base_amount, is_base_affected, sequence, children_tax_ids, account_id, invoice_repartition[{id, kind(base/tax), factor_percent, account_id, grids}], refund_repartition[{id, kind(base/tax), factor_percent, account_id, grids}], description` |
| `fiscal_position` | `name, sequence, auto_apply, vat_required, country, country_group, zip_from, zip_to, tax_map[{id, from_tax_id, to_tax_id}], account_map[{id, from_account_id, to_account_id}]` |
| `payment_term` | `name, note, early_discount, discount_percentage, discount_days, discount_mode(included/excluded/mixed), lines[{id, value(percent/fixed), amount, days, delay_type(days_after/days_after_end_of_month/days_after_end_of_next_month/days_end_of_month_on_the), days_next_month}]`. 비율 합은 100, 줄이 없어도 된다 |
| `attribute` | `name, display_type(pills/color/radio/select/multi), create_variant(always/dynamic/no_variant), values[{id, name, color}]`. `multi` 는 `no_variant` 만. 제품에 쓰인 뒤 `create_variant` 변경 금지 |
| `partner` | `company_type(company/person), name, parent_id, address_type(contact/invoice/delivery/followup/other), job_position, phone, mobile, email, website, street, region, city, zip, country, tax_id, ref, industry, lang, tags, salesperson_id, payment_term_id, vendor_payment_term_id, pricelist_id, fiscal_position_id, inbound_payment_method_id, outbound_payment_method_id, invoice_sending_method(manual/email/post), delivery_method, receipt_reminder, receipt_reminder_days, note, merged_into, active`. 명령 `merge{into}` |
| `product` | `type(goods/service/combo), is_storable, name, internal_ref, barcode, category_id, uom_id, purchase_uom_id, list_price, standard_price, sale_ok, purchase_ok, sale_tax_ids, purchase_tax_ids, invoice_policy(order/delivery), bill_policy(order/receipt), tracking(none/lot/serial), weight, volume, customer_lead_days, description_sale, description_purchase, attributes[{id, attribute_id, value_ids, extras:{value_id:price}}], variants[{id, sku, barcode, values:[value_id], name, price_extra, standard_price, active}], vendors[{id, partner_id, min_qty, price, delay_days, vendor_code, discount, date_start, date_end}], combos[{id, name, items[{id, variant_id, extra_price}]}], optional_product_ids` |
| `warehouse` | `name, code, address, stock_location_id`. 코드는 5자 이내 |
| `location` | `name, parent_id, usage(view/internal/customer/supplier/inventory/production/transit), scrap` |

- 속성 없는 제품도 기본 변형 한 줄이 생긴다. 주문·재고는 언제나 `variant_id` 를 쓴다.
- `is_storable` 은 재화만 켤 수 있다(서비스·콤보는 저장할 때 꺼진다). 끈 재화도 전표는 생기고 재고 수량만 변하지 않는다. 재고 모듈을 켜기 전에 만든 제품에는 값이 없고, 없으면 재화는 저장되는 것으로 본다.
- `combo` 제품에는 `combos` 선택 항목이 하나 이상 있어야 하고, 각 항목에는 제품이 하나 이상이며 같은 제품이 겹치지 않고 콤보 제품을 넣을 수 없다. 콤보 자체에는 재고도 세금도 없다. 주문에서 어떻게 값이 매겨지는지는 `docs/modules/sales.md`.
- 가격은 입력한 값을 그대로 저장한다(`list_price`, `standard_price`, 값별 추가 금액, 공급사 단가, 가격 규칙의 고정 가격·추가금·마진). 카탈로그에 `"precise": true` 로 표시한다. 통화 자릿수로 반올림되는 것은 줄 금액부터다.
- 파생 표 `erp.variants(id, product_id, sku, barcode, name, active)` 를 project 훅으로 유지한다. 화면은 뷰 `public.erp_variants` 로 읽는다.
- 함수 `erp.variant(variant_id) returns jsonb`: 변형 + 제품 필드 + `variant_id, product_id, product_name, list_price`(제품 가격 + `price_extra`), `standard_price`(변형 원가, 없으면 제품 원가), `active`(변형과 제품이 모두 사용 중), 없으면 `ERP_NOT_FOUND`. 보관된 변형도 읽힌다(옛 문서용).
- 함수 `erp.uom_convert(qty, from_uom, to_uom)`: 대상 단위의 `rounding` 으로 반올림(반은 올림). 다른 분류면 `ERP_UOM`. 재고가 움직일 때 쓴다. 문서 줄의 수량은 `erp.uom_line_qty` 로 입력한 값을 지킨다.
- `dynamic` 은 주문 줄에서 처음 쓸 때 변형을 만든다: `erp.variant_ensure(product_id, value_ids jsonb) returns variant_id`. 변형을 만드는 속성마다 값이 정확히 하나 필요하고 아니면 `ERP_INVALID`. `no_variant` 값은 섞여 있어도 무시한다. 보관된 변형이면 되살린다. 제품을 잠그므로 동시에 불러도 하나만 생긴다.
- 변형 생성: `always` 는 조합 전체(최대 1000개, 넘으면 `ERP_VARIANT_LIMIT`). `dynamic` 이 하나라도 있으면 미리 만들지 않는다. `no_variant` 는 변형을 늘리지 않고, 그 `extras` 는 변형 가격에 들어가지 않는다. 값이 빠지면 변형은 `active=false` 로 남고, 값이 돌아오면 같은 id 로 되살아난다. 값이 하나뿐인 속성을 더하면 기존 변형이 그대로 이어지고, 그 값은 변형 이름에 나오지 않는다.
- 화면이 변형 줄에서 고칠 수 있는 것은 `sku, barcode, standard_price, active` 뿐이다. 줄을 넣거나 뺄 수 없다.
- 줄 이벤트: 처리기가 차이를 계산해 `<유형><줄>Added/Changed/Removed/Reordered` 를 종류별로 하나씩 낸다. `PaymentTermLine*`, `FiscalPositionTaxMap*`, `AttributeValue*`, `ProductAttribute*`, `ProductVendor*`. 변형은 `ProductVariantAdded/Changed/Archived/Reactivated` 이고 `ProductCreated` 바로 뒤의 `ProductVariantAdded` 에 실린다.
- 줄 컬럼의 추가 속성: `ref: "variant"` 는 `erp_variants` 에서 고른다. `options_from: {field, path}` 는 같은 줄의 `field` 가 가리키는 레코드의 `path` 목록에서 값을 고른다(제품 속성의 `value_ids`).
- 결제 조건 계산: `erp.payment_term_schedule(term_id, amount, invoice_date, untaxed) returns jsonb` → `[{due_date, amount, discount_date?, discount_amount?}]`. `percent` 는 합계의 비율이고 **마지막 비율 줄이 나머지**를 받으므로 합이 정확히 맞는다. `fixed` 는 그 금액이되 남은 금액까지만이라 음수 할부가 없다. 환불은 부호를 유지한다. 0원이 된 회차도 남는다(청구서 기일은 마지막 회차 날짜다). `term_id` 가 없거나 줄이 없으면 청구일 한 줄.
- 기일: `days_after` 청구일 + 일수, `days_after_end_of_month` 청구일의 월말 + 일수, `days_after_end_of_next_month` 다음 달 말 + 일수, `days_end_of_month_on_the` 청구일 + 일수가 속한 달의 월말에서 다음 달 `days_next_month` 일(0 이면 그 월말, 그 달보다 크면 그 달 말일).
- 조기 할인은 100% 한 줄인 조건에만 쓴다. `discount_amount` 는 기한 안에 내면 되는 금액이다. `included` 는 세금 포함 금액, `excluded` 는 `untaxed` 의 `discount_percentage` 를 뺀다. 조기 할인 이익·손실 계정은 회사 설정 `early_discount_gain_account_id`, `early_discount_loss_account_id`.
- `erp.preview_payment_term({lines, early_discount, ..., amount, date, untaxed})` → 그대로 + `schedule`. 저장 전에 아무 금액·날짜로 미리 본다.
- 모르는 필드: 기초데이터도 카탈로그에 없는 필드를 `ERP_UNKNOWN_FIELD` 로 거부한다. 시스템 필드 `active` 와 읽기 전용 필드는 보내도 무시한다. 줄 안의 모르는 칸은 저장하지 않고 넘어간다(화면이 계산 칸을 함께 보낸다).
- 세금 분배: `invoice_repartition`, `refund_repartition` 은 기준 금액 줄 하나와 양수 합 100 인 세금 줄로 짠다. 음수 줄은 역과세, 계정이 빈 줄은 줄의 계정(공제 안 되는 매입세)이다. 두 쪽의 줄 수와 합이 같아야 한다. 비우면 세금 하나가 `account_id` 로 간다.
- 세금 조정 자동 선택(`erp.fiscal_auto`): 국가 없는 연락처는 없음. 세금 번호가 필요한 조정이 먼저(번호가 있을 때), 그다음 우편번호와 국가, 국가, 국가 묶음, 아무 곳 순서, 같으면 `sequence`. 납품처 국가가 있으면 그쪽을 본다. 연락처에 직접 정한 값이 이긴다.
- `public.erp_references(id, limit)`: 그 레코드를 가리키는 문서를 유형·필드별로 돌려준다. `[{type, label, field, count, rows[{id, name, status}]}]`. 켜진 모듈과 읽을 수 있는 유형만.
- `public.erp_lock_status()`: 잠금일, 지금 사용자에게 적용되는 값(`effective`), 고를 수 있는 첫날(`next_open`), 예외 목록.
- `public.erp_saved_searches(report)`: 자기 것과 공유된 저장 검색. `saved_search` 는 만든 사람만 고치고 보고서마다 기본값은 하나다.
- `public.erp_partner_merge_duplicates(fields, dry_run)`: 묶음마다 가장 오래된 연락처로 합친다. 전표에 쓰인 연락처는 뺀다.
- `public.erp_partner_duplicates(fields)`: 고른 항목(`email, name, company_type, tax_id, parent_id, phone`)이 모두 같은 사용 중 연락처 묶음을 돌려준다. 빈 값은 맞는 것으로 치지 않는다. 합치는 것은 사람이 `merge` 로 한다.
- `merge{into}`: 원본은 `merged_into` + `active=false` 로 남고 더 고칠 수 없다(`ERP_MERGED`). 대상의 빈 칸을 원본 값으로 채우고 태그를 합치며, 하위 연락처와 제품 `vendors` 는 대상으로 옮긴다. 발행된 문서의 `partner_id` 는 사실이므로 바꾸지 않는다. 문서를 옮겨야 하는 모듈은 `PartnerMerged` 에 react 한다. 자신의 하위 연락처로는 합칠 수 없다.
- 기본 시드(`erp.default_seeds`). ID 는 `erp.seed_id('이름')`(이름에서 만든 고정 uuid)으로 얻는다. 이름은 아래 그대로다.
  - 단위: `개`, `다스`, `g`, `kg`, `톤`, `시간`, `일`, `cm`, `m`, `km`, `mL`, `L`
  - 세금: `부가세 10% 매출`, `부가세 10% 매입`, `영세율 매출`, `영세율 매입`, `면세 매출`, `면세 매입`
  - 결제 조건: `즉시`, `15일`, `30일`, `30%선금+잔금 60일`
  - 계정과목: `현금`, `보통예금`, `외상매출금`, `선급금`, `부가세대급금`, `상품`, `비품`, `외상매입금`, `부가세예수금`, `선수금`, `자본금`, `이월이익잉여금`, `상품매출`, `잡이익`, `상품매출원가`, `대손상각비`, `재고자산감모손실`, `잡손실`
  - 분류: `기본 분류`. 창고: `WH`. 위치: `재고`, `공급사`, `고객`, `재고조정`, `폐기`, `생산`. 가격표: `기본 가격표`
- 회사 설정의 기본 세금 `default_sale_tax_id`, `default_purchase_tax_id` 는 새 제품의 기본값이다. `default_price_include` 는 포함 여부를 밝히지 않은 새 세금의 기본값이다. 이 필드들은 `10_master.sql` 이 회사 카탈로그에 더한다. 새 제품의 단위와 분류 기본값은 시드 `개`, `기본 분류` 다.

## 3. 가격 (`sql/20_pricing.sql`)

`pricelist`: `name, currency, sort, country_group, rules[{id, apply_on(all/category/product/variant), category_id, product_id, variant_id, min_qty, date_start, date_end, price_type(discount/formula/fixed), discount, fixed_price, base(list_price/standard_price/pricelist), base_pricelist_id, formula_discount, round_to, surcharge, min_margin, max_margin}]`

- `erp.price_for(pricelist_id, variant_id, qty, on_date, uom_id) returns jsonb` → `{price_unit, list_price, discount, rule_id}`. 선택 순서: 구체적인 대상(변형 > 제품 > 분류 > 전체), 그다음 기준 수량이 큰 쪽, 그다음 가까운 분류, 그래도 같으면 나중에 넣은 규칙. 기준 수량은 제품 단위로 재고, 시작일과 종료일은 날짜로 비교하고 모두 그날을 포함한다. 맞는 규칙이 없거나 가격표가 `null` 이면 정가.
- `discount` 유형은 할인율을 줄의 `discount` 로 보여 주고, `formula`·`fixed` 는 단가에 녹인다. `formula` 순서: 기준 가격에서 `formula_discount`(음수면 할증) → `round_to` 반올림(반은 올림) → `surcharge` → `기준 + min_margin` 이상, `기준 + max_margin` 이하(0 이면 그 한도 없음). 최소 마진을 넣으려면 그보다 큰 최대 마진도 넣어야 한다. `base=pricelist` 의 기준 가격은 그 가격표의 할인까지 뺀 값이다. 가격과 추가금·마진은 요청 단위로 바꿔서 계산한다.
- `price_unit`, `list_price` 는 단가이므로 통화 자릿수로 자르지 않는다. 입력한 값은 그대로이고, 환산과 계산식에서 생긴 끝수만 소수 10자리에서 정리한다. 금액은 `tax_compute` 가 줄 합계에서 반올림한다.
- `erp.tax_compute(price_unit, qty, discount, tax_ids jsonb, fiscal_position_id) returns jsonb` → `{subtotal, tax, total, taxes:[{tax_id, name, base, amount, account_id}], tax_ids, price_unit}`. 줄 단위 반올림: 줄 합계(`단가 × 수량 × (1 - 할인)`)를 먼저 반올림한다. `price_include` 세금은 그 합계에서 뺀다. 고정 금액을 먼저 빼고, 나눗셈 세금은 남은 금액의 비율이며, 비율 세금은 합쳐서 한 번에 나눈다. 세금마다 반올림하고 `subtotal` 은 남은 금액이다. 별도 세금은 `subtotal` 에 매긴다. 고정 금액 세금은 수량을 곱하고 할인과 무관하다.
- 세금 유형: `division` 은 세금 포함 금액에 대한 비율이다(별도 10% 면 900 → 세금 100, 별도 여럿은 나누는 수를 합친다). `group` 은 `children_tax_ids` 로 풀리고 줄의 `tax_ids` 에는 그룹이 남는다. 같은 세금이 두 번 닿아도 한 번만 계산한다. 그룹 안에 그룹은 안 되고 적용 범위가 같아야 한다. 음수 세율은 원천세로 허용한다.
- 세금 순서는 `sequence`, 그다음 먼저 만든 세금이다(줄에 고른 순서가 아니다). 세금끼리는 독립이지만 `include_base_amount` 세금의 금액은 그 뒤의 `is_base_affected`(기본 켜짐) 세금 기준에 더해진다: 1000 + 고정 100 + 1100 의 10% = 세액 210.
- 세금 조정은 `tax_ids` 를 바꾼다(대상이 비면 제거, 한 세금이 여럿으로 갈 수 있음). 원래 세금이 **전부 포함 세금**일 때 조정으로 세금이 바뀌면 단가도 바뀐다: 원래 세금을 빼고 새 포함 세금을 더한다. 줄에는 결과의 `price_unit` 과 `tax_ids` 를 저장한다. 그 값으로 다시 계산해도 금액이 같다. 조정이 없으면 `price_unit` 은 들어온 값 그대로다.
- `erp.combo_item_price(parent_variant jsonb, parent_price, item_id) returns jsonb` → 항목 + `price_unit`. 콤보 판매가를 선택 항목마다 그 항목에서 가장 싼 제품의 정가 비율로 나누고 그 제품의 `extra_price` 를 더한다. 없는 항목이면 `null`.
- `public.erp_price(pricelist_id, variant_id, qty, date, uom_id)` 는 화면이 호출한다. 기본 가격표 시드는 `erp.seed_id('기본 가격표')`.

## 4. 모듈

모듈별 계약은 `docs/modules/` 에 있다. 모듈 사이의 이벤트는 `docs/modules/events.md` 가 원본이다. 회사가 모듈을 어떻게 더해 가는지는 `docs/scenario.md` 를 본다.
