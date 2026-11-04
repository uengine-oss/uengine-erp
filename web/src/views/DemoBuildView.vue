<script setup lang="ts">
// Building the made-up company. The story and its sender load only here, so a real company never downloads them.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { messageOf, rpc } from '../lib/api'
import type { DemoBuild, DemoProgress } from '../lib/demo/build.ts'
import { boot, isAdmin, refreshStatus, session } from '../lib/session'
import type { BusTick } from '../lib/types'
import { toast } from '../lib/ui'
import Icon from '../components/Icon.vue'
import SplitLayout from '../components/SplitLayout.vue'

const route = useRoute()
const router = useRouter()
const NAMES: Record<string, string> = { inventory: '재고', purchase: '구매', invoicing: '청구', accounting: '회계', sales: '판매', hr: '인사', mrp: '제조' }

const progress = ref<DemoProgress | null>(null)
const running = ref(false)
const finishing = ref(false)
const error = ref('')
let build: DemoBuild | null = null
let booted = false
const admin = computed(() => isAdmin())

async function start() {
  error.value = ''
  running.value = true
  try {
    // Only the setup wizard starts one, and only a demo company still being built can carry on. An address typed by
    // hand must not turn a real company into a demo.
    const demo = !!session.status?.demo
    const open = demo && !!(await rpc<BusTick>('erp_bus_tick')).paused
    const fresh = !demo && route.query.start === '1'
    if (!fresh && !open) { await router.replace('/'); return }
    const { DemoBuild } = await import('../lib/demo/build.ts')
    build = new DemoBuild((p) => { progress.value = p })
    const done = await build.run(fresh)
    if (done) await leave()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    running.value = false
  }
}

async function leave() {
  await refreshStatus()
  await boot()
  booted = true
  toast('가상 회사를 만들었습니다.')
  await router.replace('/')
}

async function stopHere() {
  build?.stop()
  finishing.value = true
  error.value = ''
  try {
    const { finishHere } = await import('../lib/demo/build.ts')
    await finishHere()
    await leave()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    finishing.value = false
  }
}

onMounted(() => { if (admin.value) void start() })
// The batch on its way finishes by itself; the next visit carries on from there. The story may have turned modules on
// since the menus were read, so they are read again.
onBeforeUnmount(() => {
  build?.stop()
  if (build && !booted) void boot()
})
</script>

<template>
  <SplitLayout note="계산은 이 브라우저에서 하고, 만든 데이터는 이 회사의 Supabase 프로젝트로만 갑니다.">
    <h1 class="split-title">가상 회사를 만드는 중입니다</h1>
    <p class="split-lead">가온가전의 3년을 사람이 쓰는 것과 같은 명령으로 차례로 넣습니다. 그동안 모듈을 하나씩 켭니다. 약 250 MB 를 쓰며, 몇 분 걸립니다.</p>

    <div v-if="!admin" class="banner banner-warn" role="alert" data-testid="demo-not-admin"><Icon name="alert" /><span>관리자만 만들 수 있습니다.</span></div>
    <template v-else>
      <div class="stack" data-testid="demo-progress">
        <div class="row small dim" style="justify-content: space-between">
          <span data-testid="demo-day">{{ progress ? `${progress.day} 까지 만들었습니다` : '준비하는 중입니다' }}</span>
          <span data-testid="demo-percent">{{ progress?.percent ?? 0 }}%</span>
        </div>
        <div class="meter" style="height: 12px; border-radius: 6px" role="progressbar" :aria-valuenow="progress?.percent ?? 0" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${progress?.percent ?? 0}%` }"></i></div>
        <p v-if="progress" class="small muted" data-testid="demo-steps">명령 {{ progress.steps.toLocaleString('ko-KR') }}개를 처리했습니다.</p>
        <ul v-if="progress?.modules.length" class="story small dim" data-testid="demo-modules">
          <li v-for="m in progress.modules" :key="m.id">{{ m.day }} {{ NAMES[m.id] ?? m.id }} 모듈을 켰습니다</li>
        </ul>
      </div>

      <div v-if="error" class="banner banner-error" role="alert" style="margin-top: 12px" data-testid="demo-error">
        <Icon name="alert" /><span class="grow">{{ error }}</span>
        <button type="button" class="btn btn-sm" data-testid="demo-retry" @click="start">다시 시도</button>
      </div>
      <p class="small muted" style="margin-top: 12px">이 탭을 닫아도 만든 데까지는 남습니다. 이 브라우저로 다시 들어오면 이어서 만듭니다.</p>
      <p style="margin-top: 8px"><button type="button" class="btn btn-ghost btn-sm" :disabled="finishing" data-testid="demo-stop" @click="stopHere">여기까지만 만들고 둘러보기</button></p>
    </template>
  </SplitLayout>
</template>

<style scoped>
.story { margin: 4px 0 0; padding-left: 16px; }
</style>
