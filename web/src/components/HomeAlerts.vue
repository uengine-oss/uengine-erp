<script setup lang="ts">
// What someone should look at today. Each line comes from the database's own answer; a module that is off asks nothing.
import { computed, onMounted, ref } from 'vue'
import { rpc } from '../lib/api'
import { catalogOf, hasRole } from '../lib/session'

const gaps = ref(0)
const taxDue = ref<{ from: string; to: string; due: string; state: string }[]>([])
const canSeeBooks = computed(() => !!catalogOf('account_move') && hasRole(['accounting']))

onMounted(async () => {
  if (!canSeeBooks.value) return
  try {
    const g = await rpc<{ cancelled: unknown[]; missing: unknown[] }>('erp_invoice_number_gaps')
    gaps.value = g.cancelled.length + g.missing.length
    const t = await rpc<{ periods: { from: string; to: string; due: string; state: string }[] }>('erp_tax_periods')
    taxDue.value = t.periods.filter((p) => ['overdue', 'due_soon'].includes(p.state))
  } catch { /* the home page still has the rest to show */ }
})
</script>

<template>
  <section v-if="gaps || taxDue.length" class="home-panel" data-testid="home-alerts">
    <div class="home-panel-head"><h2>확인할 일</h2></div>
    <ul class="home-links">
      <li v-if="gaps"><router-link to="/invoicing/gaps" data-testid="home-gaps">청구서 번호 공백·취소 {{ gaps }}건</router-link></li>
      <li v-for="p in taxDue" :key="p.from"><router-link to="/invoicing/tax" data-testid="home-tax">세금 신고 {{ p.from }} ~ {{ p.to }} · 기한 {{ p.due }}</router-link></li>
    </ul>
  </section>
</template>

<style scoped>
.home-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.home-panel-head { display: flex; align-items: center; height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.home-panel-head h2 { font-size: 13px; }
.home-links { list-style: none; margin: 0; padding: 4px 0; }
.home-links a { display: block; padding: 5px 12px; color: var(--ink-800); }
.home-links a:hover { background: var(--navy-50); text-decoration: none; }
</style>
