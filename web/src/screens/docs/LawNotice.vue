<script setup lang="ts">
// What these screens owe the reader: the sums follow the Act as far as it was read, nobody qualified has checked them yet, and
// whether the Act applies at all is the company's call. It sits as a form panel and also inside the leave and attendance screens.
import { computed } from 'vue'
import type { CatalogDoc } from '../../lib/types'
import Icon from '../../components/Icon.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ doc?: CatalogDoc; kind?: 'leave' | 'attendance' }>()
const isAttendance = computed(() => props.kind === 'attendance' || props.doc?.type === 'attendance_policy')
</script>

<template>
  <div class="banner banner-warn notice small no-print" role="note" data-testid="law-notice">
    <Icon name="alert" />
    <div class="grow">
      <strong data-testid="law-unreviewed">전문가 검수 전입니다.</strong>
      근로기준법 조문을 대조해 만들었지만 노무사 등 전문가의 검수를 받지 않았습니다. 적용과 결과의 책임은 회사에 있습니다.
      <template v-if="isAttendance">상시 4명 이하 사업장에는 제50조와 제53조가 적용되지 않습니다(제11조, 시행령 제7조 별표 1). 근로자 수와 적용 여부는 회사가 판단해 근태 기준에서 끕니다.</template>
      <template v-else>상시 4명 이하 사업장에는 제60조와 제61조가 적용되지 않습니다(제11조, 시행령 제7조 별표 1). 근로자 수와 적용 여부는 회사가 판단해 연차 부여 정책에서 끕니다.</template>
    </div>
  </div>
</template>

<style scoped>
.notice { margin: 0 0 12px; max-width: 900px; }
</style>
