import { createRouter, createWebHashHistory } from 'vue-router'
import { conn } from './lib/conn'
import { boot, session } from './lib/session'
import { screenFor } from './nav'
import AppShell from './components/AppShell.vue'
import SetupView from './views/SetupView.vue'
import LoginView from './views/LoginView.vue'
import ConnectView from './views/ConnectView.vue'
import OfflineView from './views/OfflineView.vue'
import DemoBuildView from './views/DemoBuildView.vue'
import HomeView from './views/HomeView.vue'
import RecordListRoute from './views/RecordListRoute.vue'
import RecordFormRoute from './views/RecordFormRoute.vue'
import EventsView from './views/EventsView.vue'
import SettingsView from './views/SettingsView.vue'
import ModulesView from './views/ModulesView.vue'
import BusView from './views/BusView.vue'
import IntegrationView from './views/IntegrationView.vue'
import NotFoundView from './views/NotFoundView.vue'

export const router = createRouter({
  // Hash routing: invite links and record paths never reach the static host.
  history: createWebHashHistory(),
  routes: [
    { path: '/setup', name: 'setup', component: SetupView, meta: { public: true, title: '설치 안내' } },
    { path: '/connect', name: 'connect', component: ConnectView, meta: { public: true, title: '회사 접속' } },
    { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '로그인' } },
    { path: '/offline', name: 'offline', component: OfflineView, meta: { public: true, title: '연결 안 됨' } },
    // A customer has no account and no saved connection: the link carries what the page needs and shows one quotation.
    { path: '/portal/:token', name: 'portal', component: () => import('./screens/portal/PortalView.vue'), props: true, meta: { public: true, title: '견적 확인' } },
    { path: '/demo-build', name: 'demo-build', component: DemoBuildView, meta: { title: '가상 회사 만들기' } },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'home', component: HomeView, meta: { title: '홈' } },
        { path: 'r/:type', name: 'list', component: RecordListRoute, props: true },
        { path: 'r/:type/new', name: 'new', component: RecordFormRoute, props: true },
        { path: 'r/:type/:id', name: 'record', component: RecordFormRoute, props: true },
        { path: 'events', name: 'events', component: EventsView, meta: { title: '이벤트 원장' } },
        { path: 'analytics', redirect: '/analytics/models' },
        { path: 'analytics/dashboard', name: 'dashboard', component: () => import('./screens/analytics/DashboardView.vue'), meta: { title: '현황판' } },
        { path: 'analytics/read-models', name: 'read-models', component: () => import('./screens/analytics/ReadModelsView.vue'), meta: { title: '읽기 모델' } },
        { path: 'analytics/models', name: 'analytics', component: () => import('./screens/analytics/AnalyticsHome.vue'), meta: { title: '예측·what-if' } },
        { path: 'analytics/models/:id', name: 'model', component: () => import('./screens/analytics/ModelView.vue'), props: true, meta: { title: '모델' } },
        { path: 'analytics/stats', name: 'stats', component: () => import('./screens/analytics/StatsView.vue'), meta: { title: '매출 통계' } },
        { path: 'analytics/quotes', name: 'quotes', component: () => import('./screens/analytics/QuotesView.vue'), meta: { title: '견적 전환율' } },
        { path: 'analytics/process-log', name: 'process-log', component: () => import('./screens/analytics/ProcessLogView.vue'), meta: { title: '프로세스 마이닝 로그' } },
        { path: 'inventory/stock', name: 'stock', component: () => import('./screens/reports/StockView.vue'), meta: { title: '재고 현황' } },
        { path: 'invoicing/targets', name: 'targets', component: () => import('./screens/reports/TargetsView.vue'), meta: { title: '청구 대상' } },
        { path: 'invoicing/aged', name: 'aged', component: () => import('./screens/reports/AgedView.vue'), meta: { title: '미수금·미지급금' } },
        { path: 'accounting/trial-balance', name: 'trial-balance', component: () => import('./screens/reports/BooksView.vue'), props: { report: 'trial-balance' }, meta: { title: '시산표' } },
        { path: 'accounting/profit-loss', name: 'profit-loss', component: () => import('./screens/reports/BooksView.vue'), props: { report: 'profit-loss' }, meta: { title: '손익계산서' } },
        { path: 'accounting/balance-sheet', name: 'balance-sheet', component: () => import('./screens/reports/BooksView.vue'), props: { report: 'balance-sheet' }, meta: { title: '재무상태표' } },
        { path: 'accounting/ledger/:account', name: 'general-ledger', component: () => import('./screens/reports/GeneralLedgerView.vue'), props: true, meta: { title: '계정별 원장' } },
        { path: 'sales/catalog', name: 'sales-catalog', component: () => import('./screens/sales/CatalogView.vue'), props: { kind: 'sales' }, meta: { title: '제품 카탈로그' } },
        { path: 'purchase/catalog', name: 'purchase-catalog', component: () => import('./screens/sales/CatalogView.vue'), props: { kind: 'purchase' }, meta: { title: '공급사 카탈로그' } },
        { path: 'purchase/dashboard', name: 'purchase-dashboard', component: () => import('./screens/purchase/DashboardView.vue'), meta: { title: '구매 현황' } },
        { path: 'purchase/analysis', name: 'purchase-analysis', component: () => import('./screens/purchase/AnalysisView.vue'), meta: { title: '구매 분석' } },
        { path: 'inventory/overview', name: 'stock-overview', component: () => import('./screens/inventory/OverviewView.vue'), meta: { title: '재고 개요' } },
        { path: 'inventory/replenish', name: 'replenish', component: () => import('./screens/inventory/ReplenishView.vue'), meta: { title: '보충' } },
        { path: 'inventory/count', name: 'stock-count', component: () => import('./screens/inventory/CountView.vue'), meta: { title: '재고 실사' } },
        { path: 'inventory/moves', name: 'stock-moves', component: () => import('./screens/inventory/MovesView.vue'), meta: { title: '이동 내역' } },
        { path: 'inventory/scrapped', name: 'stock-scrapped', component: () => import('./screens/inventory/ScrappedView.vue'), meta: { title: '폐기 현황' } },
        { path: 'inventory/forecast/:variant', name: 'stock-forecast', component: () => import('./screens/inventory/ForecastView.vue'), props: true, meta: { title: '재고 예측' } },
        { path: 'invoicing/bank', name: 'bank', component: () => import('./screens/invoicing/BankView.vue'), meta: { title: '은행 대사' } },
        { path: 'invoicing/reconcile', name: 'reconcile', component: () => import('./screens/invoicing/ReconcileView.vue'), meta: { title: '자동 대사' } },
        { path: 'invoicing/voucher', name: 'voucher', component: () => import('./screens/invoicing/VoucherView.vue'), meta: { title: '매입매출 전표' } },
        { path: 'invoicing/voucher-import', name: 'voucher-import', component: () => import('./screens/invoicing/VoucherImportView.vue'), meta: { title: '전표 파일 가져오기' } },
        { path: 'krtax/vat', name: 'vat', component: () => import('./screens/krtax/VatReturnView.vue'), meta: { title: '부가세 신고' } },
        { path: 'invoicing/tax', name: 'tax', component: () => import('./screens/invoicing/TaxView.vue'), meta: { title: '세금 신고' } },
        { path: 'invoicing/gaps', name: 'number-gaps', component: () => import('./screens/invoicing/GapsView.vue'), meta: { title: '번호 점검' } },
        { path: 'accounting/trial-summary', name: 'trial-summary', component: () => import('./screens/accounting/TrialSummaryView.vue'), meta: { title: '합계잔액시산표' } },
        { path: 'accounting/cost-statement', name: 'cost-statement', component: () => import('./screens/accounting/CostStatementView.vue'), meta: { title: '제조원가명세서' } },
        { path: 'accounting/retained', name: 'retained', component: () => import('./screens/accounting/RetainedView.vue'), meta: { title: '이익잉여금처분계산서' } },
        { path: 'accounting/sales-purchase', name: 'sales-purchase', component: () => import('./screens/accounting/SalesPurchaseBook.vue'), meta: { title: '매입매출장' } },
        { path: 'accounting/partner-ledger', name: 'partner-ledger', component: () => import('./screens/accounting/PartnerLedgerView.vue'), meta: { title: '거래처 원장' } },
        { path: 'accounting/cash-book', name: 'cash-book', component: () => import('./screens/accounting/CashBookView.vue'), meta: { title: '현금출납장' } },
        { path: 'accounting/day-book', name: 'day-book', component: () => import('./screens/accounting/DayBookView.vue'), meta: { title: '일계표·월계표' } },
        { path: 'accounting/closing', name: 'closing', component: () => import('./screens/accounting/ClosingView.vue'), meta: { title: '결산' } },
        { path: 'assets/run', name: 'depreciation', component: () => import('./screens/assets/DepreciationRunView.vue'), meta: { title: '감가상각 실행' } },
        { path: 'accounting/groups', name: 'account-groups', component: () => import('./screens/accounting/GroupsView.vue'), meta: { title: '계정 그룹 잔액' } },
        { path: 'accounting/opening', name: 'opening', component: () => import('./screens/accounting/OpeningView.vue'), meta: { title: '기초 잔액 입력' } },
        { path: 'hr/headcount', name: 'hr-headcount', component: () => import('./screens/hr/HeadcountView.vue'), meta: { title: '인원 현황' } },
        { path: 'payroll/my', name: 'payroll-my', component: () => import('./screens/payroll/MyPayslipsView.vue'), meta: { title: '내 명세서' } },
        { path: 'payroll/profiles', name: 'payroll-profiles', component: () => import('./screens/payroll/ProfilesView.vue'), meta: { title: '직원 급여 정보' } },
        { path: 'payroll/tax-tables', name: 'payroll-tax-tables', component: () => import('./screens/payroll/TaxTablesView.vue'), meta: { title: '간이세액표' } },
        { path: 'payroll/withholding', name: 'payroll-withholding', component: () => import('./screens/payroll/WithholdingView.vue'), meta: { title: '원천세' } },
        { path: 'payroll/insurance', name: 'payroll-insurance', component: () => import('./screens/payroll/InsuranceView.vue'), meta: { title: '4대보험 자료' } },
        { path: 'payroll/outlook', name: 'payroll-outlook', component: () => import('./screens/payroll/OutlookView.vue'), meta: { title: '인건비 전망' } },
        { path: 'mrp/outlook', name: 'mrp-outlook', component: () => import('./screens/mrp/MrpOutlookView.vue'), meta: { title: '제조 현황' } },
        { path: 'maintenance/reliability', name: 'maintenance-reliability', component: () => import('./screens/maintenance/ReliabilityView.vue'), meta: { title: '설비 신뢰도' } },
        { path: 'quality/analysis', name: 'quality-analysis', component: () => import('./screens/quality/AnalysisView.vue'), meta: { title: '불량률' } },
        { path: 'timeoff/me', name: 'timeoff-me', component: () => import('./screens/timeoff/MyLeaveView.vue'), meta: { title: '내 휴가' } },
        { path: 'timeoff/approvals', name: 'timeoff-approvals', component: () => import('./screens/timeoff/ApprovalsView.vue'), meta: { title: '승인함' } },
        { path: 'timeoff/calendar', name: 'timeoff-calendar', component: () => import('./screens/timeoff/TeamCalendarView.vue'), meta: { title: '팀 달력' } },
        { path: 'timeoff/balances', name: 'timeoff-balances', component: () => import('./screens/timeoff/BalancesView.vue'), meta: { title: '잔여 현황' } },
        { path: 'timeoff/outlook', name: 'timeoff-outlook', component: () => import('./screens/timeoff/OutlookView.vue'), meta: { title: '연차 소진 전망' } },
        { path: 'attendance/me', name: 'attendance-me', component: () => import('./screens/attendance/MyAttendanceView.vue'), meta: { title: '내 근태' } },
        { path: 'attendance/week', name: 'attendance-week', component: () => import('./screens/attendance/WeekView.vue'), meta: { title: '주간 현황' } },
        { path: 'attendance/month', name: 'attendance-month', component: () => import('./screens/attendance/MonthView.vue'), meta: { title: '월 마감' } },
        { path: 'attendance/overtime', name: 'attendance-overtime', component: () => import('./screens/attendance/OvertimeView.vue'), meta: { title: '초과근무' } },
        { path: 'project/analysis', name: 'project-analysis', component: () => import('./screens/project/AnalysisView.vue'), meta: { title: '프로젝트 분석' } },
        { path: 'analytic/report', name: 'analytic-report', component: () => import('./screens/analytic/ReportView.vue'), meta: { title: '분석 계정별 손익' } },
        { path: 'analytic/budgets', name: 'analytic-budgets', component: () => import('./screens/analytic/BudgetsView.vue'), meta: { title: '예산 대비 실적' } },
        { path: 'crm/analysis', name: 'crm-analysis', component: () => import('./screens/crm/AnalysisView.vue'), meta: { title: '영업 분석' } },
        { path: 'subscription/analysis', name: 'subscription-analysis', component: () => import('./screens/subscription/AnalysisView.vue'), meta: { title: 'MRR 분석' } },
        { path: 'expense/trend', name: 'expense-trend', component: () => import('./screens/expense/TrendView.vue'), meta: { title: '부서별 경비 추이' } },
        { path: 'master/variants', name: 'variants', component: () => import('./screens/master/VariantsView.vue'), meta: { title: '전체 변형' } },
        { path: 'master/duplicates', name: 'duplicates', component: () => import('./screens/master/DuplicatesView.vue'), meta: { title: '중복 연락처' } },
        { path: 'print/:type/:id', name: 'print', component: () => import('./screens/print/PrintView.vue'), props: true, meta: { title: '출력' } },
        { path: 'settings', redirect: '/settings/company' },
        { path: 'settings/import', name: 'import', component: () => import('./screens/settings/ImportView.vue'), meta: { title: '표 파일 가져오기' } },
        { path: 'settings/locks', name: 'locks', component: () => import('./screens/settings/LocksView.vue'), meta: { title: '마감 잠금' } },
        { path: 'settings/documents', name: 'documents', component: () => import('./screens/settings/DocumentsView.vue'), meta: { title: '문서 양식' } },
        { path: 'settings/modules', name: 'modules', component: ModulesView, meta: { title: '모듈' } },
        { path: 'settings/bus', name: 'bus', component: BusView, meta: { title: '이벤트 버스' } },
        { path: 'settings/integration', name: 'integration', component: IntegrationView, meta: { title: '연동' } },
        { path: 'settings/:tab', name: 'settings', component: SettingsView, props: true, meta: { title: '설정' } },
        { path: ':rest(.*)*', name: 'notfound', component: NotFoundView, meta: { title: '찾을 수 없음' } },
      ],
    },
  ],
})

// Types managed from settings have no generic list of their own.
function listRedirect(name: unknown, type: unknown) {
  if (name !== 'list') return true
  const route = screenFor(String(type))?.route
  return route ? { path: route } : true
}

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!conn.value) return { name: 'setup' }
  if (session.phase !== 'ready') {
    const phase = await boot()
    if (phase === 'ready') return listRedirect(to.name, to.params.type)
    if (phase === 'offline') return { name: 'offline', query: { next: to.fullPath } }
    if (phase === 'anon' || phase === 'not-member') return { name: 'login', query: to.fullPath === '/' ? {} : { next: to.fullPath } }
    return { name: 'setup' }
  }
  return listRedirect(to.name, to.params.type)
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  if (title) document.title = `${title} · uEngine ERP`
})
