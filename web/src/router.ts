import { createRouter, createWebHashHistory } from 'vue-router'
import { conn } from './lib/conn'
import { boot, session } from './lib/session'
import { screenFor } from './nav'
import AppShell from './components/AppShell.vue'
import SetupView from './views/SetupView.vue'
import LoginView from './views/LoginView.vue'
import ConnectView from './views/ConnectView.vue'
import OfflineView from './views/OfflineView.vue'
import HomeView from './views/HomeView.vue'
import RecordListRoute from './views/RecordListRoute.vue'
import RecordFormRoute from './views/RecordFormRoute.vue'
import EventsView from './views/EventsView.vue'
import SettingsView from './views/SettingsView.vue'
import ModulesView from './views/ModulesView.vue'
import BusView from './views/BusView.vue'
import NotFoundView from './views/NotFoundView.vue'

export const router = createRouter({
  // Hash routing: invite links and record paths never reach the static host.
  history: createWebHashHistory(),
  routes: [
    { path: '/setup', name: 'setup', component: SetupView, meta: { public: true, title: '설치 안내' } },
    { path: '/connect', name: 'connect', component: ConnectView, meta: { public: true, title: '회사 접속' } },
    { path: '/login', name: 'login', component: LoginView, meta: { public: true, title: '로그인' } },
    { path: '/offline', name: 'offline', component: OfflineView, meta: { public: true, title: '연결 안 됨' } },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'home', component: HomeView, meta: { title: '홈' } },
        { path: 'r/:type', name: 'list', component: RecordListRoute, props: true },
        { path: 'r/:type/new', name: 'new', component: RecordFormRoute, props: true },
        { path: 'r/:type/:id', name: 'record', component: RecordFormRoute, props: true },
        { path: 'events', name: 'events', component: EventsView, meta: { title: '이벤트 원장' } },
        { path: 'analytics', name: 'analytics', component: () => import('./screens/AnalyticsScreen.vue'), meta: { title: '분석' } },
        { path: 'settings', redirect: '/settings/company' },
        { path: 'settings/modules', name: 'modules', component: ModulesView, meta: { title: '모듈' } },
        { path: 'settings/bus', name: 'bus', component: BusView, meta: { title: '이벤트 버스' } },
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
