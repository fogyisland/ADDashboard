<template>
  <div class="init-step">
    <h3>第 3 步：初始化</h3>
    <p class="hint">正在初始化数据库架构、种子数据和管理员账号...</p>

    <ul class="stages">
      <li v-for="stage in stages" :key="stage.key" :class="stage.status">
        <span class="icon">{{ iconFor(stage.status) }}</span>
        <span class="label">{{ stage.label }}</span>
        <span v-if="stage.error" class="err">{{ stage.error }}</span>
      </li>
    </ul>

    <div v-if="allDone" class="done">
      <p>✓ 初始化完成！</p>
      <button type="button" @click="goLogin">前往登录</button>
    </div>

    <div v-if="failed" class="failed">
      <p class="err">初始化失败：{{ errorMsg }}</p>
      <button type="button" @click="retry">重试</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { useInitStore } from '../../stores/init.js';

const store = useInitStore();
const router = useRouter();

const stages = reactive([
  { key: 'createDb',  label: '创建数据库',  status: 'pending', error: null },
  { key: 'schema',    label: '应用架构',    status: 'pending', error: null },
  { key: 'seed',      label: '种子数据',    status: 'pending', error: null },
  { key: 'migrations',label: '数据迁移',    status: 'pending', error: null },
  { key: 'admin',     label: '创建管理员',  status: 'pending', error: null },
  { key: 'config',    label: '写入配置',    status: 'pending', error: null }
]);

const allDone = computed(() => stages.every(s => s.status === 'done'));
const failed = computed(() => stages.some(s => s.status === 'failed'));
const errorMsg = computed(() => stages.find(s => s.status === 'failed')?.error || '');

function iconFor(status) {
  return { pending: '○', inProgress: '◌', done: '✓', failed: '✗' }[status] || '○';
}

function setStatus(key, status, error = null) {
  const s = stages.find(s => s.key === key);
  if (s) { s.status = status; s.error = error; }
}

async function runSequence() {
  for (const s of stages) { s.status = 'pending'; s.error = null; }
  try {
    if (store.dialect === 'mysql') {
      setStatus('createDb', 'inProgress');
      await store.applyDb(true);
      setStatus('createDb', 'done');
    }
    setStatus('schema', 'inProgress');
    setStatus('seed', 'inProgress');
    setStatus('migrations', 'inProgress');
    if (store.dialect !== 'mysql') await store.applyDb(false);
    setStatus('schema', 'done');
    setStatus('seed', 'done');
    setStatus('migrations', 'done');

    setStatus('admin', 'inProgress');
    await store.createAdmin();
    setStatus('admin', 'done');

    setStatus('config', 'inProgress');
    await store.finalize();
    setStatus('config', 'done');
  } catch (e) {
    const failedStage = stages.find(s => s.status === 'inProgress');
    if (failedStage) setStatus(failedStage.key, 'failed', e.response?.data?.error || e.message);
  }
}

function retry() { runSequence(); }
function goLogin() { router.push('/login'); }

onMounted(() => { runSequence(); });
</script>

<style scoped>
.init-step { display: flex; flex-direction: column; gap: 16px; }
.stages { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.stages li { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; }
.stages li.done { border-color: var(--green); color: var(--green); }
.stages li.inProgress { border-color: var(--accent); color: var(--accent); }
.stages li.failed { border-color: var(--red); color: var(--red); }
.icon { font-size: 16px; width: 20px; text-align: center; }
.label { flex: 1; }
.err { font-size: 12px; color: var(--red); }
.done, .failed { padding: 16px; border-radius: 4px; }
.done { background: var(--green-bg); }
.failed { background: var(--red-bg); }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
.hint { color: var(--muted); font-size: 13px; }
</style>
