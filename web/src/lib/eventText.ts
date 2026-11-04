// Korean labels for ledger events, from the contract in docs/domain.md. Display only.
import { catalogOf } from './session'

// The ledger keeps what modules wrote while they were on, and a module that is off takes its types out of the catalog.
const TYPE_LABELS: Record<string, string> = {
  company: '회사', member: '구성원', module: '모듈', api_key: '연동 키', lock_exception: '잠금 예외',
  partner: '연락처', product: '제품', attribute: '제품 속성', product_category: '제품 분류', uom: '단위', tag: '태그', tax: '세금', fiscal_position: '세금 조정', payment_term: '결제 조건',
  pricelist: '가격표', bank: '은행', partner_bank: '거래처 은행 계좌', saved_search: '저장한 검색', account: '계정과목', account_group: '계정 그룹', journal_entry: '전표',
  warehouse: '창고', location: '위치', operation_type: '작업 유형', picking: '입출고 전표', stock_adjustment: '재고 조정', scrap: '폐기', lot: '로트·일련번호', reorder_rule: '재주문 규칙',
  stock_replenishment: '보충 요청', stock_rfq_watch: '구매 초안 수량', sales_order: '견적·주문', quote_template: '견적 양식', purchase_order: '구매 주문',
  account_move: '청구서', payment: '입금·지급', journal: '분개장', payment_method: '결제 수단', bank_statement: '은행 명세서', bank_line: '은행 거래',
  employee: '직원', employee_private: '직원 개인정보 기록', department: '부서',
  payroll_run: '급여 대장', pay_item: '급여 항목', payroll_rates: '4대보험 요율 자료', payroll_tax_table: '간이세액표', payroll_bank_format: '은행 이체 양식',
  withholding_filing: '원천세 마감', payroll_profile: '직원 급여 정보 기록', payroll_audit: '명세서 변경 기록',
  bom: '자재 명세', manufacturing_order: '제조 지시',
  asset: '고정자산', depreciation_run: '감가상각 실행', fiscal_close: '결산',
  holiday: '공휴일', leave_type: '휴가 유형', leave_policy: '연차 부여 정책', leave_person: '휴가 대상 직원', leave_grant: '휴가 부여', leave_request: '휴가 신청', leave_request_private: '휴가 사유 기록', leave_attendance_month: '근태 마감 사실',
  vat_entry: '신고 집계', vat_return: '부가세 신고',
  attendance_policy: '근태 기준', attendance_day: '출퇴근 기록', attendance_month: '근태 월 마감', attendance_person: '근태 대상 직원', attendance_leave: '근태에 반영한 휴가',
}

/** A type's name for people, also when its module is off. A type nobody here has heard of is still a document. */
export function typeLabel(type: string): string {
  return catalogOf(type)?.label ?? TYPE_LABELS[type] ?? '문서'
}
const EXACT: Record<string, string> = {
  CompanyCreated: '회사 생성', CompanyUpdated: '회사 정보 변경',
  AssetCreated: '자산 작성', AssetUpdated: '자산 변경', AssetDeleted: '자산 삭제', AssetRegistered: '자산 등록', AssetDepreciated: '감가상각 반영', AssetDisposed: '자산 처분',
  DepreciationPosted: '감가상각 실행', FiscalYearClosed: '결산', FiscalYearReopened: '결산 취소',
  MemberAdded: '구성원 추가', MemberChanged: '구성원 변경', MemberDeactivated: '구성원 비활성화', MemberActivated: '구성원 활성화',
  QuotationCreated: '견적 생성', QuotationUpdated: '견적 변경', QuotationLineAdded: '견적 줄 추가', QuotationLineChanged: '견적 줄 변경',
  QuotationLineRemoved: '견적 줄 삭제', QuotationSent: '견적 발송', QuotationSigned: '견적 서명',
  SalesOrderConfirmed: '주문 확정', SalesOrderLineQtyChanged: '주문 수량 변경', SalesOrderCancelled: '주문 취소',
  SalesOrderDelivered: '납품 반영', SalesOrderInvoiced: '청구 반영',
  PickingCreated: '전표 생성', PickingConfirmed: '전표 확인', PickingReserved: '재고 예약', PickingUnreserved: '예약 해제',
  PickingCancelled: '전표 취소', PickingValidated: '입출고 완료',
  StockAdjusted: '재고 조정', StockAdjustmentReverted: '재고 조정 되돌림', StockScrapped: '재고 폐기', RfqRequested: '자동 발주 요청',
  ProductCostChanged: '원가 변경',
  ProductVariantAdded: '변형 추가', ProductVariantChanged: '변형 변경', ProductVariantArchived: '변형 보관', ProductVariantReactivated: '변형 다시 사용',
  PartnerMerged: '연락처 합침', PartnerMergeReceived: '연락처 합쳐 받음', CompanyDefaultTaxesSet: '기본 세금 설정', Reverted: '되돌림',
  RfqCreated: '견적 요청 생성', RfqUpdated: '견적 요청 변경', RfqLineAdded: '요청 줄 추가', RfqLineChanged: '요청 줄 변경',
  RfqLineRemoved: '요청 줄 삭제', RfqSent: '견적 요청 발송',
  PurchaseOrderConfirmed: '구매 확정', PurchaseOrderLineQtyChanged: '구매 수량 변경', PurchaseOrderCancelled: '구매 취소',
  PurchaseOrderReceived: '입고 반영', PurchaseOrderBilled: '구매 청구 반영',
  InvoiceCreated: '청구서 생성', InvoiceUpdated: '청구서 변경', InvoiceResetToDraft: '청구서 초안으로', InvoiceCancelled: '청구서 취소',
  ModuleEnabled: '모듈 켬', ModuleDisabled: '모듈 끔', SubscriptionEventSkipped: '이벤트 건너뜀',
  InvoicePosted: '청구서 게시', InvoicePaymentApplied: '결제 반영', InvoiceDrafted: '청구서 초안', InvoiceReversalLinked: '대변 메모 연결',
  InvoiceLineAdded: '청구서 줄 추가', InvoiceLineChanged: '청구서 줄 변경', InvoiceLineRemoved: '청구서 줄 삭제',
  PaymentCreated: '입금 초안', PaymentUpdated: '입금 변경', PaymentStateChanged: '입금 상태 변경', PaymentAllocationRemoved: '배분 해제',
  PaymentRejected: '입금 거부', PaymentValidated: '입금 완료 처리', PaymentResetToDraft: '입금 초안으로', PaymentDeleted: '입금 삭제',
  JournalEntryCreated: '전표 작성', JournalEntryUpdated: '전표 변경', JournalEntryPosted: '전표 게시', JournalEntryResetToDraft: '전표 초안으로',
  JournalEntryReversed: '역분개', JournalEntryCancelled: '전표 취소', JournalEntryDeleted: '전표 삭제', JournalEntryWithdrawn: '전표 지움',
  PickingStateChanged: '전표 상태 변경', PickingUpdated: '전표 변경', PickingDeleted: '전표 삭제', PickingReservationReduced: '예약 줄어듦',
  PickingMoveAdded: '이동 줄 추가', PickingMoveChanged: '이동 줄 변경', PickingMoveRemoved: '이동 줄 삭제', PickingMoveCostChanged: '이동 단가 변경',
  SalesOrderDeliveryStatusChanged: '납품 상태 변경', SalesOrderInvoiceStatusChanged: '청구 상태 변경', SalesOrderUpdated: '주문 변경',
  SalesOrderLineAdded: '주문 줄 추가', SalesOrderLineChanged: '주문 줄 변경', SalesOrderLinesReordered: '주문 줄 순서 변경',
  SalesOrderSectionAdded: '주문 구역 추가', SalesOrderSectionRemoved: '주문 구역 삭제', SalesOrderLocked: '주문 잠금', SalesOrderUnlocked: '주문 잠금 풀림',
  QuotationDeclined: '견적 거절', QuotationDeleted: '견적 삭제', QuotationLinesReordered: '견적 줄 순서 변경', QuotationOptionTaken: '선택 제품 담음', QuotationResetToDraft: '견적으로 되돌림',
  PurchaseOrderUpdated: '구매 주문 변경', PurchaseOrderLineAdded: '구매 줄 추가', PurchaseOrderLineChanged: '구매 줄 변경', PurchaseOrderLinePriceChanged: '구매 단가 변경',
  PurchaseOrderAmountsChanged: '구매 금액 변경', PurchaseOrderApprovalRequested: '구매 승인 요청', PurchaseOrderDeleted: '구매 주문 삭제', PurchaseOrderLocked: '구매 주문 잠금',
  PurchaseOrderUnlocked: '구매 주문 잠금 풀림', PurchaseOrderReceiptStatusChanged: '입고 상태 변경', PurchaseOrderVendorConfirmed: '공급사 확인', PurchaseDraftQtyChanged: '구매 초안 수량 변경',
  StockRfqQtyWatched: '구매 초안 수량 확인', RfqAmountsChanged: '요청 금액 변경', RfqReorderLinked: '재주문 요청 연결', RfqResetToDraft: '견적 요청 초안으로',
  ReorderRequested: '재주문 요청', ReorderRuleBlocked: '재주문 막힘', ReorderRuleCleared: '재주문 막힘 풀림', ReorderRuleSnoozed: '재주문 일시 중지', ReplenishmentAcknowledged: '보충 요청 접수',
  StockAdjustmentCreated: '재고 조정 작성', StockAdjustmentCounted: '실사 수량 입력', StockAdjustmentDeleted: '재고 조정 삭제',
  ScrapCreated: '폐기 작성', ScrapUpdated: '폐기 변경', ScrapDeleted: '폐기 삭제', ApiKeyCreated: '연동 키 만듦', ApiKeyRevoked: '연동 키 폐기', LotCreated: '로트 생성', PartnerUpdated: '연락처 변경',
  PaymentPosted: '결제 게시', PaymentCancelled: '결제 취소', PaymentAllocated: '결제 배분',
  EmployeeHired: '입사', EmployeeChanged: '직원 정보 변경', EmployeeLeft: '퇴사', EmployeePrivateChanged: '개인정보 변경', EmployeePrivateErased: '개인정보 지움',
  PayrollRunDrafted: '급여 대장 초안', PayrollRunChanged: '급여 대장 변경', PayrollPosted: '급여 대장 확정', PayrollPaid: '급여 지급 완료', PayrollRunReversed: '급여 대장 정정', PayrollRunCancelled: '급여 대장 초안 취소',
  PayrollTransferExported: '이체 파일 내보냄', PayrollSlipChanged: '명세서 칸 변경', PayrollSlipAdded: '대장에 직원 넣음', PayrollSlipRemoved: '대장에서 직원 뺌', PayrollSlipErased: '명세서 지움',
  PayrollProfileChanged: '급여 정보 변경', PayrollProfileErased: '급여 정보 지움', PayrollTaxTableCreated: '간이세액표 넣음', PayrollTaxTableDeleted: '간이세액표 삭제', PayrollRatesCreated: '요율 자료 넣음', PayrollRatesUpdated: '요율 자료 변경',
  WithholdingFiled: '원천세 마감', WithholdingReopened: '원천세 마감 해제',
  LeaveRequested: '휴가 신청', LeaveApproved: '휴가 승인', LeaveRejected: '휴가 반려', LeaveCancelled: '휴가 취소', LeaveReasonErased: '휴가 사유 지움',
  LeaveGranted: '휴가 부여', LeaveGrantAdjusted: '휴가 부여 조정', LeaveGrantUsedBefore: '켜기 전 사용 일수', LeaveGrantVoided: '휴가 부여 취소',
  LeavePolicySet: '연차 정책 설정', LeavePolicyChanged: '연차 정책 변경', LeavePersonSynced: '휴가 대상 반영', LeavePersonAutoGrantChanged: '자동 부여 변경', LeaveAttendanceNoted: '근태 마감 반영',
  AttendanceCheckedIn: '출근', AttendanceCheckedOut: '퇴근', AttendanceEntered: '근태 입력', AttendanceCorrected: '근태 정정', AttendanceClosed: '근태 월 마감',
  AttendanceLeaveNoted: '휴가 반영', AttendanceLeaveCleared: '휴가 반영 해제', AttendancePolicySet: '근태 기준 설정', AttendancePolicyChanged: '근태 기준 변경', AttendancePersonSynced: '근태 대상 반영',
  DepartmentCreated: '부서 생성', DepartmentChanged: '부서 변경', DepartmentArchived: '부서 보관', DepartmentUnarchived: '부서 보관 해제', DepartmentDeleted: '부서 삭제',
  BomCreated: '자재 명세 생성', BomChanged: '자재 명세 변경', BomArchived: '자재 명세 보관', BomUnarchived: '자재 명세 보관 해제', BomDeleted: '자재 명세 삭제',
  ManufacturingOrderCreated: '제조 지시 생성', ManufacturingOrderChanged: '제조 지시 변경', ManufacturingOrderDeleted: '제조 지시 삭제', ManufacturingReorderLinked: '재주문 요청 연결',
  ManufacturingConfirmed: '제조 확정', ManufacturingStarted: '제조 시작', ManufacturingDone: '제조 완료', ManufacturingCancelled: '제조 취소', ManufacturingResetToDraft: '제조 지시 초안으로',
  ManufacturingReversed: '제조 상쇄', ManufacturingPlanChanged: '제조 계획 수량 변경', ManufacturingStockApplied: '재고 반영',
  InvoiceVoucherPaid: '전표 지급', InvoiceEvidenceSet: '증빙 적기', InvoiceNumberChanged: '청구서 번호 변경', JournalNumberFormatChanged: '번호 형식 변경',
  BankLineCreated: '은행 거래 추가', BankLineUpdated: '은행 거래 변경', BankLineDeleted: '은행 거래 삭제', BankLineBooked: '은행 거래 분개', BankLineUnbooked: '은행 거래 분개 취소',
  BankLineMatched: '은행 거래 대사', BankLineUnmatched: '은행 거래 대사 취소', BankLineStatementSet: '명세서 연결', BankStatementDeleted: '은행 명세서 삭제',
  PaymentBankMatched: '은행 대사 반영', PaymentBankUnmatched: '은행 대사 취소 반영',
  LeaveTypeCreated: '휴가 유형 추가', LockExceptionGranted: '잠금 예외 허용', LockExceptionRevoked: '잠금 예외 회수', PartnerBankUntrusted: '거래처 계좌 신뢰 해제',
  SavedSearchOwned: '저장한 검색 소유', SavedSearchUpdated: '저장한 검색 변경',
  VatEntryRecorded: '신고 집계 반영', VatEntryWithdrawn: '신고 집계 철회', VatReturnOpened: '부가세 신고 시작', VatFiled: '부가세 신고 마감', VatFilingReopened: '부가세 신고 다시 열기',
}

// Modules name row events <Type><Column>Added/Changed/Removed/Reordered, so endings cover new ones too.
const SUFFIX: [RegExp, string][] = [
  [/Created$/, '생성'], [/Updated$/, '변경'], [/Unarchived$/, '보관 해제'], [/Archived$/, '보관'], [/Deleted$/, '삭제'],
  [/Confirmed$/, '확정'], [/Sent$/, '발송'], [/Posted$/, '게시'], [/Cancelled$/, '취소'], [/Added$/, '줄 추가'], [/Changed$/, '줄 변경'],
  [/Removed$/, '줄 삭제'], [/Reordered$/, '순서 변경'],
]

/** The record's type label plus a verb when there is no exact wording, so new events still read naturally. */
export function eventLabel(eventType: string, typeLabel?: string): string {
  if (EXACT[eventType]) return EXACT[eventType]
  for (const [re, word] of SUFFIX) {
    if (re.test(eventType)) return typeLabel ? `${typeLabel} ${word}` : word
  }
  return eventType
}

export function sourceLabel(source: string): string {
  if (source.startsWith('bus:')) return '다른 모듈'
  switch (source) {
    case 'ui': return '사람'
    case 'mcp':
    case 'agent': return '에이전트'
    case 'reaction': return '연쇄 반응'
    case 'rollback': return '되돌리기'
    case 'compensation': return '보상'
    case 'setup': return '설치'
    case 'demo': return '데모 데이터'
    case 'test': return '시험'
    default: return source
  }
}

export function sourceColor(source: string): string {
  if (source.startsWith('bus:')) return 'blue'
  switch (source) {
    case 'mcp':
    case 'agent': return 'violet'
    case 'reaction': return 'blue'
    case 'rollback':
    case 'compensation': return 'amber'
    default: return 'gray'
  }
}

export const SOURCES = ['ui', 'agent', 'mcp', 'reaction', 'rollback', 'compensation', 'setup', 'demo']
