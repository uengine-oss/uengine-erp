# E2E — erp-modules

모듈을 켜고 끄고, 구독자가 멈추고, 플러그인이 붙었다 떨어지는 일을 실제 다섯 모듈과 시험용 작은 모듈로 확인한다. 32개 조합은 조합마다 회사를 하나씩 만들어 돌린다. 브라우저 시험은 실제 판매·재고 모듈의 구독을 일부러 고장 내고 화면을 본다. `api.e2e.mjs` 의 플러그인 시험은 실제 `pg_cron` 이 전달하는지 본다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/bus.test.mjs test/isolation.test.mjs test/plugin.test.mjs test/growth.test.mjs
source scripts/local-env.sh && SETUP_CODE=<설치 코드> node --test test/api.e2e.mjs   # scripts/reset-local.mjs, scripts/install-local.mjs <설치 코드> 뒤에. 로컬 스택의 postgres DB 를 쓴다
source scripts/local-env.sh && npm run test:e2e -- modules.spec.mjs growth.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, HTTP 시험은 로컬 스택의 API(:56321)와 `pg_cron`, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택. `growth.spec.mjs` 는 한 회사를 S1 부터 차례로 키우는 직렬 시험이다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 플러그인 유형 | `expense-privacy.test.mjs › the kernel: read_scope works from the catalog for any type, and a type without one reads as before` | SQL | ✅ |
| 되돌리기 계획 | `expense-privacy.test.mjs › an approver's agent plans the undo of its own approval: the entry it may not read is counted, not named, and the plan still runs` | SQL | ✅ |
| 사가 상태 | `expense-privacy.test.mjs › the claimant's agent undoes its own work by key: cancelled, the reason kept outside, its name kept off the plan for what it may not read` | SQL | ✅ |
| 새 회사는 판매만 켜진다 | `growth.test.mjs › S1. a new company starts with sales alone`<br>`modules.spec.mjs › S1. 판매만 켜져 있으면 메뉴에 판매만 있고, 재고 명령은 거부된다`<br>`growth.spec.mjs › S1. 판매만 켜진 회사: 메뉴에는 판매뿐이고, 견적을 보내고 주문으로 확정한다` | SQL, 브라우저 | ✅ |
| 꺼진 모듈의 명령은 거부되고 그 유형은 보이지 않는다 | `growth.test.mjs › S1. a new company starts with sales alone`<br>`bus.test.mjs › a module that is off gets nothing and blocks nothing, and its commands are refused`<br>`modules.spec.mjs › S1. 판매만 켜져 있으면 메뉴에 판매만 있고, 재고 명령은 거부된다` | SQL, 브라우저 | ✅ |
| 켜는 순서와 끄는 순서 | `expense.test.mjs › S13. it starts off, cannot be turned on before people, and people cannot be turned off under it`<br>`expense.spec.mjs › S13-0. 인사 없이는 경비를 켤 수 없고, 메뉴에도 없으며 통계는 잠겨 있다` | SQL, 브라우저 | ✅ |
| 설치된 모듈이 없으면 빈 상태로 안내한다 | `modules.spec.mjs › 모듈이 하나도 없으면 빈 상태로 안내한다` | 브라우저 | ✅ |
| 모듈 정보를 읽지 못해도 안내하고 카드는 그려진다 | `modules.spec.mjs › 모듈 정보를 읽지 못하면 오류와 다시 시도를 보여 주고, 예측 목록이 실패해도 카드는 그려진다` | 브라우저 | ✅ |
| 관리자가 아니면 모듈 메뉴와 배너가 없다 | `modules.spec.mjs › 비관리자에게는 모듈 메뉴와 배너가 없고, 주소로 와도 안내만 나오며, 재촉은 그대로 돈다` | 브라우저 | ✅ |
| 카드가 켜면 열리는 예측을 알려 준다 | `modules.spec.mjs › 켜면 열리는 예측과 what-if 는 erp_models 에서 읽고, 다른 모듈이 더 필요한 것은 말하지 않는다` | 브라우저 | ✅ |
| 필요한 모듈이 꺼져 있으면 말해 준다 | `mrp.test.mjs › it starts off, needs stock on, and comes and goes with its menu and commands`<br>`mrp.test.mjs › a company with no stock module among those it asks for cannot get manufacturing at the start either`<br>`mrp.spec.mjs › S15-0. 제조를 켜기 전` | SQL, 브라우저 | ✅ |
| 나중에 끄는 것은 된다 | `mrp.test.mjs › stock turned off: orders still finish, and turning it back on works through what piled up, or skips it if asked` | SQL | ✅ |
| 회계를 켤 때 다시 만들 수 없는 것을 밝힌다 | `growth.spec.mjs › S5. 회계를 켜면 지난 청구서와 입금으로 전표가 만들어지고, 보고서의 차변과 대변이 맞는다`<br>`accounting.test.mjs › setup seeds the account and leaves the module off, and the module card says what cannot be rebuilt` | SQL, 브라우저 | ✅ |
| 옵션을 비워 켜면 과거를 읽지 않는다 | `modules.spec.mjs › 옵션을 비워 켜면 과거를 읽지 않고, 메뉴가 바로 바뀌고, 켠 뒤의 이벤트부터 받는다`<br>`bus.test.mjs › turning a module on starts from now, not from the past` | SQL, 브라우저 | ✅ |
| 날짜를 고르면 그 뒤의 과거만 읽는다 | `growth.test.mjs › S2. inventory turned on later: it hears sales without sales knowing it exists`<br>`growth.spec.mjs › S2. 재고를 켠다: 메뉴가 바뀌고, 옛 주문을 가져오고, 기초 재고를 넣는다` | SQL, 브라우저 | ✅ |
| 회계는 켜면 원장을 처음부터 읽어 전표를 만든다 | `growth.test.mjs › S5. invoicing, then accounting: the books are rebuilt from what happened before` | SQL | ✅ |
| 처음부터 읽는 구독과 날짜 구독은 같은 이벤트를 다르게 읽는다 | `bus.test.mjs › replay reads from the beginning; since_option reads from a chosen date` | SQL | ✅ |
| 원장에 아직 확정된 이벤트가 없어도 켤 수 있다 | `bus.test.mjs › a module can be turned on while the ledger holds nothing settled yet` | SQL | ✅ |
| 모듈을 다시 등록해도 구독 위치는 그대로다 | `bus.test.mjs › registering a module again keeps the cursor` | SQL | ✅ |
| 꺼진 모듈의 칸은 사람이 넣을 수 없고 기본 데이터만 채울 수 있다 | `bus.test.mjs › seeds can fill fields of a module that is off, and users cannot` | SQL | ✅ |
| 판매는 재고를 모른 채 주문을 확정하고 재고가 전표를 만든다 | `growth.test.mjs › S2. inventory turned on later: it hears sales without sales knowing it exists`<br>`growth.spec.mjs › S2. 주문을 확정하면 재고 모듈이 전표를 만들고, 출고하면 재고가 줄고 납품 상태가 바뀐다` | SQL, 브라우저 | ✅ |
| 구독자의 이벤트는 원본의 작업 번호와 원인, 행위자를 잇는다 | `bus.test.mjs › a subscriber event carries the source correlation, cause and actor; rollback takes it along` | SQL | ✅ |
| 32개 조합 모두 멈춘 구독 없이 일한다 | `isolation.test.mjs › modules [none] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing, accounting] work together with nothing stuck` | SQL | ✅ |
| 어떤 조합에서도 예측 화면이 답한다 | `isolation.test.mjs › modules [none] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase] work together with nothing stuck`<br>`isolation.test.mjs › modules [invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing] work together with nothing stuck`<br>`isolation.test.mjs › modules [accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [inventory, purchase, invoicing, accounting] work together with nothing stuck`<br>`isolation.test.mjs › modules [sales, inventory, purchase, invoicing, accounting] work together with nothing stuck` | SQL | ✅ |
| 재고가 고장 나도 주문은 모두 성공하고 원인이 보인다 | `growth.test.mjs › S3. a broken inventory module does not stop sales, and catches up exactly once`<br>`modules.spec.mjs › S3. 재고가 고장 나도 주문은 모두 성공하고, 전 화면 배너와 원인이 보이며, 나머지는 정상이다`<br>`bus.test.mjs › a failing subscriber leaves the publisher and others alone, then catches up exactly once` | SQL, 브라우저 | ✅ |
| 아직 고장이면 재시도가 그렇다고 말한다 | `modules.spec.mjs › S3. 재고가 고장 나도 주문은 모두 성공하고, 전 화면 배너와 원인이 보이며, 나머지는 정상이다` | 브라우저 | ✅ |
| 고친 뒤 재시도하면 누락도 중복도 없이 따라잡는다 | `growth.test.mjs › S3. a broken inventory module does not stop sales, and catches up exactly once`<br>`modules.spec.mjs › S3. 재고가 고장 나도 주문은 모두 성공하고, 전 화면 배너와 원인이 보이며, 나머지는 정상이다`<br>`bus.test.mjs › a failing subscriber leaves the publisher and others alone, then catches up exactly once` | SQL, 브라우저 | ✅ |
| 실패한 구독은 전달마다 다시 시도하지 않는다 | `bus.test.mjs › a failing subscriber is not retried on every tick` | SQL | ✅ |
| 건너뛰기는 사유가 있어야 하고 원장에 남는다 | `modules.spec.mjs › 건너뛰기는 사유가 있어야 하고, 원장에 남고, 다음 이벤트로 넘어간다`<br>`bus.test.mjs › skipping a stuck event needs a reason, is recorded, and lets the subscriber go on` | SQL, 브라우저 | ✅ |
| 관리자가 아니면 건너뛸 수 없다 | `bus.test.mjs › skipping a stuck event needs a reason, is recorded, and lets the subscriber go on` | SQL | ✅ |
| 오류 문구는 그대로 글자로 보인다 | `modules.spec.mjs › S3. 재고가 고장 나도 주문은 모두 성공하고, 전 화면 배너와 원인이 보이며, 나머지는 정상이다` | 브라우저 | ✅ |
| 명령 뒤 재촉으로 다른 모듈의 결과가 바로 보인다 | `modules.spec.mjs › 명령이 끝나면 전달을 재촉하고, 실시간이 꺼져 있어도 열린 문서에 다른 모듈의 결과가 나타난다` | 브라우저 | ✅ |
| 재촉이 실패해도 사용자의 작업은 성공이다 | `modules.spec.mjs › 전달 재촉이 실패해도 사용자의 작업은 성공이다` | 브라우저 | ✅ |
| 아무도 접속하지 않아도 정기 실행이 전달한다 | `api.e2e.mjs › a plugin installed on the real stack is driven by pg_cron with nobody connected` | HTTP | ✅ |
| 느린 트랜잭션의 이벤트를 놓치지 않는다 | `bus.test.mjs › a slow transaction is delivered in order, never skipped` | SQL | ✅ |
| 일이 없는 전달은 쓰지 않고 뒤처진 커서는 따라간다 | `bus.test.mjs › an idle tick writes nothing, and a cursor far behind on unwanted events catches up` | SQL | ✅ |
| 끄면 메뉴와 명령이 막히고 데이터는 남는다 | `modules.spec.mjs › 끄면 메뉴와 명령이 막히고 데이터는 남으며, 다시 켤 때 밀린 이벤트를 고른다` | 브라우저 | ✅ |
| 꺼진 모듈의 칸은 다른 모듈의 문서에서 숨는다 | `growth.spec.mjs › 모듈을 끄면 그 메뉴와 보고서가 사라지고 데이터는 남는다` | 브라우저 | ✅ |
| 꺼져 있던 동안의 이벤트는 기다렸다 처리하거나 건너뛴다 | `modules.spec.mjs › 끄면 메뉴와 명령이 막히고 데이터는 남으며, 다시 켤 때 밀린 이벤트를 고른다`<br>`bus.test.mjs › off and on again: events in between wait by default, or can be skipped` | SQL, 브라우저 | ✅ |
| 설치했지만 꺼져 있으면 아무 일도 없다 | `plugin.test.mjs › installed but off: nothing happens and its type is hidden` | SQL | ✅ |
| 켜면 발행자를 고치지 않아도 포인트가 쌓인다 | `plugin.test.mjs › turned on: it earns points from events it never asked the publisher for`<br>`growth.test.mjs › S9. a plugin earns points from real orders with no change to sales, and leaves cleanly` | SQL | ✅ |
| 같은 이벤트가 두 번 와도 한 건이다 | `plugin.test.mjs › the same event twice gives one entry` | SQL | ✅ |
| 주문을 되돌리면 포인트도 함께 돌아간다 | `plugin.test.mjs › rolling back the order takes the points along, across module lines`<br>`growth.test.mjs › S9. a plugin earns points from real orders with no change to sales, and leaves cleanly` | SQL | ✅ |
| 고장 난 플러그인은 다른 일을 막지 않는다 | `plugin.test.mjs › a broken plugin does not stop anyone else` | SQL | ✅ |
| 지워도 코어와 이력은 그대로다 | `plugin.test.mjs › uninstalling leaves the core working and the history intact`<br>`growth.test.mjs › S9. a plugin earns points from real orders with no change to sales, and leaves cleanly` | SQL | ✅ |
| 플러그인을 지운 뒤에도 포인트가 쌓였던 주문을 되돌린다 | `plugin.test.mjs › an order that earned points can still be rolled back after the plugin is gone` | SQL | ✅ |
| 다시 설치하면 지금부터 이어 간다 | `plugin.test.mjs › installing it again resumes from now` | SQL | ✅ |
| 휴대폰 폭에서 메뉴는 서랍으로 열린다 | `modules.spec.mjs › 휴대폰 폭: 메뉴는 서랍으로 열리고 카드와 멈춤 상태가 화면 안에 들어온다` | 브라우저 | ✅ |
| 어두운 테마에서 모듈과 버스 화면이 읽힌다 | `modules.spec.mjs › 어두운 테마: 모듈과 버스 화면, 배너, 오류 문구가 어두운 바탕에서 읽힌다` | 브라우저 | ✅ |

- 「옵션을 비워 켜면 과거를 읽지 않는다」, 「꺼져 있던 동안의 이벤트는 기다렸다 처리하거나 건너뛴다」 는 실제 재고 모듈로 화면에서 확인한다. 「처음부터 읽는 구독과 날짜 구독은…」 은 시험용 모듈로 커널의 동작을 확인한다.
- `plugin.test.mjs` 는 주문 확정 이벤트를 계약 모양대로 직접 넣어, 플러그인을 판매 모듈이 아니라 이벤트 계약에 대고 시험한다. 실제 판매 주문으로는 `growth.test.mjs` S9 가 확인한다.

## 시나리오에 대응하지 않는 시험

모듈이 다른 모듈의 함수·표·유형을 건드리지 않는지 소스를 읽어 확인하는 정적 검사다. 위반하면 그 모듈 없는 회사에서 깨지므로 시험이 먼저 실패한다.

- `isolation.test.mjs › sales does not reach into other modules`
- `isolation.test.mjs › inventory does not reach into other modules`
- `isolation.test.mjs › purchase does not reach into other modules`
- `isolation.test.mjs › invoicing does not reach into other modules`
- `isolation.test.mjs › accounting does not reach into other modules`
- `isolation.test.mjs › analytics does not reach into other modules`
