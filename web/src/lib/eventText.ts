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
}

/** A type's name for people, also when its module is off. A type nobody here has heard of is still a document. */
export function typeLabel(type: string): string {
  return catalogOf(type)?.label ?? TYPE_LABELS[type] ?? '문서'
}
const EXACT: Record<string, string> = {
  CompanyCreated: '회사 생성', CompanyUpdated: '회사 정보 변경',
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
  ExpenseCreated: '경비 작성', ExpenseChanged: '경비 변경', ExpenseDeleted: '경비 삭제', ExpenseReceiptAttached: '영수증 첨부', ExpenseReceiptRemoved: '영수증 지움',
  ExpenseSubmitted: '경비 신청', ExpenseApproved: '경비 승인', ExpenseRefused: '경비 반려', ExpensePaid: '경비 지급', ExpenseCancelled: '경비 취소',
  DepartmentCreated: '부서 생성', DepartmentChanged: '부서 변경', DepartmentArchived: '부서 보관', DepartmentUnarchived: '부서 보관 해제', DepartmentDeleted: '부서 삭제',
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
