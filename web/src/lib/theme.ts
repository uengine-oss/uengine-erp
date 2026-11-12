// How the app looks. 기본 is the look the app has always had and stays the default; the others redefine the same
// colour tokens and move the menu. A preference of this browser, never of the company: it is not in the ledger.
import { ref } from 'vue'

export type Theme = 'classic' | 'talk' | 'console'

export const THEMES: { key: Theme; label: string; text: string }[] = [
  { key: 'classic', label: '기본', text: '왼쪽 메뉴·남색이며 기기의 어두운 화면 설정을 따릅니다.' },
  { key: 'talk', label: '대화', text: '밝은 바탕·귤색이며, 문서는 종이 한 장처럼, 이력은 누가 무엇을 했는지 나눈 말처럼 보입니다.' },
  { key: 'console', label: '관제', text: '어두운 바탕과 라임색을 씁니다. 모듈은 위쪽 탭에, 연결 지도는 문서 옆에, 원장 띠는 아래에 보입니다.' },
]

const KEY = 'erp.theme'

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return THEMES.some((t) => t.key === v) ? (v as Theme) : 'classic'
  } catch {
    return 'classic'
  }
}

// 기본 carries no attribute at all, so every style written before themes existed applies exactly as it did.
function apply(t: Theme) {
  const root = document.documentElement
  if (t === 'classic') delete root.dataset.theme
  else root.dataset.theme = t
}

export const theme = ref<Theme>(stored())
apply(theme.value)

export function setTheme(t: Theme): void {
  theme.value = t
  apply(t)
  try { localStorage.setItem(KEY, t) } catch { /* preference only */ }
}

/** Phone width, where every theme falls back to the menu that slides over the page. */
const phone = window.matchMedia('(max-width: 720px)')
export const narrow = ref(phone.matches)
phone.addEventListener('change', (e) => { narrow.value = e.matches })

/** One hue per module, for the marks that say where an event came from. Chosen to read on the dark 관제 ground. */
const HUES: Record<string, string> = {
  sales: '#7aa2ff', inventory: '#4fe0b0', purchase: '#5bd4f0', invoicing: '#ffb454', accounting: '#d69bff', helpdesk: '#ff8fb1',
  subscription: '#9be36b', krtax: '#f2d45c', analytic: '#c3a6ff', hr: '#ff9e7a', payroll: '#f7b267', mrp: '#6fd3c7',
  maintenance: '#a8c5ff', quality: '#7ee8a2', assets: '#c9b79c', timeoff: '#ffc2e2', attendance: '#8fd3ff', crm: '#ff8a8a',
  project: '#b5e48c', expense: '#ffd166',
}
export function moduleHue(module: string | undefined): string {
  return (module && HUES[module]) || '#9aa5b5'
}
