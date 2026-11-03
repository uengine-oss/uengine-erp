# E2E — erp-inventory

재고 모듈의 켜기 옵션, 전표, 예약, 처리, 백오더, 반품, 재고 조정, 폐기, 로트·일련번호, 재주문, 원가, 작업 유형, 스케줄러, 조회, 동시성, 원장 재생, 재설치를 실제 설치 SQL 로 확인한다. `inventory.test.mjs` 는 판매·구매를 설치하지 않고 그 이벤트만 계약 모양대로 넣어 재고가 혼자 동작하는지 보고, `growth.test.mjs` 와 `growth.spec.mjs` 는 실제 모듈을 차례로 켜면서 박영업, 이재고, 최구매가 하는 일을 따라간다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/inventory.test.mjs test/growth.test.mjs test/purchase.test.mjs
source scripts/local-env.sh && npm run test:e2e -- growth.spec.mjs modules.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321).

재주문 수량 경계값 20건은 `inventory.test.mjs › reorder quantity: below the minimum, up to the maximum, rounded down to the multiple (D6)` 본문의 표에 있고, 스펙에는 대표 6건만 옮겼다.

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 고른 날짜 이후의 주문이 그 뒤에 일어난 일까지 재생된다 | `inventory.test.mjs › S2: importing old orders takes only those after the chosen date and replays what happened to them`<br>`growth.test.mjs › S2. inventory turned on later: it hears sales without sales knowing it exists` | SQL | ✅ |
| 켜기 창에서 날짜를 고르고 재고 현황에서 기초 재고를 넣는다 | `growth.spec.mjs › S2. 재고를 켠다: 메뉴가 바뀌고, 옛 주문을 가져오고, 기초 재고를 넣는다` | 브라우저 | ✅ |
| 기초 재고를 초안으로 적어 두었다가 반영한다 | `inventory.test.mjs › S2: opening stock comes from adjustments and shows up in the view` | SQL | ✅ |
| 가져오기 날짜를 비워 두면 켠 뒤의 주문만 전표가 된다 | `purchase.test.mjs › stock turned on after purchasing started: old orders stay typed by hand, new ones get receipts`<br>`modules.spec.mjs › 옵션을 비워 켜면 과거를 읽지 않고, 메뉴가 바로 바뀌고, 켠 뒤의 이벤트부터 받는다` | SQL, 브라우저 | ◐ |
| 꺼진 동안 재고 명령은 거부되고 재고 유형은 보이지 않는다 | `inventory.test.mjs › nobody but a member reads stock, and the module refuses commands while it is off`<br>`inventory.test.mjs › the module declares its subscriptions and hides what belongs to it while off` | SQL | ✅ |
| 확정한 주문의 재화 줄이 출고 전표가 되어 예약된다 | `inventory.test.mjs › S2: a confirmed order becomes a delivery; validating it publishes what moved and stock falls`<br>`inventory.test.mjs › S2: a service-only order has no transfer` | SQL | ✅ |
| 재고가 모자라도 주문은 확정되고 출고는 기다린다 | `growth.test.mjs › S2. a shortage does not stop an order; the delivery waits`<br>`growth.spec.mjs › S2. 적게 출고하면 남은 수량을 묻고, 재고가 모자라도 주문은 막히지 않는다` | SQL, 브라우저 | ✅ |
| 재고 추적을 끈 재화는 전표만 거치고 재고를 건드리지 않는다 | `inventory.test.mjs › goods not tracked in stock get a transfer, ready at once, that leaves stock alone` | SQL | ✅ |
| 전표 예정일은 출고 정책을 따르고 이동은 자기 날짜를 갖는다 | `inventory.test.mjs › a scheduled date comes from the first line, or the last when it all ships together; each row keeps its own` | SQL | ✅ |
| 구매 주문의 수량과 단가가 제품 기준 단위로 입고 전표에 실린다 | `inventory.test.mjs › receipts follow purchase orders: dates, cost per stock unit, quantity changes, cancellation` | SQL | ✅ |
| 구매 주문의 수량 변경과 취소가 입고 전표를 따라간다 | `inventory.test.mjs › receipts follow purchase orders: dates, cost per stock unit, quantity changes, cancellation` | SQL | ✅ |
| 수량 변경이 열린 전표와 새 전표로 이어진다 | `inventory.test.mjs › order quantity follows onto the open transfer; below what moved is the order's own refusal`<br>`inventory.test.mjs › more after everything shipped is a new transfer for the difference; after a cancelled transfer, for all of it` | SQL | ✅ |
| 확정 뒤 추가한 줄은 열린 전표에 합쳐지고 수량 0 은 이동을 취소한다 | `inventory.test.mjs › a line added after confirmation joins the open transfer; quantity zero cancels the row` | SQL | ✅ |
| 주문을 취소하면 열린 전표만 취소되고 다시 확정하면 새 전표가 생긴다 | `inventory.test.mjs › cancelling an order cancels what is open and leaves what shipped; a new confirmation is a new transfer` | SQL | ✅ |
| 재고를 켜기 전의 주문은 늘어난 수량만 새 전표가 된다 | ✗ | — | ✗ |
| 같은 이벤트를 다시 받거나 옛 이벤트가 늦게 와도 결과가 같다 | `inventory.test.mjs › the same event twice gives one transfer, and the same quantity change twice changes it once`<br>`inventory.test.mjs › an older quantity change arriving after a newer one does not undo it` | SQL | ✅ |
| 재고 구독이 고장 나도 주문은 성공하고 고친 뒤 전표가 한 번씩 생긴다 | `inventory.test.mjs › S3: a broken subscriber leaves orders alone; after the fix transfers appear without a miss or a double`<br>`growth.test.mjs › S3. a broken inventory module does not stop sales, and catches up exactly once` | SQL | ✅ |
| 재고가 들어와도 저절로 예약되지 않고 재고 확인이 예약한다 | `inventory.test.mjs › stock arriving does not reserve by itself; checking does; nothing reserved and nothing typed is refused` | SQL | ✅ |
| 먼저 확정한 전표가 먼저 예약하고 강제로 출고하면 남의 예약이 풀린다 | `inventory.test.mjs › first come first reserved; shipping one transfer by force takes the other's reservation away` | SQL | ✅ |
| 출고 정책이 전표의 준비 시점을 정한다 | `inventory.test.mjs › shipping policy: as soon as possible is ready with anything reserved, all at once only with everything` | SQL | ✅ |
| 출고를 처리하면 재고가 줄고 사실이 이벤트로 나간다 | `inventory.test.mjs › S2: a confirmed order becomes a delivery; validating it publishes what moved and stock falls` | SQL | ✅ |
| 많이 처리하면 재고가 음수가 되고 입력을 지우면 거부된다 | `inventory.test.mjs › over-delivery passes, and delivering more than stock takes it negative (D8)`<br>`inventory.test.mjs › clearing the typed quantity on a reserved transfer is refused; with nothing typed the reserved quantity moves` | SQL | ✅ |
| 박영업의 주문을 이재고가 화면에서 출고하면 납품 상태가 바뀐다 | `growth.test.mjs › S2. inventory turned on later: it hears sales without sales knowing it exists`<br>`growth.spec.mjs › S2. 주문을 확정하면 재고 모듈이 전표를 만들고, 출고하면 재고가 줄고 납품 상태가 바뀐다` | SQL, 브라우저 | ✅ |
| 적게 처리하면 묻고 나머지를 새 전표로 남기거나 버린다 | `inventory.test.mjs › a short delivery asks: a backorder holds the rest, or the rest is gone`<br>`inventory.test.mjs › an untouched row goes to the backorder, or is cancelled without one` | SQL | ✅ |
| 이재고가 화면에서 남은 수량을 고른다 | `growth.spec.mjs › S2. 적게 출고하면 남은 수량을 묻고, 재고가 모자라도 주문은 막히지 않는다` | 브라우저 | ✅ |
| 출고를 반품하면 입고 전표가 열리고 처리할 때 재고가 는다 | `inventory.test.mjs › returns: quantity comes back, refunding or not, with no ceiling, and a return can itself be returned (G6)` | SQL | ✅ |
| 반품 수량에 상한이 없고 입고와 반품도 되돌려 보낼 수 있다 | `inventory.test.mjs › returns: quantity comes back, refunding or not, with no ceiling, and a return can itself be returned (G6)`<br>`inventory.test.mjs › returning a receipt ships it out` | SQL | ✅ |
| 이재고가 화면에서 완료 전표를 반품한다 | `growth.spec.mjs › S2. 주문을 확정하면 재고 모듈이 전표를 만들고, 출고하면 재고가 줄고 납품 상태가 바뀐다` | 브라우저 | ✅ |
| 실사와 반영은 따로이고 예약보다 적게 세면 예약이 줄어든다 | `inventory.test.mjs › adjustments: count, apply, a count below reservations gives way, negative counts apply` | SQL | ✅ |
| 실사 뒤 재고가 움직이면 묻고 실사 수량으로 맞춘다 | `inventory.test.mjs › adjustments: stock that moved after the count asks first; match and zero fill in the count` | SQL | ✅ |
| 실사 수량을 현재고나 0 으로 채우고 여러 건을 한 번에 반영한다 | `inventory.test.mjs › adjustments: stock that moved after the count asks first; match and zero fill in the count`<br>`inventory.test.mjs › adjustments: counts filled in and applied together` | SQL | ✅ |
| 실사 요청에 담당자와 날짜를 남기고 연간 실사일은 회사 설정을 따른다 | `inventory.test.mjs › adjustments: a count request names who and when; the yearly date is a setting` | SQL | ✅ |
| 반영한 조정을 되돌리면 차이가 거꾸로 나가고 음수도 허용한다 | `inventory.test.mjs › a reverted adjustment takes its difference back, even below zero: only a rollback refuses that (D8)` | SQL | ✅ |
| 폐기는 초안으로 시작하고 처리하면 고칠 수 없으며 넘치면 묻는다 | `inventory.test.mjs › scrap starts as a draft (G15), warns above stock, moves to the scrap location and shows in the totals` | SQL | ✅ |
| 폐기는 현재고를 기준으로 묻고 예약을 함께 줄인다 | `inventory.test.mjs › scrap warns against what is on hand, not what is free, and takes reservations with it` | SQL | ✅ |
| 로트 제품은 로트가 있어야 입고되고 여러 로트로 나눌 수 있다 | `inventory.test.mjs › lots: required to receive, split across lots, reserved oldest first` | SQL | ✅ |
| 일련번호는 번호마다 하나이고 재고에 있는 번호는 다시 들어오지 못한다 | `inventory.test.mjs › serial numbers: one each, never twice, and never one already in stock` | SQL | ✅ |
| 주문 수량은 최소 아래일 때 최대까지 채우고 배수로 내린다 | `inventory.test.mjs › reorder quantity: below the minimum, up to the maximum, rounded down to the multiple (D6)` | SQL | ✅ |
| 예측은 답 없는 요청을 세어 같은 부족을 두 번 주문하지 않는다 | `inventory.test.mjs › forecast: stock minus promised plus coming, ignoring what nobody confirmed; ordering twice orders once`<br>`inventory.test.mjs › forecast: a request nobody answers stops counting after a day, so the rule asks again` | SQL | ✅ |
| 공급사 납기 안에 드는 이동만 예측에 들어간다 | `inventory.test.mjs › forecast: only what happens within the vendor's delay counts (D6)` | SQL | ✅ |
| 초안 구매 수량이 예측에 들어가고 요청에 답한다 | `inventory.test.mjs › draft purchase quantities count in the rule's forecast and acknowledge its request` | SQL | ✅ |
| 자동 규칙은 주문과 출고 전표 확정 때 바로 요청한다 | `inventory.test.mjs › an auto rule asks on order confirmation, quantity increase and new lines, but not on adjustment or scrap (D5)`<br>`inventory.test.mjs › a person confirming a delivery by hand also triggers an auto rule; validating straight from a draft does not`<br>`inventory.test.mjs › zero/zero/one rule follows demand; no vendor is refused for a person and recorded for the scheduler` | SQL | ✅ |
| 재고 조정과 폐기는 스케줄러를 기다리고 바로 보충만 즉시 요청한다 | `inventory.test.mjs › an auto rule asks on order confirmation, quantity increase and new lines, but not on adjustment or scrap (D5)`<br>`inventory.test.mjs › scrap can ask for the replacement right away` | SQL | ✅ |
| 공급사가 없으면 사람에게는 거부하고 스케줄러는 이유를 남긴다 | `inventory.test.mjs › zero/zero/one rule follows demand; no vendor is refused for a person and recorded for the scheduler` | SQL | ✅ |
| 일시 중지와 최대까지 주문, 임의 수량, 규칙 없는 요청 | `inventory.test.mjs › snoozing hides a rule for a while; ordering to the maximum and any quantity are a person's call` | SQL | ✅ |
| 부족을 감지한 규칙이 구매 초안, 구매 주문, 입고로 이어진다 | `growth.test.mjs › S4. purchase turned on: a reorder rule becomes a request, an order, a receipt and real lead times`<br>`growth.spec.mjs › S4. 구매를 켠다: 재주문 규칙이 요청을 만들고, 구매 주문과 입고로 재고가 는다` | SQL, 브라우저 | ✅ |
| 평균 원가는 입고 때만 움직이고 소수 6자리를 지킨다 | `inventory.test.mjs › average cost moves on receipts only, keeps its decimals, and survives negative stock` | SQL | ✅ |
| 재고가 0 이하면 입고 단가가 원가가 되고 할인과 수동 입고도 반영된다 | `inventory.test.mjs › average cost moves on receipts only, keeps its decimals, and survives negative stock` | SQL | ✅ |
| 표준 원가는 그대로이고 구매 가격 변경은 열린 입고에 반영된다 | `inventory.test.mjs › standard cost stays put on receipt`<br>`inventory.test.mjs › a purchase price change reaches the open receipt` | SQL | ✅ |
| 다스와 박스로 주문해도 재고는 개로 센다 | `inventory.test.mjs › units: stock counts in the product unit whatever the order used` | SQL | ✅ |
| 다른 모듈 없이 입고, 내부 이동, 출고를 손으로 처리한다 | `inventory.test.mjs › inventory alone: transfers by hand, from draft through validation, with no other module on` | SQL | ✅ |
| 전표를 고치거나 지우면 예약이 따라가고 끝난 전표는 메모만 고친다 | `inventory.test.mjs › editing a transfer: rows added and changed, reservation follows; a finished one takes only a note`<br>`inventory.test.mjs › deleting: a draft, an open or a cancelled transfer may go, and gives its reservation back` | SQL | ✅ |
| 백오더 정책이 묻지 않고 남은 수량을 정한다 | `inventory.test.mjs › operation types set the number prefix, the backorder policy and when stock is reserved` | SQL | ✅ |
| 예약 방식이 전표의 예약 시점을 정한다 | `inventory.test.mjs › operation types set the number prefix, the backorder policy and when stock is reserved` | SQL | ✅ |
| 작업 유형이 접두어와 반품 유형을 정하고 유형 없는 창고는 기본값을 쓴다 | `inventory.test.mjs › operation types set the number prefix, the backorder policy and when stock is reserved` | SQL | ✅ |
| 스케줄러는 대기 전표를 예정일 순서로 예약하고 재고 담당자만 실행한다 | `inventory.test.mjs › the scheduler picks up waiting transfers in date order and leaves the short ones waiting` | SQL | ✅ |
| 조회자는 재고 현황과 문서별 예측, 개요를 읽되 명령은 못 보낸다 | `inventory.test.mjs › reads: stock view, per-product forecast, overview and the move history, for anyone in the company`<br>`inventory.test.mjs › nobody but a member reads stock, and the module refuses commands while it is off` | SQL | ✅ |
| 이동 내역은 조정, 출고, 폐기를 원장 순서로 보여 준다 | `inventory.test.mjs › reads: stock view, per-product forecast, overview and the move history, for anyone in the company` | SQL | ✅ |
| 같은 제품을 동시에 출고하거나 확인해도 수량이 맞다 | `inventory.test.mjs › concurrent deliveries of one product all count: nothing is lost and stock adds up`<br>`inventory.test.mjs › concurrent forced deliveries against one reservation do not deadlock or lose anything`<br>`inventory.test.mjs › concurrent checks cannot reserve the same stock twice` | SQL | ✅ |
| 동시에 입고하거나 조정해도 원가와 수량이 정확하다 | `inventory.test.mjs › concurrent adjustments and receipts of an average-cost product stay exact`<br>`inventory.test.mjs › two people cannot adjust from the same count at once` | SQL | ✅ |
| 재고 합계는 원장을 다시 더한 값과 같고 다시 만들어도 같다 | `inventory.test.mjs › every stock total equals a replay of the ledger, and a rebuild gives the same numbers` | SQL | ✅ |
| 설치 SQL 을 다시 실행해도 재고 데이터가 그대로이다 | `inventory.test.mjs › running the install script again keeps the data, the cursors and the catalog as they were` | SQL | ✅ |
| 받은 재고가 이미 나갔으면 입고 되돌리기가 거부된다 | `inventory.test.mjs › rollback: a receipt whose goods already left is refused; a clean one restores stock and history` | SQL | ✅ |
| 문제없는 출고를 되돌리면 재고와 이력이 돌아가고 다시 처리할 수 있다 | `inventory.test.mjs › rollback: a receipt whose goods already left is refused; a clean one restores stock and history` | SQL | ✅ |
| 전달되기 전에 되돌린 주문은 전표가 되지 않는다 | `inventory.test.mjs › rollback before delivery: an undone order never becomes a transfer` | SQL | ✅ |

◐ 가져오기 날짜를 비워 두면: 실제 재고 모듈로는 구매 쪽만 확인한다. 판매 쪽은 `modules.spec.mjs` 의 시험용 대역 모듈로 확인한다.

## 시나리오에 대응하지 않는 시험

없음. `inventory.test.mjs` 의 시험 63개는 모두 위 표에 있다. `growth.test.mjs`, `growth.spec.mjs` 의 S2, S3, S4 밖 시험은 다른 스펙이 다룬다.
