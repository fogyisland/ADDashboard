<template>
  <!--
    R158.X.115 (2026-10-20) — 下线管理 (已退役 / 已暂停管控 主机总览)。

    为什么单独一个页面而不是塞进 MemberServersView / DcsCatalogView:
    操作员的真实问题是"我现在有哪些机器已经下线了", 而不是"DC 归在哪台机器
    类别下"。退役一台 DC 和退役一台 member server 对操作员来说是同一个动作,
    应该在同一个列表里看到。拆两页等于让操作员自己记住该去哪看。

    本页**只读 + 恢复入口**:
      · 已退役 = 终态, 不可恢复, 所以没有操作按钮 (只有状态展示)
      · 已暂停 = 临时态, 给"恢复管控"按钮
    下线/暂停的发起入口在各自的管理页 (MemberServersView / DcsCatalogView),
    那里有完整的退役前置提示弹窗。本页是"结果视图 + 恢复入口"。
  -->
  <AdminLayout>
    <h2>下线管理</h2>
    <p class="hint">
      已退役 (终态, 不可恢复) 与已暂停管控 (临时态, 可恢复) 的主机。
      这两类机器都已退出告警与在线视图, <b>历史数据全部保留</b>。
      退役的主机需要在其管理页才能查看保留的数据明细。
    </p>

    <div class="actions">
      <button class="refresh" @click="load">刷新</button>
    </div>

    <div class="filters">
      <label>
        状态
        <select v-model="status">
          <option value="all">全部 (退役 + 暂停)</option>
          <option value="decommissioned">仅已退役</option>
          <option value="paused">仅已暂停管控</option>
          <option value="active">仅在线</option>
        </select>
      </label>
      <label>
        类型
        <select v-model="kind">
          <option value="all">全部 (DC + 成员服务器)</option>
          <option value="dc">仅域控 (DC)</option>
          <option value="member">仅成员服务器</option>
        </select>
      </label>
    </div>

    <p v-if="loading" class="muted">加载中…</p>
    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="!loading && !error">
      <h3 class="section-title">域控 (DC) — {{ rows.filter(r => r.kind === 'dc').length }} 台</h3>
      <table class="t">
        <thead>
          <tr>
            <th>主机名</th>
            <th>站点</th>
            <th>IP 地址</th>
            <th>状态</th>
            <th>变更时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in dcRows" :key="'dc-' + r.host">
            <td><code>{{ r.host }}</code></td>
            <td>{{ r.siteName || '-' }}</td>
            <td>{{ r.ipAddress || '-' }}</td>
            <td>
              <span class="pill" :class="r.decommissionedAt ? 'retired' : 'paused'">
                {{ r.decommissionedAt ? '已退役' : '已暂停管控' }}
              </span>
            </td>
            <td><small>{{ fmt(r.decommissionedAt || r.monitoringPausedAt) }}</small></td>
            <td>
              <!-- 退役是终态: 不提供任何恢复入口, 只说明 -->
              <span v-if="r.decommissionedAt" class="muted small">终态, 不可恢复</span>
              <button v-else @click="openResume(r)">恢复管控</button>
            </td>
          </tr>
          <tr v-if="!dcRows.length">
            <td colspan="6" class="empty">无</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">成员服务器 — {{ memberRows.length }} 台</h3>
      <table class="t">
        <thead>
          <tr>
            <th>主机名</th>
            <th>站点</th>
            <th>IP 地址</th>
            <th>状态</th>
            <th>变更时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in memberRows" :key="'m-' + r.host">
            <td><code>{{ r.host }}</code></td>
            <td>{{ r.siteName || '-' }}</td>
            <td>{{ r.ipAddress || '-' }}</td>
            <td>
              <span class="pill" :class="r.decommissionedAt ? 'retired' : 'paused'">
                {{ r.decommissionedAt ? '已退役' : '已暂停管控' }}
              </span>
            </td>
            <td><small>{{ fmt(r.decommissionedAt || r.monitoringPausedAt) }}</small></td>
            <td>
              <span v-if="r.decommissionedAt" class="muted small">终态, 不可恢复</span>
              <button v-else @click="openResume(r)">恢复管控</button>
            </td>
          </tr>
          <tr v-if="!memberRows.length">
            <td colspan="6" class="empty">无</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 恢复管控复用同一个生命周期弹窗 (resume 模式, 不拉退役预览) -->
    <HostLifecycleDialog
      v-if="resumeTarget"
      :hostname="resumeTarget.host"
      action="resume"
      :server="{ monitoring_paused_at: resumeTarget.monitoringPausedAt }"
      @close="resumeTarget = null"
      @done="onResumeDone"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import HostLifecycleDialog from '../../components/HostLifecycleDialog.vue';
import { adminApi } from '../../api/admin.js';
import { formatDateTime } from '../../lib/timezone.js';

const status = ref('all');
const kind = ref('all');
const loading = ref(false);
const error = ref('');
const rows = ref([]);
const resumeTarget = ref(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await adminApi.listServerLifecycle({ status: status.value, kind: kind.value });
    rows.value = [...(r.data?.dcs || []), ...(r.data?.members || [])];
  } catch (e) {
    error.value = '加载失败: ' + (e?.response?.data?.error || e?.message || '未知错误');
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

// 任一筛选变化即重拉。watch 而非 @change —— 两个下拉都改, 手写 2 个 @change
// 容易漏, 而且初次挂载与后续变化的加载路径保持一致。
watch([status, kind], load);
onMounted(load);

const dcRows = computed(() => rows.value.filter(r => r.kind === 'dc'));
const memberRows = computed(() => rows.value.filter(r => r.kind === 'member'));

function openResume(r) {
  resumeTarget.value = r;
}

async function onResumeDone() {
  await load();
}

function fmt(s) {
  if (!s) return '-';
  return formatDateTime(s, { fallback: '-' });
}
</script>

<style scoped>
.hint { color: var(--muted); font-size: 13px; max-width: 860px; line-height: 1.6; }
.filters { display: flex; gap: 16px; align-items: center; margin: 12px 0; font-size: 13px; color: var(--muted); }
.filters label { display: flex; align-items: center; gap: 6px; }
.section-title { font-size: 14px; margin: 20px 0 8px; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid; white-space: nowrap; }
.pill.retired { color: #6b7280; border-color: #6b7280; background: #f3f4f6; }
.pill.paused { color: #b45309; border-color: #b45309; background: #fffbeb; }
.error { color: #b91c1c; font-size: 13px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 14px; }
</style>