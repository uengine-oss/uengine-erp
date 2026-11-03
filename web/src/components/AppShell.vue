<script setup lang="ts">
import NetBanner from './NetBanner.vue'
import SideNav from './SideNav.vue'
import TopBar from './TopBar.vue'
import UpgradeBanner from './UpgradeBanner.vue'
</script>

<template>
  <div class="shell">
    <SideNav class="no-print" />
    <div class="shell-main">
      <TopBar class="no-print" />
      <UpgradeBanner />
      <NetBanner />
      <main class="shell-body"><router-view /></main>
    </div>
  </div>
</template>

<style>
.shell { display: flex; height: 100%; min-height: 0; }
.shell-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.shell-body { flex: 1 1 auto; min-height: 0; overflow: hidden; }
</style>
