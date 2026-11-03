<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue'
</script>

<template>
  <div class="page">
    <div class="page-head"><h1>분석</h1></div>
    <div class="page-body">
      <EmptyState title="아직 분석할 자료가 없습니다"
                  text="모든 변경이 이벤트로 남아 있으므로, 판매·재고·회계 모듈이 쌓이면 수요·재고·미수금의 흐름을 이 화면에서 볼 수 있습니다." />
    </div>
  </div>
</template>
