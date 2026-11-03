<script setup lang="ts">
// A document ready for the browser's print dialog, which also saves it as a PDF.
import { computed, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { messageOf, toApiError } from '../../lib/api'
import { db } from '../../lib/conn'
import { catalogOf } from '../../lib/session'
import type { ErpRecord } from '../../lib/types'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import DocSheet, { type DocExtras } from './DocSheet.vue'
import { docExtras } from './render'
import '../../styles/doc.css'

const props = defineProps<{ type: string; id: string }>()
const router = useRouter()
const record = shallowRef<ErpRecord | null>(null)
const extras = shallowRef<DocExtras | null>(null)
const error = ref('')
const loading = ref(true)
const showInstallments = ref(true)
const showSignature = ref(true)
const PRINTABLE = ['sales_order', 'purchase_order', 'picking', 'account_move']
const label = computed(() => catalogOf(props.type)?.label ?? '문서')

watch(() => [props.type, props.id], async () => {
  loading.value = true
  error.value = ''
  record.value = null
  try {
    if (!PRINTABLE.includes(props.type)) return
    const res = await db().from('erp_records').select('*').eq('id', props.id).eq('type', props.type).maybeSingle()
    if (res.error) throw toApiError(res.error, res.status)
    if (!res.data) return
    extras.value = await docExtras(res.data as ErpRecord)
    record.value = res.data as ErpRecord
    document.title = `${record.value.name ?? label.value} · uEngine ERP`
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    loading.value = false
  }
}, { immediate: true })
const hasInstallments = computed(() => Array.isArray(record.value?.state.installments) && record.value!.state.installments.length > 0)
const printPage = () => window.print()
</script>

<template>
  <div class="page print-page" data-testid="print-view">
    <div class="page-head no-print">
      <button type="button" class="btn btn-ghost" data-testid="print-back" @click="router.push({ name: 'record', params: { type, id } })"><Icon name="chevron-left" :size="13" />{{ label }}</button>
      <div class="grow"></div>
      <label v-if="hasInstallments" class="check small dim"><input v-model="showInstallments" type="checkbox" data-testid="print-installments" />회차별 금액 표시</label>
      <label v-if="record?.state.signed_by" class="check small dim"><input v-model="showSignature" type="checkbox" data-testid="print-signature" />서명 표시</label>
      <button type="button" class="btn btn-primary" :disabled="!record" data-testid="print-go" @click="printPage"><Icon name="printer" :size="13" />인쇄 / PDF 저장</button>
    </div>
    <div v-if="error" class="banner banner-error banner-flush no-print" role="alert" data-testid="print-error"><Icon name="alert" /><span>{{ error }}</span></div>
    <div class="page-body print-body">
      <div v-if="record && extras" class="print-paper"><DocSheet :record="record" :extras="extras" :show-installments="showInstallments" :show-signature="showSignature" /></div>
      <EmptyState v-else-if="!loading && !error" title="출력할 수 없는 문서입니다" text="없어졌거나, 이 문서를 볼 권한이 없습니다." />
    </div>
  </div>
</template>

<style scoped>
.print-body { padding: 16px; }
.print-paper { max-width: 820px; margin: 0 auto; padding: 28px 32px; background: #fff; border: 1px solid var(--line); box-shadow: var(--shadow-pop); }
@media (max-width: 720px) { .print-body { padding: 8px; } .print-paper { padding: 12px; overflow-x: auto; } }
@media print { .print-body { padding: 0; } .print-paper { max-width: none; padding: 0; border: 0; box-shadow: none; } }
</style>
