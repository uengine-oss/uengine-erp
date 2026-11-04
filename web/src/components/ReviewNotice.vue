<script setup lang="ts">
// Korean-format books and depreciation rest on law and standards we read, not on an accountant's sign-off. The screen says so.
withDefaults(defineProps<{ text?: string }>(), { text: '법령과 회계 기준을 확인해 만들었지만 회계·세무 전문가의 검수 전입니다. 신고와 공시의 책임은 회사에 있습니다.' })
</script>

<template>
  <div class="banner banner-flush review-notice" data-testid="review-notice"><strong class="nowrap">전문가 검수 전</strong><span class="grow">{{ text }}</span></div>
</template>

<style scoped>
.review-notice { background: var(--amber-bg); color: var(--amber-fg); border-bottom: 1px solid var(--amber-line); }
</style>
