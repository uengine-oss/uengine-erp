<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMenu } from '../lib/menu'
import { narrow, theme } from '../lib/theme'
import { navOpen } from '../lib/ui'
import Icon from './Icon.vue'

const route = useRoute()
const { modules, screenActive, moduleActive } = useMenu()

// 기본 lists a module's screens under it. The other themes show them in a row of their own above the page, except at
// phone width, where every theme is the same menu sliding over the page.
const nested = computed(() => theme.value === 'classic' || narrow.value)

const nav = ref<HTMLElement>()
// A row of tabs scrolls sideways, and a mouse wheel only scrolls up and down.
function wheel(e: WheelEvent) {
  if (theme.value !== 'console' || narrow.value || !nav.value || e.deltaX) return
  nav.value.scrollLeft += e.deltaY
  e.preventDefault()
}
// A rail or a row of tabs can hold the current module out of sight.
watch([() => route.path, theme, narrow], async () => {
  if (nested.value) return
  await nextTick()
  nav.value?.querySelector('.side-module.on, .side-module.open')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })
</script>

<template>
  <nav ref="nav" class="side" aria-label="주 메뉴" @wheel="wheel">
    <router-link to="/" class="side-brand" @click="navOpen = false">
      <span class="brand-mark"><svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 5v14a9 9 0 0 0 18 0V5h-5v14a4 4 0 0 1-8 0V5z" fill="#fff" /></svg></span>
      <span class="side-brand-name">uEngine ERP</span>
    </router-link>
    <ul class="side-list">
      <li v-for="m in modules" :key="m.key">
        <router-link :to="m.to" class="side-module" :class="{ on: moduleActive(m) && !m.screens.length, open: moduleActive(m) && m.screens.length }" :data-module="m.key" :title="nested ? undefined : m.label" @click="navOpen = !!m.screens.length && navOpen">
          <Icon :name="m.icon" :size="15" />
          <span>{{ m.label }}</span>
          <Icon v-if="m.screens.length" class="side-caret" :name="moduleActive(m) ? 'chevron-down' : 'chevron-right'" :size="12" />
        </router-link>
        <ul v-if="nested && m.screens.length && moduleActive(m)" class="side-sub">
          <li v-for="s in m.screens" :key="s.key">
            <router-link :to="s.to" class="side-screen" :class="{ on: screenActive(s) }" :data-screen="s.key" @click="navOpen = false">{{ s.label }}</router-link>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.side { display: flex; flex-direction: column; width: 200px; flex: none; background: var(--ink-900); color: var(--ink-300); overflow-y: auto; }
.side-brand { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 14px; color: #fff; font-size: 14px; font-weight: 650; border-bottom: 1px solid var(--ink-800); text-decoration: none; flex: none; }
.side-list, .side-sub { list-style: none; margin: 0; padding: 0; }
.side-list { padding: 6px 0; }
.side-module { display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 14px; color: var(--ink-300); text-decoration: none; font-weight: 500; }
.side-module:hover { background: var(--ink-800); color: #fff; text-decoration: none; }
.side-module.on { background: var(--ink-800); color: #fff; box-shadow: inset 2px 0 0 #fff; }
.side-module.open { color: #fff; }
.side-caret { margin-left: auto; opacity: 0.6; }
.side-sub { padding: 0 0 6px; }
.side-screen { display: block; padding: 4px 14px 4px 38px; color: var(--ink-300); text-decoration: none; font-size: 12.5px; }
.side-screen:hover { color: #fff; text-decoration: none; background: var(--ink-800); }
.side-screen.on { color: #fff; font-weight: 600; background: var(--ink-800); box-shadow: inset 2px 0 0 #fff; }
.side a:focus-visible { outline-color: #fff; outline-offset: -2px; }

@media screen {
  /* 관제 runs its ink scale light, and the menu is dark in every theme. */
  :root[data-theme='console'] .side { --ink-900: #101620; --ink-800: #1b2330; --ink-300: #9aa5b5; }
  :root[data-theme='console'] .side-module.on,
  :root[data-theme='console'] .side-screen.on { box-shadow: inset 2px 0 0 var(--navy-700); }
  :root[data-theme='talk'] .side-module.on,
  :root[data-theme='talk'] .side-screen.on { box-shadow: inset 2px 0 0 var(--navy-700); }
}

@media screen and (min-width: 721px) {
  /* 대화: a narrow rail of modules, icon over name. */
  :root[data-theme='talk'] .side { width: 76px; scrollbar-width: none; }
  :root[data-theme='talk'] .side-brand { justify-content: center; height: 56px; padding: 0; border-bottom: 0; }
  :root[data-theme='talk'] .side-brand .brand-mark { width: 30px; height: 30px; border-radius: 9px; }
  :root[data-theme='talk'] .side-brand .brand-mark svg path { fill: var(--on-brand); }
  :root[data-theme='talk'] .side-brand-name { display: none; }
  :root[data-theme='talk'] .side-list { display: flex; flex-direction: column; gap: 2px; padding: 2px 8px 14px; }
  :root[data-theme='talk'] .side-module { flex-direction: column; justify-content: center; gap: 4px; height: 52px; padding: 0 2px; border-radius: 12px; color: #a5a6ad; font-size: 10.5px; line-height: 1.1; }
  :root[data-theme='talk'] .side-module > svg:first-child { width: 19px; height: 19px; }
  :root[data-theme='talk'] .side-module > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :root[data-theme='talk'] .side-module:hover { background: rgba(255, 255, 255, 0.07); }
  :root[data-theme='talk'] .side-module.on,
  :root[data-theme='talk'] .side-module.open { background: rgba(255, 255, 255, 0.1); box-shadow: none; color: #fff; font-weight: 650; }
  :root[data-theme='talk'] .side-module.on > svg:first-child,
  :root[data-theme='talk'] .side-module.open > svg:first-child { color: var(--navy-700); }
  :root[data-theme='talk'] .side-caret { display: none; }

  /* 관제: the modules are a row of tabs under the top bar. */
  :root[data-theme='console'] .side { order: -2; flex-direction: row; width: auto; height: 34px; overflow: auto hidden; scrollbar-width: none; border-bottom: 1px solid var(--line); }
  :root[data-theme='console'] .side-brand { display: none; }
  :root[data-theme='console'] .side-list { display: flex; padding: 0 6px; }
  :root[data-theme='console'] .side-list > li { flex: none; }
  :root[data-theme='console'] .side-module { height: 33px; padding: 0 11px; gap: 6px; border-bottom: 2px solid transparent; font-size: 12.5px; white-space: nowrap; }
  :root[data-theme='console'] .side-module > svg:first-child { opacity: 0.7; }
  :root[data-theme='console'] .side-module:hover { background: none; }
  :root[data-theme='console'] .side-module.on,
  :root[data-theme='console'] .side-module.open { background: none; box-shadow: none; border-bottom-color: var(--navy-700); color: #fff; font-weight: 650; }
  :root[data-theme='console'] .side-module.on > svg:first-child,
  :root[data-theme='console'] .side-module.open > svg:first-child { color: var(--navy-700); opacity: 1; }
  :root[data-theme='console'] .side-caret { display: none; }
}
</style>
