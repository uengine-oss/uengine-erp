<script setup lang="ts">
// The look of the app, chosen per browser. Nothing here is written to the ledger: two people of one company can
// work in different themes, and the same person in a different one on another device.
import { setTheme, theme, THEMES, type Theme } from '../../lib/theme'
import Icon from '../../components/Icon.vue'

// A small drawing of each theme: where the menu sits, the ground, the colour that marks what to do next.
const SWATCH: Record<Theme, { ground: string; sheet: string; menu: string; brand: string; line: string }> = {
  classic: { ground: '#f6f7f9', sheet: '#ffffff', menu: '#101828', brand: '#1f3a8a', line: '#dfe3ea' },
  talk: { ground: '#f4f4f1', sheet: '#ffffff', menu: '#17181c', brand: '#ff6a2b', line: '#e4e4df' },
  console: { ground: '#0c1016', sheet: '#141a23', menu: '#101620', brand: '#c6f23a', line: '#26303f' },
}
</script>

<template>
  <div class="page" data-testid="theme-settings">
    <div class="page-head"><h1>화면 테마</h1></div>
    <div class="page-body report-pad">
      <p class="hint theme-note">이 브라우저에만 적용됩니다. 메뉴, 화면 내용, 할 수 있는 일은 어느 테마에서나 같습니다.</p>
      <ul class="theme-list" role="radiogroup" aria-label="화면 테마">
        <li v-for="t in THEMES" :key="t.key">
          <button type="button" class="theme-card" :class="{ on: theme === t.key }" role="radio" :aria-checked="theme === t.key" :data-testid="`theme-${t.key}`" @click="setTheme(t.key)">
            <span class="swatch" :class="`swatch-${t.key}`" aria-hidden="true"
                  :style="{ '--g': SWATCH[t.key].ground, '--s': SWATCH[t.key].sheet, '--m': SWATCH[t.key].menu, '--b': SWATCH[t.key].brand, '--l': SWATCH[t.key].line }">
              <i class="sw-menu"></i>
              <i class="sw-sheet"><b></b><b></b><b></b><em></em></i>
              <i class="sw-side"></i>
            </span>
            <span class="theme-text">
              <strong>{{ t.label }}<Icon v-if="theme === t.key" name="check" :size="13" /></strong>
              <span class="small">{{ t.text }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.theme-note { max-width: 760px; margin-bottom: 12px; }
.theme-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; max-width: 900px; margin: 0; padding: 0; list-style: none; }
.theme-card { display: flex; flex-direction: column; gap: 10px; width: 100%; height: 100%; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.theme-card:hover { border-color: var(--line-strong); }
.theme-card.on { border-color: var(--navy-700); box-shadow: 0 0 0 1px var(--navy-700); }
.theme-text { display: flex; flex-direction: column; gap: 3px; }
.theme-text strong { display: inline-flex; align-items: center; gap: 5px; }
.theme-text .small { color: var(--text-2); line-height: 1.45; }

.swatch { position: relative; display: block; height: 112px; overflow: hidden; border: 1px solid var(--l); border-radius: 4px; background: var(--g); }
.swatch i { position: absolute; display: block; }
.sw-menu { background: var(--m); }
.sw-sheet { background: var(--s); border: 1px solid var(--l); }
.sw-sheet b { display: block; height: 4px; margin: 7px 8px 0; border-radius: 2px; background: var(--l); }
.sw-sheet b:first-child { width: 40%; margin-top: 9px; }
.sw-sheet em { position: absolute; right: 8px; bottom: 8px; width: 26px; height: 9px; border-radius: 2px; background: var(--b); }
.sw-side { background: var(--s); border: 1px solid var(--l); }
/* 기본: the menu down the left, the history beside the document. */
.swatch-classic .sw-menu { inset: 0 auto 0 0; width: 22%; }
.swatch-classic .sw-sheet { inset: 12px 30% 0 22%; border-width: 1px 1px 0 0; }
.swatch-classic .sw-side { inset: 12px 0 0 70%; border-width: 1px 0 0; }
/* 대화: a narrow rail, the document as a sheet on the ground. */
.swatch-talk .sw-menu { inset: 0 auto 0 0; width: 9%; }
.swatch-talk .sw-sheet { inset: 14px 36% 12px 15%; border-radius: 6px; }
.swatch-talk .sw-sheet em { border-radius: 5px; }
.swatch-talk .sw-side { inset: 14px 6px 12px 69%; border: 1px dashed var(--b); border-radius: 6px; background: none; }
/* 관제: tabs along the top, the ledger along the bottom. */
.swatch-console .sw-menu { inset: 0 0 auto 0; height: 14px; border-bottom: 2px solid var(--b); }
.swatch-console .sw-sheet { inset: 16px 34% 10px 0; border: 0; }
.swatch-console .sw-side { inset: 16px 0 10px 66%; border-width: 0 0 0 1px; }
.swatch-console .sw-side::before { content: ''; position: absolute; inset: 8px 8px auto 8px; height: 14px; border-left: 2px solid var(--b); background: var(--m); }
.swatch-console::after { content: ''; position: absolute; inset: auto 0 0 0; height: 9px; background: #080b10; border-left: 22px solid var(--b); }
@media (max-width: 720px) {
  .theme-list { grid-template-columns: minmax(0, 1fr); }
}
</style>
