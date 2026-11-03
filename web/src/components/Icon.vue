<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 15 })

// Monoline icons drawn on a 24-unit grid. Inline so the page needs no icon font or external file.
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5.5 9.5V20h13V9.5M10 20v-6h4v6',
  sales: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  purchase: 'M3 4h2.5l2.2 11h10.1l2-8H6.5M9.5 20h.01M17 20h.01',
  inventory: 'M3.5 8L12 3.5 20.5 8v8L12 20.5 3.5 16zM3.5 8L12 12.5 20.5 8M12 12.5v8',
  invoicing: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9.5 8l1.2 5 1.3-3.5 1.3 3.5 1.2-5M9 10.5h6',
  accounting: 'M5 3h14v18H5zM8.5 7h7M8.5 11h7M8.5 15h3',
  assets: 'M3 21h18M5 21V10l7-5 7 5v11M10 21v-6h4v6',
  master: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  analytics: 'M4 20h16M7 20v-7M12 20V5M17 20v-10',
  events: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.8-3.8',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M4 20h16',
  printer: 'M7 8V3h10v5M7 17H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-3M7 14h10v7H7z',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2',
  refresh: 'M20 11a8 8 0 0 0-14.3-3.5L3.5 10M3.5 4.5V10H9M4 13a8 8 0 0 0 14.3 3.5l2.2-2.5M20.5 19.5V14H15',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  alert: 'M12 4l9.5 16.5h-19zM12 10v4.5M12 17.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  lock: 'M6 11h12v9H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  logout: 'M15 4h5v16h-5M10 8l-4 4 4 4M6 12h9',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5',
  shield: 'M12 3l7.5 3v6c0 4.5-3.2 7.6-7.5 9-4.3-1.4-7.5-4.5-7.5-9V6z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  undo: 'M4 9h10a6 6 0 0 1 0 12h-3M4 9l4-4M4 9l4 4',
  link: 'M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.7-5.7l-1.3 1.3M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.7 5.7l1.3-1.3',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex: none">
    <path :d="PATHS[name]" />
  </svg>
</template>
