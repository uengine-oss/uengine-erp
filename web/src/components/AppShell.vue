<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { refreshBus } from '../lib/bus'
import { onLedgerEvent } from '../lib/realtime'
import { loadCatalog } from '../lib/session'
import { narrow, theme } from '../lib/theme'
import { navOpen } from '../lib/ui'
import DemoBanner from './DemoBanner.vue'
import LedgerStrip from './LedgerStrip.vue'
import NetBanner from './NetBanner.vue'
import RollbackDialog from './RollbackDialog.vue'
import SideNav from './SideNav.vue'
import StallBanner from './StallBanner.vue'
import SubNav from './SubNav.vue'
import TimeBanner from './TimeBanner.vue'
import TopBar from './TopBar.vue'
import UpgradeBanner from './UpgradeBanner.vue'

// A subscriber fails without leaving an event, and cron keeps delivering while this tab sits open.
const BUS_POLL_MS = 60_000
const CRON_DELAY_MS = 6_000
let poll: ReturnType<typeof setInterval> | undefined
let afterEvent: ReturnType<typeof setTimeout> | undefined
let catalogTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  void refreshBus()
  poll = setInterval(() => { if (!document.hidden) void refreshBus() }, BUS_POLL_MS)
})
onLedgerEvent((ev) => {
  clearTimeout(afterEvent)
  afterEvent = setTimeout(refreshBus, CRON_DELAY_MS)
  // Someone else turned a module on or off: this browser's menu follows.
  if (ev.stream_type === 'module') {
    clearTimeout(catalogTimer)
    catalogTimer = setTimeout(() => { void loadCatalog().catch(() => {}) }, 200)
  }
})
onBeforeUnmount(() => {
  clearInterval(poll)
  clearTimeout(afterEvent)
  clearTimeout(catalogTimer)
})
</script>

<template>
  <div class="shell" :class="{ 'nav-open': navOpen }">
    <div class="side-scrim no-print" aria-hidden="true" @click="navOpen = false"></div>
    <SideNav class="no-print" />
    <div class="shell-main">
      <TopBar class="no-print" />
      <SubNav v-if="theme !== 'classic' && !narrow" class="no-print" />
      <UpgradeBanner />
      <DemoBanner />
      <TimeBanner />
      <StallBanner />
      <NetBanner />
      <main class="shell-body"><router-view /></main>
      <LedgerStrip v-if="theme === 'console'" class="no-print" />
    </div>
    <RollbackDialog />
  </div>
</template>

<style>
.shell { display: flex; height: 100%; min-height: 0; }
.shell-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.shell-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.side-scrim { display: none; }
@media (max-width: 720px) {
  .shell > .side { position: fixed; inset: 0 auto 0 0; z-index: 800; width: 240px; visibility: hidden; transform: translateX(-100%); transition: transform 0.15s, visibility 0.15s; }
  .shell.nav-open > .side { visibility: visible; transform: none; }
  .shell.nav-open > .side-scrim { display: block; position: fixed; inset: 0; z-index: 790; background: rgba(10, 19, 34, 0.42); }
}
/* 관제 stacks the menu above the page: top bar, module tabs, the module's screens, then the page and the ledger strip.
   The column on the right dissolves so the menu can sit between its children; each of them says where it goes. */
@media screen and (min-width: 721px) {
  :root[data-theme='console'] .shell { flex-direction: column; }
  :root[data-theme='console'] .shell-main { display: contents; }
}
</style>
