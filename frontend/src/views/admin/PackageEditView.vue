<template>
  <AdminLayout>
    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="loadError" class="error">加载失败: {{ loadError }}</div>
    <div v-else-if="pkg" class="package-edit-view">
      <header class="meta-head">
        <h2>{{ pkg.name }}</h2>
        <span class="version">v{{ pkg.version }}</span>
        <span class="tag" :class="`tag-${pkg.type}`">{{ pkg.type }}</span>
        <span class="tag" :class="pkg.enabled ? 'tag-on' : 'tag-off'">
          {{ pkg.enabled ? '已启用' : '已停用' }}
        </span>
      </header>

      <p v-if="pkg.manifest.description" class="desc">{{ pkg.manifest.description }}</p>

      <table class="meta-table">
        <tbody>
          <tr><th>类型</th><td>{{ pkg.type }}</td></tr>
          <tr><th>作者</th><td>{{ pkg.manifest.author || '-' }}</td></tr>
          <tr><th>License</th><td>{{ pkg.manifest.license || '-' }}</td></tr>
          <tr><th>来源</th><td>{{ pkg.source }}</td></tr>
          <tr><th>安装时间</th><td>{{ formatDate(pkg.installed_at) }}</td></tr>
        </tbody>
      </table>

      <section v-if="isV2" class="card">
        <h3>数据库</h3>
        <p>Schema: <code>{{ pkg.manifest.database.schemaName }}</code></p>
        <p>Migrations: <span>{{ pkg.manifest.database.migrations.length }}</span> 个文件</p>
        <button @click="showDdlPreview">查看 DDL</button>
        <span v-if="ddlPreviewMsg" class="msg">{{ ddlPreviewMsg }}</span>
      </section>

      <section class="card">
        <h3>Manifest 详情</h3>
        <pre class="json">{{ manifestJson }}</pre>
      </section>

      <section class="card">
        <h3>参数</h3>
        <p class="hint">
          参数以 JSON 文本编辑。v1 用 textarea 作为占位 — 后续会用 ajv 表单生成器替换。
        </p>
        <textarea v-model="paramsText" rows="6" spellcheck="false"></textarea>
        <div class="row-actions">
          <button class="save-btn" @click="saveParams" :disabled="savingParams">
            {{ savingParams ? '保存中...' : '保存参数' }}
          </button>
          <span v-if="paramsMsg" class="msg">{{ paramsMsg }}</span>
        </div>
      </section>

      <section class="card">
        <h3>最近运行</h3>
        <table class="t">
          <thead>
            <tr>
              <th>开始时间</th>
              <th>退出码</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in recentRuns" :key="r.id">
              <td>{{ formatDate(r.started_at) }}</td>
              <td>{{ r.exit_code }}</td>
              <td>{{ r.error || '-' }}</td>
            </tr>
            <tr v-if="!recentRuns.length">
              <td colspan="3" class="empty">暂无运行记录</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card danger-zone">
        <h3>危险操作</h3>
        <button class="danger" @click="requestUninstall" :disabled="uninstalling">
          {{ uninstalling ? '卸载中...' : '卸载' }}
        </button>
        <span v-if="uninstallMsg" class="msg">{{ uninstallMsg }}</span>
      </section>

      <PackageDdlPreviewModal
        :visible="ddlPreviewVisible"
        :schemaName="ddlPreview.schemaName"
        :files="ddlPreview.files"
        @close="ddlPreviewVisible = false"
      />

      <UninstallSchemaConfirmModal
        v-if="isV2"
        :visible="uninstallConfirmVisible"
        :packageName="pkg.name"
        :schemaName="pkg.manifest.database.schemaName"
        :metricRowCount="recentRuns.length"
        @confirm="onUninstallConfirm"
        @close="uninstallConfirmVisible = false"
      />
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import AdminLayout from '../../components/AdminLayout.vue';
import PackageDdlPreviewModal from '../../components/PackageDdlPreviewModal.vue';
import UninstallSchemaConfirmModal from '../../components/UninstallSchemaConfirmModal.vue';
import { usePackagesStore } from '../../stores/packages.js';
import { adminApi } from '../../api/admin.js';

const route = useRoute();
const router = useRouter();
const store = usePackagesStore();
const pkg = ref(null);
const recentRuns = ref([]);
const loading = ref(false);
const loadError = ref(null);
const paramsText = ref('');
const savingParams = ref(false);
const paramsMsg = ref('');

const ddlPreviewVisible = ref(false);
const ddlPreview = ref({ schemaName: null, files: [] });
const uninstallConfirmVisible = ref(false);
const uninstalling = ref(false);
const uninstallMsg = ref('');
const ddlPreviewMsg = ref('');

const isV2 = computed(() => !!pkg.value?.manifest?.database);

const manifestJson = computed(() => {
  if (!pkg.value?.manifest) return '';
  return JSON.stringify(pkg.value.manifest, null, 2);
});

onMounted(async () => {
  loading.value = true;
  loadError.value = null;
  try {
    const r = await axios.get(`/api/admin/packages/${encodeURIComponent(route.params.name)}`);
    pkg.value = r.data.package;
    recentRuns.value = Array.isArray(r.data.recentRuns) ? r.data.recentRuns : [];
    paramsText.value = JSON.stringify(r.data.package?.params ?? {}, null, 2);
  } catch (e) {
    loadError.value = e.response?.data?.error?.message || e.message;
  } finally {
    loading.value = false;
  }
});

async function saveParams() {
  paramsMsg.value = '';
  let parsed;
  try {
    parsed = JSON.parse(paramsText.value || '{}');
  } catch (e) {
    paramsMsg.value = `JSON 解析失败: ${e.message}`;
    return;
  }
  savingParams.value = true;
  try {
    await store.updateParams(pkg.value.name, parsed);
    paramsMsg.value = '已保存';
  } catch (e) {
    paramsMsg.value = e.response?.data?.error?.message || e.message;
  } finally {
    savingParams.value = false;
  }
}

async function showDdlPreview() {
  ddlPreviewMsg.value = '';
  try {
    ddlPreview.value = (await adminApi.getDdlPreview(pkg.value.name)).data;
    ddlPreviewVisible.value = true;
  } catch (e) {
    ddlPreviewMsg.value = e.response?.data?.error?.message || e.message;
  }
}

function requestUninstall() {
  uninstallMsg.value = '';
  if (isV2.value) {
    uninstallConfirmVisible.value = true;
  } else {
    doUninstall(false);
  }
}

async function onUninstallConfirm() {
  uninstallConfirmVisible.value = false;
  await doUninstall(true);
}

async function doUninstall(confirmDropSchema) {
  uninstalling.value = true;
  uninstallMsg.value = '';
  try {
    await adminApi.uninstallPackage(pkg.value.name, { purgeMetrics: true, confirmDropSchema });
    router.push('/admin/packages');
  } catch (e) {
    uninstallMsg.value = e.response?.data?.error?.message || e.message;
  } finally {
    uninstalling.value = false;
  }
}

function formatDate(s) {
  if (!s) return '-';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
  catch { return s; }
}
</script>

<style scoped>
.package-edit-view { display: flex; flex-direction: column; gap: 16px; }
.meta-head { display: flex; align-items: center; gap: 10px; }
.meta-head h2 { margin: 0; }
.version { color: var(--muted); }
.desc { color: var(--muted); margin: 0; }

.meta-table { width: 100%; border-collapse: collapse; background: var(--panel); }
.meta-table th, .meta-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.meta-table th { background: #0b1220; color: var(--muted); width: 100px; }

.card { background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; padding: 12px 16px; }
.card h3 { margin: 0 0 8px; font-size: 14px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
.json {
  background: #0b1220; padding: 10px; border-radius: 4px; overflow: auto;
  max-height: 360px; font-size: 12px; color: var(--text);
  margin: 0;
}
textarea {
  width: 100%; padding: 8px; background: #0b1220; color: var(--text);
  border: 1px solid #1e293b; border-radius: 3px; font-family: monospace;
  font-size: 12px; box-sizing: border-box;
}
.row-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.save-btn { padding: 5px 12px; }
.msg { font-size: 12px; color: var(--accent); }
.error { color: var(--red); }
.loading { color: var(--muted); }

.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 12px; }

.danger-zone { border-color: #5a2222; }
.danger-zone .danger { background: #5a2222; color: #fff; border: 1px solid #8a3333; padding: 5px 12px; border-radius: 3px; cursor: pointer; }
.danger-zone .danger:disabled { opacity: 0.6; cursor: not-allowed; }

code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px;
  background: #1e293b; color: var(--muted);
}
.tag-gauge { background: #0e3a2f; color: #67c23a; }
.tag-counter { background: #3a2f0e; color: #e6a23c; }
.tag-timeseries { background: #0e2a3a; color: #409eff; }
.tag-status { background: #2f1e3a; color: #909399; }
.tag-on { background: #0e3a2f; color: #67c23a; }
.tag-off { background: #1e293b; color: var(--muted); }
</style>
