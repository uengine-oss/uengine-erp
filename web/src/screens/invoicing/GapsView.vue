<script setup lang="ts">
// Numbers must run without holes for a tax audit, so this shows anything an auditor would ask about.
import { computed, onMounted } from 'vue'
import { rpc } from '../../lib/api'
import { useLoad } from '../../lib/load'
import EmptyState from '../../components/EmptyState.vue'
import Icon from '../../components/Icon.vue'
import LoadError from '../../components/LoadError.vue'

interface Gaps { cancelled: { id: string; number: string }[]; missing: string[] }
const { data, loading, error, load } = useLoad(() => rpc<Gaps>('erp_invoice_number_gaps'))
onMounted(load)
const clean = computed(() => !!data.value && !data.value.cancelled.length && !data.value.missing.length)
</script>

<template>
  <div class="page" data-testid="number-gaps">
    <div class="page-head"><h1>번호 점검</h1></div>
    <LoadError :message="error" @retry="load" />
    <div class="page-body report-pad">
      <div v-if="clean" class="banner banner-ok" data-testid="gaps-clean"><Icon name="check" /><span>빠진 번호도 취소된 번호도 없습니다.</span></div>
      <template v-else-if="data">
        <section class="report-section">
          <h2>빠진 번호 {{ data.missing.length }}건</h2>
          <p v-if="!data.missing.length" class="muted small">없습니다.</p>
          <div class="chip-row"><span v-for="n in data.missing" :key="n" class="tag" data-testid="gap-missing">{{ n }}</span></div>
        </section>
        <section class="report-section">
          <h2>취소된 문서 {{ data.cancelled.length }}건</h2>
          <p v-if="!data.cancelled.length" class="muted small">없습니다.</p>
          <div class="chip-row"><router-link v-for="c in data.cancelled" :key="c.id" class="tag" :to="{ name: 'record', params: { type: 'account_move', id: c.id } }" data-testid="gap-cancelled">{{ c.number }}</router-link></div>
        </section>
      </template>
      <EmptyState v-else-if="!loading && !error" title="읽지 못했습니다" />
    </div>
  </div>
</template>
