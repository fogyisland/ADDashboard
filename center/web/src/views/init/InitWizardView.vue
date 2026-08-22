<template>
  <div class="init-wizard">
    <header>
      <h2>AD Replication Dashboard — 初始化向导</h2>
      <ol class="stepper">
        <li :class="{ active: store.currentStep === 1, done: store.currentStep > 1 }">1. 数据库连接</li>
        <li :class="{ active: store.currentStep === 2, done: store.currentStep > 2 }">2. 管理员账号</li>
        <li :class="{ active: store.currentStep === 3 }">3. 初始化</li>
      </ol>
    </header>
    <main>
      <DbConnStep v-if="store.currentStep === 1" />
      <AdminStep v-else-if="store.currentStep === 2" />
      <InitStep v-else-if="store.currentStep === 3" />
    </main>
  </div>
</template>

<script setup>
import { useInitStore } from '../../stores/init.js';
import DbConnStep from './DbConnStep.vue';
import AdminStep from './AdminStep.vue';
import InitStep from './InitStep.vue';
const store = useInitStore();
</script>

<style scoped>
.init-wizard { max-width: 720px; margin: 32px auto; padding: 24px; background: var(--panel); border-radius: 8px; }
header h2 { margin: 0 0 16px; color: var(--accent); font-size: 18px; }
.stepper { display: flex; gap: 16px; padding: 0; margin: 0 0 24px; list-style: none; }
.stepper li { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; color: var(--muted); }
.stepper li.active { border-color: var(--accent); color: var(--accent); }
.stepper li.done { border-color: var(--green); color: var(--green); }
</style>