<template>
  <div class="admin-step">
    <h3>第 2 步：管理员账号</h3>
    <p class="hint">设置初始管理员账号。请使用强密码并妥善保管。</p>

    <div class="form-grid">
      <label class="full">用户名 <input v-model="username" /></label>
      <label class="full">密码 <input v-model="password" type="password" /></label>
      <label class="full">确认密码 <input v-model="confirm" type="password" /></label>
    </div>

    <p class="strength" :class="strengthLevel">密码强度：{{ strengthLabel }}</p>
    <p v-if="password && password !== confirm" class="err">两次输入的密码不一致</p>

    <div class="actions">
      <button type="button" @click="onPrev">上一步</button>
      <button type="button" :disabled="!canNext" @click="onNext">下一步</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useInitStore } from '../../stores/init.js';

const store = useInitStore();
const username = ref(store.admin.username);
const password = ref(store.admin.password);
const confirm = ref(store.admin.confirm);

watch([username, password, confirm], () => {
  store.setAdmin({ username: username.value, password: password.value, confirm: confirm.value });
});

const strengthScore = computed(() => {
  const p = password.value;
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p)) s++;
  if (/[0-9]/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
});
const strengthLevel = computed(() => ['weak','weak','weak','medium','medium','strong'][strengthScore.value]);
const strengthLabel = computed(() => ['-', '弱', '弱', '弱', '中', '中', '强'][strengthScore.value]);

const canNext = computed(() => {
  return username.value.length >= 3
    && password.value.length >= 8
    && password.value === confirm.value;
});

function onPrev() { store.prev(); }
function onNext() { store.next(); }
</script>

<style scoped>
.admin-step { display: flex; flex-direction: column; gap: 16px; }
.form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.form-grid label.full { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.actions { display: flex; gap: 8px; }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.strength { font-size: 12px; margin: 0; }
.strength.weak { color: var(--red); }
.strength.medium { color: var(--yellow); }
.strength.strong { color: var(--green); }
.err { color: var(--red); font-size: 13px; margin: 0; }
.hint { color: var(--muted); font-size: 13px; }
</style>
