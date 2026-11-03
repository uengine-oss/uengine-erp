<script setup lang="ts">
// Who signed a quotation online, and what a customer added themselves.
import { computed } from 'vue'
import { fmtDateTime } from '../../lib/format'
import type { ErpRecord, State } from '../../lib/types'

const props = defineProps<{ record: ErpRecord | null }>()
const s = computed<State>(() => props.record?.state ?? {})
const signature = computed(() => (String(s.value.signature ?? '').startsWith('data:image/') ? String(s.value.signature) : ''))
const added = computed(() => (s.value.lines ?? []).filter((l: State) => l.from_portal).length)
</script>

<template>
  <section v-if="s.signed_by || added || s.declined_reason" class="form-note" data-testid="order-portal-record">
    <h2>고객이 한 일</h2>
    <p v-if="added" class="small" data-testid="order-portal-added">고객이 포털에서 담은 줄 {{ added }}개가 위 표에 초록색으로 표시됩니다.</p>
    <p v-if="s.declined_reason" class="small" data-testid="order-declined">거절 사유: {{ s.declined_reason }}</p>
    <p v-if="s.signed_by" class="small" data-testid="order-signed">{{ s.signed_by }} 님이 {{ fmtDateTime(s.signed_at) }} 에 서명했습니다.</p>
    <img v-if="signature" :src="signature" class="sign-img" alt="고객 서명" data-testid="order-signature" />
  </section>
</template>

<style scoped>
.form-note { margin-top: 14px; }
.form-note h2 { margin-bottom: 4px; font-size: 13px; }
.sign-img { display: block; max-width: 280px; max-height: 110px; margin-top: 6px; padding: 4px; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); }
</style>
