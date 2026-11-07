<template>
  <div class="db-conn-step">
    <h3>第 1 步：数据库连接</h3>

    <div class="installer-token-box">
      <label class="token-label" for="installer-token-input">安装令牌</label>
      <input
        id="installer-token-input"
        v-model="tokenLocal"
        name="installer-token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="服务器 .installer-token 文件内容…"
      />
      <p class="hint">
        为防止初始化被内网他人抢先接管，向导需要安装令牌认证。请在服务器上打开
        安装目录下的 <code>.installer-token</code> 文件，把其中的内容粘贴到这里。
      </p>
      <p v-if="tokenMissing" class="err">请先粘贴安装令牌，否则后续步骤会被拒绝（401）。</p>
    </div>

    <p class="hint">选择数据库类型并填写连接信息。建议先点击"测试连接"验证。</p>

    <div class="dialect-picker">
      <label class="dialect-card" :class="{ active: store.dialect === 'mysql' }">
        <input type="radio" name="dialect" value="mysql" v-model="dialectLocal" />
        <div class="card-title">MySQL 5.7+</div>
        <div class="card-desc">默认端口 3306</div>
      </label>
      <label class="dialect-card" :class="{ active: store.dialect === 'mssql' }">
        <input type="radio" name="dialect" value="mssql" v-model="dialectLocal" />
        <div class="card-title">SQL Server 2014+</div>
        <div class="card-desc">默认端口 1433</div>
      </label>
    </div>

    <div v-if="store.dialect === 'mysql'" class="form-grid">
      <label>主机 <input v-model="conn.host" placeholder="127.0.0.1" /></label>
      <label>端口 <input v-model.number="conn.port" type="number" /></label>
      <label>数据库 <input v-model="conn.database" /></label>
      <label>用户 <input v-model="conn.user" /></label>
      <label class="full">密码 <input v-model="conn.password" type="password" /></label>
    </div>

    <div v-else-if="store.dialect === 'mssql'" class="form-grid">
      <label class="full">服务器 <input v-model="conn.server" placeholder="host\instance 或 host,port" /></label>
      <label>端口 <input v-model.number="conn.port" type="number" /></label>
      <label>数据库 <input v-model="conn.database" /></label>
      <label>用户 <input v-model="conn.user" /></label>
      <label class="full">密码 <input v-model="conn.password" type="password" /></label>
      <label class="full checkbox">
        <input type="checkbox" v-model="conn.encrypt" /> 启用加密
        <input type="checkbox" v-model="conn.trustServerCert" /> 信任服务器证书
      </label>
    </div>

    <div class="actions">
      <button type="button" :disabled="!canTest || testing" @click="onTest">
        {{ testing ? '测试中…' : '测试连接' }}
      </button>
      <button type="button" :disabled="!store.dbTestResult?.ok" @click="onNext">下一步</button>
    </div>

    <p v-if="store.dbTestResult?.ok" class="ok">✓ 连接成功</p>
    <p v-if="store.dbTestResult?.error" class="err">{{ store.dbTestResult.error }}</p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useInitStore } from '../../stores/init.js';
import { getInstallerToken, setInstallerToken } from '../../api/init.js';

const store = useInitStore();
const testing = ref(false);
const dialectLocal = ref(store.dialect);
const conn = ref({ ...store.connParams });
const tokenLocal = ref(getInstallerToken());
const tokenMissing = ref(false);

onMounted(() => {
  // token 为空时不阻塞输入, 但标红提醒 (测试连接会被 401 拒)。
  tokenMissing.value = !getInstallerToken();
});

watch(tokenLocal, (v) => {
  setInstallerToken(v);
  tokenMissing.value = !getInstallerToken();
});

watch(dialectLocal, (v) => {
  if (v && v !== store.dialect) {
    store.setDialect(v);
    conn.value = { ...store.connParams };
  }
});
watch(conn, (v) => { store.setConnParams(v); }, { deep: true });

const canTest = computed(() => {
  if (!store.dialect) return false;
  if (!conn.value.database) return false;
  if (store.dialect === 'mysql' && !conn.value.host) return false;
  if (store.dialect === 'mssql' && !conn.value.server) return false;
  return true;
});

async function onTest() {
  testing.value = true;
  try { await store.testDb(); }
  finally { testing.value = false; }
}

function onNext() { store.next(); }
</script>

<style scoped>
.db-conn-step { display: flex; flex-direction: column; gap: 16px; }
.installer-token-box { padding: 12px; border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; gap: 8px; }
.token-label { font-size: 13px; font-weight: 600; }
.installer-token-box input { padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--fg); font-family: monospace; }
.installer-token-box .hint code { font-family: monospace; background: var(--accent-bg); padding: 1px 4px; border-radius: 3px; }
.dialect-picker { display: flex; gap: 12px; }
.dialect-card { flex: 1; padding: 16px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.dialect-card.active { border-color: var(--accent); background: var(--accent-bg); }
.dialect-card input { margin-right: 6px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.form-grid label.full { grid-column: 1 / -1; }
.form-grid label.checkbox { flex-direction: row; gap: 12px; }
.actions { display: flex; gap: 8px; }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.ok { color: var(--green); }
.err { color: var(--red); }
.hint { color: var(--muted); font-size: 13px; }
</style>
