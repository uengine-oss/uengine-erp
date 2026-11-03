// When this screen may not write: looking at a past date, or an app and a database of different versions.
// Only the reason lives here. What is allowed stays in the database, which checks every command again.
import { computed, reactive, watch } from 'vue'
import { compareVersions } from './format'
import { APP_VERSION } from './install'
import { session } from './session'

/** The whole company as it stood at the end of a day. Empty `at` means the present. */
export const timeView = reactive({ date: '', at: '' })

/** The instant a day ends in the company's zone, which is how every date on screen is read. */
export function endOfDay(day: string): string {
  const zone = session.company?.state?.timezone || 'Asia/Seoul'
  const guess = Date.parse(`${day}T23:59:59.999Z`)
  const wall = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(guess))
  const offset = Date.parse(`${wall.replace(' ', 'T')}.999Z`) - guess
  return new Date(guess - offset).toISOString()
}

export function enterTimeView(day: string): void {
  timeView.date = day
  timeView.at = endOfDay(day)
}

export function exitTimeView(): void {
  timeView.date = ''
  timeView.at = ''
}

// The next person to sign in on this browser starts in the present.
watch(() => session.me, (me) => { if (!me) exitTimeView() })

export const dbOutdated = computed(() => session.status?.version != null && compareVersions(session.status.version, APP_VERSION) < 0)
export const appOutdated = computed(() => !!session.status?.min_app_version && compareVersions(APP_VERSION, session.status.min_app_version) < 0)

export type WriteBlock = 'time' | 'app' | 'db' | null

export const writeBlock = computed<WriteBlock>(() => {
  if (appOutdated.value) return 'app'
  if (dbOutdated.value) return 'db'
  if (timeView.at) return 'time'
  return null
})

export const writeBlockMessage = computed(() => {
  switch (writeBlock.value) {
    case 'app': return '앱이 데이터베이스보다 오래되었습니다. 새로 고친 뒤 다시 시도하세요.'
    case 'db': return '데이터베이스 업그레이드가 끝나야 저장할 수 있습니다.'
    case 'time': return `${timeView.date} 시점을 보는 동안에는 저장할 수 없습니다.`
    default: return ''
  }
})
