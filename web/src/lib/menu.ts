// The menu and where the current page sits in it. Shared by every place a theme draws the menu.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { resolveNav, type ResolvedModule } from '../nav'
import { session } from './session'

export function useMenu() {
  const route = useRoute()
  const modules = computed(() => resolveNav(session.catalog, session.me?.roles ?? []))

  function matches(prefix: string | undefined) {
    return !!prefix && (route.path === prefix || route.path.startsWith(`${prefix}/`))
  }
  function screenActive(s: { to: string; also?: string }) {
    return matches(s.to) || matches(s.also)
  }
  function moduleActive(m: ResolvedModule) {
    if (m.screens.length) return m.screens.some(screenActive)
    return m.to === '/' ? route.path === '/' : matches(m.to)
  }
  const current = computed(() => modules.value.find(moduleActive))

  return { modules, screenActive, moduleActive, current }
}
