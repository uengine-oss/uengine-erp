<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { resolveNav } from '../nav'
import { session } from '../lib/session'
import { navOpen } from '../lib/ui'
import Icon from './Icon.vue'

const route = useRoute()
const modules = computed(() => resolveNav(session.catalog, session.me?.roles ?? []))

function matches(prefix: string | undefined) {
  return !!prefix && (route.path === prefix || route.path.startsWith(`${prefix}/`))
}
function screenActive(s: { to: string; also?: string }) {
  return matches(s.to) || matches(s.also)
}
function moduleActive(m: (typeof modules.value)[number]) {
  if (m.screens.length) return m.screens.some(screenActive)
  return m.to === '/' ? route.path === '/' : matches(m.to)
}
</script>

<template>
  <nav class="side" aria-label="주 메뉴">
    <router-link to="/" class="side-brand" @click="navOpen = false">
      <span class="brand-mark"><svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 5v14a9 9 0 0 0 18 0V5h-5v14a4 4 0 0 1-8 0V5z" fill="#fff" /></svg></span>
      uEngine ERP
    </router-link>
    <ul class="side-list">
      <li v-for="m in modules" :key="m.key">
        <router-link :to="m.to" class="side-module" :class="{ on: moduleActive(m) && !m.screens.length, open: moduleActive(m) && m.screens.length }" :data-module="m.key" @click="navOpen = !!m.screens.length && navOpen">
          <Icon :name="m.icon" :size="15" />
          <span>{{ m.label }}</span>
          <Icon v-if="m.screens.length" class="side-caret" :name="moduleActive(m) ? 'chevron-down' : 'chevron-right'" :size="12" />
        </router-link>
        <ul v-if="m.screens.length && moduleActive(m)" class="side-sub">
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
</style>
