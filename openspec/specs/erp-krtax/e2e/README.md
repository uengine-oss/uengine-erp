# E2E — erp-krtax

신고서 칸, 합계표, 마감, 나중에 켜기를 손으로 계산한 사례로 실제 데이터베이스 명령에서 확인하고, 신고서를 읽고 전표를 찾고 마감하는 흐름을 실제 화면에서 확인한다. 칸의 근거는 `docs/modules/krtax.md` 에 있다. 시험의 기대값은 코드에서 읽지 않고 시험 파일 머리의 계산표대로 손으로 셈했다.

```bash
# 저장소 루트에서
node scripts/build-sql.mjs && node --test test/krtax.test.mjs test/voucher.test.mjs test/isolation.test.mjs
source scripts/local-env.sh && lockf /tmp/uengine-erp-e2e.lock npm run test:e2e -- krtax.spec.mjs   # 로컬 스택의 postgres DB 를 초기화한다
```

실행 환경: SQL 시험은 Supabase 로컬 스택(Docker, db :56322) 안의 임시 DB, 브라우저 시험은 프로덕션 빌드(:5301) + 로컬 스택(API :56321)

## 시나리오 ↔ 시험

| 스펙 시나리오 | 시험 | 단계 | |
|---|---|---|---|
| 나중에 켠 회사의 칸이 처음부터 켠 회사와 같다 | `krtax.test.mjs › turned on late it comes out the same as on from the start` | SQL | ✅ |
| 청구가 없으면 켜지 않는다 | `krtax.test.mjs › it needs invoicing to be on, and is not on by default` | SQL | ✅ |
| 끄고 켜도 잃거나 두 번 세지 않는다 | `krtax.test.mjs › turned on late it comes out the same as on from the start` | SQL | ✅ |
| 손으로 계산한 신고서가 칸마다 맞다 | `krtax.test.mjs › the hand-worked return comes out cell by cell` | SQL | ✅ |
| 장부의 부가세 계정과 신고서가 같다 | `krtax.test.mjs › the VAT accounts of the books say the same as the return` | SQL | ✅ |
| 안 다루는 칸은 0 이 아니라 다루지 않는다고 나온다 | `krtax.test.mjs › what the return does not handle is listed as not handled, not as zero`<br>`krtax.spec.mjs › 신고서 칸이 전표에서 나오고, 줄을 누르면 그 전표가 나오고, 안 다루는 칸은 그렇다고 말한다` | SQL, 브라우저 | ✅ |
| 증빙이 없는 문서는 칸을 지어내지 않고, 적으면 들어간다 | `krtax.test.mjs › a document with no evidence is shown as unplaced, closes nothing, and is placed when its evidence is written` | SQL | ✅ |
| 구분 없는 세금은 세액이 있으면 과세, 없으면 미분류다 | `krtax.test.mjs › a tax with no class: a rate is taxable, an unmarked zero rate is not guessed` | SQL | ✅ |
| 분기 첫날과 끝날과 자정 전후 | `krtax.test.mjs › boundary days belong to their period, and the day is the one where the company is` | SQL | ✅ |
| 칸과 전표가 맞고 전표로 간다 | `krtax.test.mjs › a line opens the documents behind it, and they add up to it`<br>`krtax.spec.mjs › 신고서 칸이 전표에서 나오고, 줄을 누르면 그 전표가 나오고, 안 다루는 칸은 그렇다고 말한다` | SQL, 브라우저 | ✅ |
| 전표를 고치면 칸이 달라지고 되돌리면 돌아온다 | `krtax.test.mjs › changing a document changes the cell, and undoing the change brings it back` | SQL | ✅ |
| 합계표가 거래처별로 맞다 | `krtax.test.mjs › the invoice summaries go by partner and count a corrected invoice as a sheet` | SQL | ✅ |
| 수령 명세는 공제받는 것만 칸별로 낸다 | `krtax.test.mjs › the card statement separates cash receipts, business cards and other cards, and leaves out what is not claimed` | SQL | ✅ |
| 입력 실수를 치우면 합계표에서 사라지고 진짜 수정은 남는다 | `krtax.test.mjs › an entry mistake and its correction vanish from the summaries, and the cells net to what they were` | SQL | ✅ |
| 끝수가 있는 전표 | `krtax.test.mjs › rounding: the cell keeps the documents' tax, and the rate's figure and the payment rounding stand beside it` | SQL | ✅ |
| 마감한 기간의 문서는 고칠 수 없고 다음 기간으로 정정한다 | `krtax.test.mjs › filing records the figures, closes the period by the tax lock, and later changes are refused`<br>`krtax.spec.mjs › 신고 마감: 값이 남고 그 기간은 잠기고, 고치려 하면 이유를 듣고, 마감 시점으로 되짚는다` | SQL, 브라우저 | ✅ |
| 마감 시점으로 되짚는다 | `krtax.test.mjs › filing records the figures, closes the period by the tax lock, and later changes are refused`<br>`krtax.spec.mjs › 신고 마감: 값이 남고 그 기간은 잠기고, 고치려 하면 이유를 듣고, 마감 시점으로 되짚는다` | SQL, 브라우저 | ✅ |
| 예정의 환급은 확정에서 빼고 순서를 지킨다 | `krtax.test.mjs › a refund on a filed preliminary return is taken off the final` | SQL | ✅ |
| 칸을 정하지 못했거나 밀렸으면 마감하지 않는다 | `krtax.test.mjs › a document with no evidence is shown as unplaced, closes nothing, and is placed when its evidence is written` | SQL | ✅ |
| 마감은 되돌리기로 풀리지 않고 관리자가 사유와 함께 푼다 | `krtax.test.mjs › filing records the figures, closes the period by the tax lock, and later changes are refused` | SQL | ✅ |
| 판매 역할은 읽지도 쓰지도 못한다 | `krtax.test.mjs › reports read for accounting only; the module reaches no other module's table` | SQL | ✅ |
| 사람이 신고서를 읽고 전표를 찾고 마감한다 | `krtax.spec.mjs › 신고서 칸이 전표에서 나오고, 줄을 누르면 그 전표가 나오고, 안 다루는 칸은 그렇다고 말한다`<br>`krtax.spec.mjs › 신고 마감: 값이 남고 그 기간은 잠기고, 고치려 하면 이유를 듣고, 마감 시점으로 되짚는다` | 브라우저 | ✅ |

모듈 경계는 `isolation.test.mjs › krtax does not reach into other modules`, 다른 모듈과의 조합은 `isolation.test.mjs › modules [...] work together with nothing stuck` 의 `krtax` 가 든 조합이 확인한다. 재구축은 `krtax.test.mjs › everything folds from the ledger and rebuilds to the same figures` 가 확인한다.

**확인하지 못한 것.** 값이 세무 당국이 받아들이는 값인지는 시험이 아니라 전문가 검수의 일이다(`docs/modules/krtax.md` 의 검수 항목). 실제 파일 양식과 홈택스 입력 화면 대조, 세무사 프로그램 양식 대조는 하지 않았다.
