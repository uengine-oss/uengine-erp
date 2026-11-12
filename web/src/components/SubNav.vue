<script setup lang="ts">
// The screens of the current module, in a row above the page. Used by the themes whose menu has no room to list
// them under the module; 기본 and phone width keep them in the menu itself.
import { nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMenu } from '../lib/menu'
import Icon from './Icon.vue'

const route = useRoute()
const { current, screenActive } = useMenu()

const row = ref<HTMLElement>()
watch(() => route.path, async () => {
  await nextTick()
  row.value?.querySelector('.subnav-screen.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })
</script>

<template>
  <nav v-if="current?.screens.length" ref="row" class="subnav" :aria-label="`${current.label} 화면`">
    <span class="subnav-module"><Icon :name="current.icon" :size="14" />{{ current.label }}</span>
    <router-link v-for="s in current.screens" :key="s.key" :to="s.to" class="subnav-screen" :class="{ on: screenActive(s) }" :data-screen="s.key">{{ s.label }}</router-link>
  </nav>
</template>

<style scoped>
.subnav { display: flex; align-items: center; gap: 4px; flex: none; height: 40px; padding: 0 16px; overflow: auto hidden; scrollbar-width: none; background: var(--bg); border-bottom: 1px solid var(--line); }
.subnav-module { display: inline-flex; align-items: center; gap: 6px; flex: none; margin-right: 8px; font-weight: 700; color: var(--text); white-space: nowrap; }
.subnav-screen { flex: none; padding: 4px 11px; border-radius: 999px; color: var(--text-2); font-size: 12.5px; font-weight: 550; text-decoration: none; white-space: nowrap; }
.subnav-screen:hover { background: var(--ink-100); color: var(--text); text-decoration: none; }
.subnav-screen.on { background: var(--ink-900); color: #fff; }

@media screen {
  :root[data-theme='console'] .subnav { order: -1; height: 30px; gap: 0; padding: 0 8px; background: var(--surface); }
  :root[data-theme='console'] .subnav-module { margin-right: 10px; padding-right: 10px; border-right: 1px solid var(--line); color: var(--text-3); font-size: 11.5px; font-weight: 600; }
  :root[data-theme='console'] .subnav-screen { padding: 0 10px; border-radius: 0; font-size: 12px; line-height: 29px; }
  :root[data-theme='console'] .subnav-screen:hover { background: none; color: var(--text); }
  :root[data-theme='console'] .subnav-screen.on { background: none; color: var(--navy-700); box-shadow: inset 0 -2px 0 var(--navy-700); }
}
</style>
