<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { messageOf } from '../lib/api'
import { bus, isStalled, moduleLabel, refreshBus, stalls } from '../lib/bus'
import { retrySubscription, skipSubscriptionEvent } from '../lib/commands'
import { eventLabel } from '../lib/eventText'
import { fmtDateTime } from '../lib/format'
import { writeBlock, writeBlockMessage } from '../lib/mode'
import { isAdmin } from '../lib/session'
import type { BusSubscription } from '../lib/types'
import { ask, toast } from '../lib/ui'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'

const admin = computed(() => isAdmin())
const busy = ref('')

onMounted(() => { if (admin.value) void refreshBus() })
watch(admin, (v) => { if (v) void refreshBus() })

function statusOf(s: BusSubscription): { text: string; color: string } {
  if (!s.active) return { text: '꺼짐', color: 'gray' }
  if (isStalled(s)) return { text: '멈춤', color: 'red' }
  if (s.pending) return { text: '처리 대기', color: 'amber' }
  return { text: '정상', color: 'green' }
}

async function retry(s: BusSubscription) {
  busy.value = s.name
  try {
    const r = await retrySubscription(s.name)
    if (r.failures > 0) toast('아직 멈춰 있습니다. 아래 오류를 확인하세요.', 'error')
    else toast(`이벤트 ${r.processed.toLocaleString('ko-KR')}건을 처리했습니다.`)
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = ''
    await refreshBus()
  }
}

async function skip(s: BusSubscription) {
  const answer = await ask({
    title: `이벤트 #${s.last_error_seq} 건너뛰기`,
    message: `${moduleLabel(s.module)} 모듈은 이 이벤트를 영영 받지 않고 다음으로 넘어갑니다. 건너뛴 사실과 사유는 원장에 남습니다.`,
    danger: true,
    reason: true,
    reasonRequired: true,
    confirmLabel: '건너뛰기',
  })
  if (!answer) return
  busy.value = s.name
  try {
    await skipSubscriptionEvent(s.name, answer.reason)
    toast(`이벤트 #${s.last_error_seq} 을 건너뛰었습니다.`)
  } catch (e) {
    toast(messageOf(e), 'error')
  } finally {
    busy.value = ''
    await refreshBus()
  }
}
</script>

<template>
  <div class="page" data-testid="bus">
    <div class="page-head">
      <h1>이벤트 버스<span v-if="bus.subs.length" class="page-count">구독 {{ bus.subs.length }}개</span></h1>
      <span class="muted small head-note">모듈은 원장의 이벤트로만 이어집니다. 하나가 멈춰도 나머지는 그대로 돌아갑니다.</span>
      <div class="grow"></div>
      <button v-if="admin" type="button" class="btn" :disabled="bus.loading" data-testid="bus-refresh" @click="refreshBus"><Icon name="refresh" :size="13" />새로 고침</button>
    </div>

    <div v-if="!admin" class="page-body">
      <EmptyState title="관리자만 볼 수 있습니다" text="이벤트 전달 상태와 재시도는 관리자가 다룹니다." />
    </div>
    <template v-else>
      <div v-if="bus.error" class="banner banner-error banner-flush" role="alert" data-testid="bus-error">
        <Icon name="alert" /><span class="grow">{{ bus.error }}</span>
        <button type="button" class="btn btn-sm" data-testid="bus-retry-load" @click="refreshBus">다시 시도</button>
      </div>
      <div class="page-body page-pad">
        <p v-if="bus.subs.length && !stalls.length" class="all-ok" data-testid="bus-all-ok"><Icon name="check" :size="13" />멈춘 구독이 없습니다.</p>
        <ul v-if="bus.subs.length" class="subs">
          <li v-for="s in bus.subs" :key="s.name" class="sub" :class="{ stuck: isStalled(s) }" data-testid="bus-sub" :data-name="s.name">
            <div class="sub-head">
              <strong class="ellipsis">{{ moduleLabel(s.module) }}</strong>
              <code class="muted ellipsis">{{ s.name }}</code>
              <span class="grow"></span>
              <span class="pill" :class="`pill-${statusOf(s).color}`" data-testid="bus-status">{{ statusOf(s).text }}</span>
            </div>
            <dl class="sub-facts small">
              <div><dt>처리</dt><dd data-testid="bus-processed">{{ s.processed.toLocaleString('ko-KR') }}건</dd></div>
              <div><dt>대기</dt><dd data-testid="bus-pending">{{ s.pending ? '있음' : '없음' }}</dd></div>
              <div><dt>마지막 실행</dt><dd>{{ s.last_run_at ? fmtDateTime(s.last_run_at) : '아직 없음' }}</dd></div>
            </dl>

            <div v-if="isStalled(s)" class="stall" data-testid="bus-stall">
              <p><strong>이벤트 #{{ s.last_error_seq }} 에서 멈췄습니다.</strong>{{ ' ' }}<template v-if="s.last_error_event">{{ eventLabel(s.last_error_event) }} <code>{{ s.last_error_event }}</code> · </template>실패 {{ s.failures }}회 · {{ fmtDateTime(s.last_error_at) }}</p>
              <pre class="stall-error" data-testid="bus-error-text">{{ s.last_error }}</pre>
              <div class="row-wrap">
                <button type="button" class="btn btn-primary btn-sm" :disabled="!!writeBlock || busy === s.name" :title="writeBlockMessage" data-testid="bus-retry" @click="retry(s)">재시도</button>
                <button type="button" class="btn btn-danger btn-sm" :disabled="!!writeBlock || busy === s.name" :title="writeBlockMessage" data-testid="bus-skip" @click="skip(s)">사유 남기고 건너뛰기</button>
              </div>
            </div>

            <details v-if="s.skipped.length" class="skipped small" data-testid="bus-skipped">
              <summary>건너뛴 이벤트 {{ s.skipped.length }}건</summary>
              <ul>
                <li v-for="k in s.skipped" :key="k.seq">#{{ k.seq }} {{ eventLabel(k.event) }} · {{ fmtDateTime(k.at) }} · 사유: {{ k.reason }}</li>
              </ul>
            </details>
          </li>
        </ul>
        <EmptyState v-else-if="bus.loaded && !bus.error" title="구독이 없습니다" text="모듈이 다른 모듈의 이벤트를 받겠다고 등록하면 여기에 나타납니다." />
      </div>
    </template>
  </div>
</template>

<style scoped>
.all-ok { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; color: var(--green-fg); }
.subs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-width: 900px; }
.sub { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
.sub.stuck { border-color: var(--red-line); }
.sub-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sub-head strong, .sub-head code { flex: 0 1 auto; }
.sub-head .pill { flex: none; }
.sub-facts { display: flex; flex-wrap: wrap; gap: 2px 20px; margin: 6px 0 0; }
.sub-facts > div { display: flex; gap: 6px; }
.sub-facts dt { color: var(--text-3); }
.sub-facts dd { margin: 0; }
.stall { margin-top: 8px; padding: 8px 10px; background: var(--red-bg); border: 1px solid var(--red-line); border-radius: var(--radius-sm); color: var(--red-fg); }
.stall code { color: inherit; }
.stall-error { margin: 6px 0 8px; padding: 6px 8px; background: var(--surface); border: 1px solid var(--red-line); border-radius: var(--radius-sm); color: var(--text); font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.skipped { margin-top: 8px; }
.skipped ul { margin: 4px 0 0; padding-left: 16px; color: var(--text-2); }
@media (max-width: 720px) {
  .head-note { display: none; }
}
</style>
