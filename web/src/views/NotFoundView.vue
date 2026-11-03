<script setup lang="ts">
import EmptyState from '../components/EmptyState.vue'
</script>

<template>
  <div class="page">
    <div class="page-body">
      <EmptyState title="없는 화면입니다" text="주소가 바뀌었거나 아직 설치되지 않은 모듈일 수 있습니다.">
        <router-link class="btn" to="/">홈으로</router-link>
      </EmptyState>
    </div>
  </div>
</template>
