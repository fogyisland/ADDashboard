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

    <div v-if="restarting" class="restarting">
      <p>初始化完成，服务正在重启，请稍候…</p>
      <p class="hint">（通常需要几秒钟）</p>
    </div>

    <div v-if="timedOut" class="failed">
      <p class="err">服务重启超时。请尝试手动重启：</p>
      <button type="button" @click="runStartBat">运行 start.bat</button>
      <p class="hint">或在管理员命令行执行：nssm restart ADDashboardCenter</p>
    </div>

    <div v-if="failed && !timedOut" class="failed">
      <p class="err">初始化失败：{{ errorMsg }}</p>
      <button type="button" @click="retry">重试</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useInitStore } from '../../stores/init.js';
import * as initApi from '../../api/init.js';

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

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

const failed = computed(() => stages.some(s => s.status === 'failed'));
const errorMsg = computed(() => stages.find(s => s.status === 'failed')?.error || '');

const restarting = ref(false);
const timedOut = ref(false);

let pollTimer = null;
let pollDeadline = 0;

function iconFor(status) {
  return { pending: '○', inProgress: '◌', done: '✓', failed: '✗' }[status] || '○';
}

function setStatus(key, status, error = null) {
  const s = stages.find(s => s.key === key);
  if (s) { s.status = status; s.error = error; }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStatusTick() {
  // 30s wall-clock deadline check (Date.now — fake timers don't tick this).
  if (Date.now() >= pollDeadline) {
    stopPolling();
    timedOut.value = true;
    return;
  }
  try {
    const r = await initApi.getStatus();
    if (r && r.data && r.data.needsInit === false) {
      stopPolling();
      router.push('/login');
    }
  } catch {
    // Transient network error during restart — keep polling until deadline.
  }
}

function startPolling() {
  stopPolling();
  restarting.value = true;
  pollDeadline = Date.now() + POLL_TIMEOUT_MS;
  pollTimer = setInterval(pollStatusTick, POLL_INTERVAL_MS);
  // Fire one immediate check so a fast restart short-circuits without waiting 1s.
  pollStatusTick();
}

async function runSequence() {
  timedOut.value = false;
  restarting.value = false;
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

    // After finalize 200, the backend will process.exit(0) and NSSM restarts.
    // Poll /api/init/status until the new instance reports needsInit=false,
    // then redirect to /login. If the restart takes longer than 30s,
    // surface a manual-restart hint.
    startPolling();
  } catch (e) {
    stopPolling();
    const failedStage = stages.find(s => s.status === 'inProgress');
    if (failedStage) setStatus(failedStage.key, 'failed', e.response?.data?.error || e.message);
  }
}

function retry() { runSequence(); }

function runStartBat() {
  // Browser context — open a manual instruction. We can't shell out from the
  // page, but the message tells the user exactly what to do.
  window.alert('请在 AD Dashboard 安装目录中以管理员身份运行 start.bat，或执行：\nnssm restart ADDashboardCenter');
}

onMounted(() => { runSequence(); });
onBeforeUnmount(stopPolling);
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
.done, .failed, .restarting { padding: 16px; border-radius: 4px; }
.done { background: var(--green-bg); }
.failed { background: var(--red-bg); }
.restarting { background: var(--accent-bg); color: var(--accent); }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
.hint { color: var(--muted); font-size: 13px; }
</style>
