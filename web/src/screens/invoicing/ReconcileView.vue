<script setup lang="ts">
// Credits matched to open documents without looking at each. Both ways are the database's; a person only says how far.
import { computed, ref } from 'vue'
import { messageOf, rpc } from '../../lib/api'
import { nudgeBus } from '../../lib/commands'
import { writeBlock } from '../../lib/mode'
import { ask } from '../../lib/ui'
import Icon from '../../components/Icon.vue'
import RefSelect from '../../components/RefSelect.vue'

const partner = ref<string | null>(null)
const result = ref('')
const error = ref('')
const busy = ref(false)
const canRun = computed(() => !writeBlock.value)
const scope = computed(() => (partner.value ? '이 거래처' : '모든 거래처'))

async function run(mode: 'same_amount' | 'all') {
  const answer = await ask({
    title: mode === 'same_amount' ? '같은 금액끼리 맞추기' : '계정 정리',
    message: mode === 'same_amount'
      ? `${scope.value}의 미결 문서를 금액이 정확히 같은 입금·대변 메모와 짝짓습니다.`
      : `${scope.value}의 입금과 대변 메모를 오래된 문서부터 모두 씁니다. 남는 미결 항목이 가장 적어집니다.`,
    confirmLabel: '실행',
  })
  if (!answer) return
  busy.value = true
  error.value = ''
  result.value = ''
  try {
    const res = await rpc<{ matched: number }>('erp_auto_reconcile', { p_mode: mode, p_partner_id: partner.value })
    nudgeBus()
    result.value = res.matched ? `${res.matched}건을 맞췄습니다.` : '맞출 것이 없습니다.'
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page" data-testid="reconcile">
    <div class="page-head"><h1>자동 대사</h1></div>
    <div class="page-body report-pad">
      <div class="stack" style="max-width: 560px">
        <label class="field-stack"><span>거래처 (비우면 전체)</span><RefSelect v-model="partner" ref-type="partner" placeholder="모든 거래처" aria-label="거래처" /></label>
        <div class="row-wrap">
          <button type="button" class="btn btn-primary" :disabled="busy || !canRun" data-testid="reconcile-same" @click="run('same_amount')">같은 금액끼리 맞추기</button>
          <button type="button" class="btn" :disabled="busy || !canRun" data-testid="reconcile-all" @click="run('all')">계정 정리</button>
        </div>
        <div v-if="result" class="banner banner-ok" data-testid="reconcile-result"><Icon name="check" /><span>{{ result }}</span></div>
        <div v-if="error" class="banner banner-error" role="alert" data-testid="reconcile-error"><Icon name="alert" /><span>{{ error }}</span></div>
      </div>
    </div>
  </div>
</template>
