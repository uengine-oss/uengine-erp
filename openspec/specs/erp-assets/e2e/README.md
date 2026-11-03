# E2E — erp-assets

자산 등록의 계획, 실행, 처분, 되돌리기, 잠금, 나중에 켠 회계, 전망 모델을 시험으로 확인한다. 기대값은 손으로 계산해 시험의 주석에 적었다. 화면은 사람 속도로 걷는다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/assets.test.mjs test/isolation.test.mjs
source scripts/local-env.sh && npm run test:e2e -- books.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 연중에 취득하면 사용한 달부터 월할한다 | `assets.test.mjs › bought in the middle of a year, the first year counts whole months from the month of use`<br>`books.spec.mjs › 자산을 사람 속도로 등록한다` | SQL, 브라우저 | ✅ |
| 말일에 쓰기 시작해도 그 달을 온전히 센다 | `assets.test.mjs › a date on the last day of a month still counts that month` | SQL | ✅ |
| 상각률이 끊겨 있으면 내용연수 다음 달까지 간다 | `assets.test.mjs › the rate from the table is cut to three places, so a three-year asset needs a thirty-seventh month` | SQL | ✅ |
| 달의 끝자리는 그해 안에서 맞춘다 | `assets.test.mjs › rounding in a month stays inside the year and the last month takes what is left` | SQL | ✅ |
| 정률법은 미상각잔액에 곱하고 5% 에 닿는 해에 나머지를 더한다 | `assets.test.mjs › full years to the year the balance falls to 5%` | SQL | ✅ |
| 7월에 취득한 정률 자산은 한 해가 더 걸린다 | `assets.test.mjs › bought in July the first year is six months and a year more is needed` | SQL | ✅ |
| 딱 5% 에 닿아도 그 해에 끝난다 | `assets.test.mjs › landing exactly on 5% counts as reaching it; a won above does not` | SQL | ✅ |
| 회사 기준은 적은 잔존가치까지 내용연수 안에 상각한다 | `assets.test.mjs › company basis, straight line: down to the residual inside the life, and the last month settles the rounding`<br>`assets.test.mjs › company basis, declining: stops at the residual, and in any case at the end of the life` | SQL | ✅ |
| 이미 쓰던 자산은 상각한 금액 다음부터 이어 간다 | `assets.test.mjs › an asset already in use carries on from what it has charged` | SQL | ✅ |
| 등록한 값은 고칠 수 없다 | `assets.test.mjs › what the plan rests on cannot change after registration` | SQL | ✅ |
| 건물은 정률법을 쓸 수 없다 | `assets.test.mjs › a building takes the straight line under the tax rule`<br>`books.spec.mjs › 자산을 사람 속도로 등록한다` | SQL, 브라우저 | ✅ |
| 상각률표에 없는 내용연수와 세법 기준의 잔존가치는 거부된다 | `assets.test.mjs › life and residual outside what the basis allows are refused` | SQL | ✅ |
| 비품의 내용연수가 범위 밖이면 경고만 한다 | `assets.test.mjs › a life outside the range for office equipment is a warning, not a refusal`<br>`books.spec.mjs › 자산을 사람 속도로 등록한다` | SQL, 브라우저 | ✅ |
| 월 실행은 전표를 먼저 보여 준다 | `assets.test.mjs › the preview shows what a run would book, and changes nothing`<br>`assets.test.mjs › a monthly run charges each asset and the books make one entry per account`<br>`books.spec.mjs › 감가상각을 실행한다` | SQL, 브라우저 | ✅ |
| 같은 달을 다시 실행하면 잡을 것이 없다 | `assets.test.mjs › running the same month again finds nothing, and the next run charges one more month` | SQL | ✅ |
| 연말 한 번의 실행은 열두 번의 월 실행과 같은 데서 끝난다 | `assets.test.mjs › a year-end run covers every month not yet charged, and ends where twelve monthly runs would`<br>`books.spec.mjs › 감가상각을 실행한다` | SQL, 브라우저 | ✅ |
| 끝까지 상각한 자산은 다시 잡히지 않는다 | `assets.test.mjs › the books never run past the end value, and the asset reads as finished` | SQL | ✅ |
| 이익을 남기고 판다 | `assets.test.mjs › a sale at a gain: depreciation up to the month before, then the gain`<br>`books.spec.mjs › 처분한다` | SQL, 브라우저 | ✅ |
| 손실을 보고 고른 계정으로 받는다 | `assets.test.mjs › a sale at a loss, to the account the person named` | SQL | ✅ |
| 폐기는 남은 금액을 비용으로 하고 대금을 받지 않는다 | `assets.test.mjs › scrapping writes off what is left, and has no proceeds` | SQL | ✅ |
| 이미 상각한 달에는 처분할 수 없다 | `assets.test.mjs › a month already charged has to be taken back first, and a disposal before the purchase is refused` | SQL | ✅ |
| 적으면 전표가 생기고 비우면 안 생긴다 | `assets.test.mjs › the purchase books only when asked` | SQL | ✅ |
| 실행을 되돌리고 다시 한다 | `assets.test.mjs › a run undone takes its entry and the asset figures back, and running again gives the same`<br>`books.spec.mjs › 감가상각을 실행한다` | SQL, 브라우저 | ✅ |
| 앞선 실행을 되돌리면 뒤의 실행이 함께 간다 | `assets.test.mjs › undoing an earlier run takes the later one with it, and says so` | SQL | ✅ |
| 처분을 되돌리면 경고하고 자산이 살아난다 | `assets.test.mjs › a disposal undone puts the asset back, with a warning that the buyer has to be told`<br>`books.spec.mjs › 처분한다` | SQL, 브라우저 | ✅ |
| 잠긴 달의 실행과 처분이 막히고 되돌리기도 막힌다 | `assets.test.mjs › a closed period refuses a run, a disposal, and undoing what is inside it`<br>`books.spec.mjs › 잠그면` | SQL, 브라우저 | ✅ |
| 정정은 열린 달로 간다 | `assets.test.mjs › a closed period refuses a run, a disposal, and undoing what is inside it`<br>`books.spec.mjs › 잠그면` | SQL, 브라우저 | ✅ |
| 회계가 없는 회사도 같다 | `assets.test.mjs › a company with no books still locks and undoes` | SQL | ✅ |
| 잠긴 구입일은 뒤의 실행을 되돌리는 것을 막지 않는다 | `assets.test.mjs › a purchase inside the lock does not hold back undoing a later run, and undoing the purchase itself is refused` | SQL | ✅ |
| 처음부터, 중간에, 끝난 뒤에 켠 회계의 시산표가 같다 | `assets.test.mjs › the trial balance is the same however late accounting came on`<br>`assets.test.mjs › entries keep the date of the work, not the day of the replay`<br>`assets.test.mjs › a second delivery of the same event makes nothing new` | SQL | ✅ |
| 회계가 꺼져 있으면 계정 칸을 받지 않고 시드 계정을 싣는다 | `assets.test.mjs › the assets module knows nothing of accounting, and a company with both off the books still gets its asset figures` | SQL | ✅ |
| 모듈을 끄면 명령이 막히고 값은 남는다 | `assets.test.mjs › with the module off, its commands are refused and its figures stay` | SQL | ✅ |
| 영업 역할에는 메뉴도 숫자도 없다 | `assets.test.mjs › only accounting may run or read it`<br>`books.spec.mjs › 회계 권한이 없으면` | SQL, 브라우저 | ✅ |
| 상태가 차례로 풀린다 | `assets.test.mjs › its state comes from the ledger: locked, then short of history, then open`<br>`books.spec.mjs › 고정자산은 꺼져 있고`<br>`books.spec.mjs › 감가상각비 전망` | SQL, 브라우저 | ✅ |
| 지금 있는 자산은 계산이고 떠난 자산은 없다 | `assets.test.mjs › today's assets are arithmetic: twelve months at 20,000, and an asset that left costs nothing`<br>`books.spec.mjs › 감가상각비 전망` | SQL, 브라우저 | ✅ |
| 화면 계산과 DB 계산이 달마다 같다 | `assets.test.mjs › what the ledger carries is what the screen computes: the same month by month as the runs booked` | SQL | ✅ |
| 근거 부족은 범위만 말한다 | `assets.test.mjs › short of history it gives the schedule as a range, and no point`<br>`books.spec.mjs › 감가상각비 전망` | SQL, 브라우저 | ✅ |
| 읽을 권한과 꺼진 모듈 | `assets.test.mjs › someone who may not read assets gets no count of them, and history stays when the module is off (M8)` | SQL | ✅ |
| 가상 회사에서 구간이 말한 만큼 맞는다 | `assets.test.mjs › on companies whose future is known, the 80% band holds about as often as it says` | SQL | ✅ |
