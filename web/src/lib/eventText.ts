// Korean labels for ledger events, from the contract in docs/domain.md. Display only.
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
  InvoicePosted: '청구서 게시', InvoicePaymentApplied: '결제 반영',
  PaymentPosted: '결제 게시', PaymentCancelled: '결제 취소', PaymentAllocated: '결제 배분',
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
    case 'rollback': return 'amber'
    default: return 'gray'
  }
}

export const SOURCES = ['ui', 'agent', 'mcp', 'reaction', 'rollback', 'setup', 'demo']
