<!--
  R158.44 (2026-10-04) — AD 信息同步页重设计.

  operator 原话: 「AD 信息同步界面需要重新设计, 我们在这里需要同步两个域,
  所以需要调用域和森林注册的信息同步执行同步, 同步的内容OU树的具体内容」.

  新结构 (top-down):
    1. 页面 header  — 左 h2 + summary; 右 compact status chip + 「⚙ LDAP 配置」router-link.
    2. 矩阵卡片   — 一个 forest 一个子表, 行 = domain. 行内 caret 翻转展开 SnapshotTreePanel.
    3. 全局 toast  — 同步结果消息.
    4. 历史 runs 表 — 最近 20 条 sync run, 每 30s 自动刷新.

  移除 (R158.44):
    - 状态卡 (status): 数据下沉到矩阵行「上次同步」chip + 顶部「最近同步 N 小时前」chip.
    - LDAP 配置表单 (config): 彻底外移至 ForestRegistryView (ad_forest.ad_url/bind_dn/bind_password
      已在 ForestRegistry 维护, baseDn 走 forest setting KV, intervalMinutes 走 system_config 全局).
    - 域多选卡 (domains): 矩阵行内每行一个 [Sync now] 按钮, 单击触发单域.

  复用:
    - SnapshotTreePanel.vue (行内展开组件, 见 R158.44 step 1).
    - OuTreeNode.vue + utils/ouTreeBuilder.js (透过 SnapshotTreePanel).
    - adminApi.getDirectorySyncForestSummary / getDirectorySyncDomainBinding /
      getDirectorySyncSnapshot / triggerDirectorySync / listDirectorySyncRuns.

  边界:
    - expandedDomainId 单值 (单选, 一次只展一个 panel, 避免 N 个 snapshot 并发请求).
    - bindingByDomain / syncingDomainIds 等 Map/Set 通过 new Map(new Set()) 重写触发响应 (Vue 3 ref 陷阱).
    - sync_enabled=0 域仍允许手动 [Sync now] (R158.39 策略保留).
-->
<template>
  <AdminLayout>
    <header class="page-head">
      <div class="head-left">
        <h2>AD 信息同步</h2>
        <p class="page-summary">
          通过 LDAP (389 / 636) 同步活动目录账户、组与组织架构到本地, 供日常管理面板读取。
          LDAP 连接、Base DN、绑定密码等请到
          <router-link to="/admin/forest-registry" class="inline-link">⚙ 域和森林注册</router-link>
          配置 (本页面仅展示同步链路与同步结果)。
        </p>
      </div>
      <div class="head-right">
        <!-- 全局 compact status chip -->
        <span v-if="latestRun" class="chip chip-ok" data-test="global-latest-chip">
          最近同步 {{ fmtRelative(latestRun.finishedAt) }}
          <small class="chip-meta">({{ latestRun.userCount ?? 0 }}U / {{ latestRun.groupCount ?? 0 }}G / {{ latestRun.ouCount ?? 0 }}OU)</small>
        </span>
        <span v-else class="chip chip-neutral">从未同步</span>
        <!-- LDAP 配置外链路由 -->
        <router-link to="/admin/forest-registry" class="ldap-link">
          ⚙ LDAP 配置
        </router-link>
      </div>
    </header>

    <!-- ============== R158.45.34 — 同步周期设置 ============== -->
    <!-- operator "在 /admin/directory-sync 这里定义同步周期":
         intervalMinutes 来自 system_config.ad_sync_interval_minutes, 后端 cron tick
         每次读这个 key 决定下一次多久跑. 改完下次 tick 即生效. 范围 1-1440
         分钟整数, 默认 60.
         R158.46.1 (2026-10-06) — operator 改单位 小时→分钟. -->
    <section class="card interval-card" data-test="interval-card">
      <header class="interval-head">
        <h3>⏱ 同步周期</h3>
        <span class="muted small">
          改完即时生效，下次定时任务用新间隔. 范围 1-1440 分钟整数 (例如 60 = 1 小时).
        </span>
      </header>
      <div class="interval-row">
        <label class="interval-label">
          <span>间隔 (分钟)</span>
          <input
            v-model.number="intervalMinutesInput"
            type="number"
            min="1"
            max="1440"
            step="1"
            data-test="interval-minutes-input"
            :disabled="intervalLoading || intervalSaving"
          />
        </label>
        <button
          class="primary-btn"
          data-test="interval-minutes-save"
          :disabled="!intervalMinutesDirty || intervalSaving || !intervalMinutesValid"
          @click="onSaveIntervalMinutes"
        >
          {{ intervalSaving ? '保存中…' : '保存' }}
        </button>
        <span v-if="intervalMinutesSaved" class="ok small">✓ 已保存</span>
        <span v-if="!intervalMinutesValid" class="err small">必须是 1-1440 整数</span>
        <span class="muted small">
          下次预计: <strong>{{ nextRunEstimateText }}</strong>
        </span>
      </div>
    </section>

    <!-- ============== R158.44.1 orphan DC 警告 + 一键清理 ============== -->
    <section v-if="orphanDcs.length > 0" class="card orphan-card" data-test="orphan-banner">
      <header class="orphan-head">
        <h3>⚠ DC 域归属数据异常 ({{ orphanDcs.length }} 台)</h3>
        <div class="orphan-actions">
          <button class="link-btn" @click="reloadOrphanDcs" :disabled="orphanLoading">
            {{ orphanLoading ? '刷新中…' : '↻ 重新扫描' }}
          </button>
          <button class="danger-btn" @click="onUnbindAllOrphans" :disabled="orphanUnbinding">
            {{ orphanUnbinding ? '清理中…' : '一键清空全部孤儿归属' }}
          </button>
        </div>
      </header>
      <p class="orphan-desc">
        以下 DC 的 <code>forest_domain_id</code> 引用了不存在的 <code>ad_forest_domain</code> 行 (历史遗留数据).
        不会自动同步; 也无法在域和森林注册页面绑定到任何域. 一键清理后, DC 状态变为「未绑定」, 可到 <router-link to="/admin/dcs-catalog">DC 总览</router-link> 重新指派.
      </p>
      <div class="orphan-list">
        <span v-for="o in orphanDcs" :key="o.dcName" class="orphan-chip">
          <strong>{{ o.dcName }}</strong>
          <small class="muted">→ forest_domain_id={{ o.orphanDomainId }} (不存在)</small>
        </span>
      </div>
    </section>

    <!-- ============== 矩阵 ============== -->
    <section class="card matrix-card" data-test="matrix-card">
      <header class="matrix-head">
        <h3>森林 × 域 同步矩阵</h3>
        <div class="matrix-actions">
          <button @click="reloadMatrix" :disabled="matrixLoading">
            {{ matrixLoading ? '刷新中…' : '↻ 刷新' }}
          </button>
        </div>
      </header>

      <div v-if="matrixLoading && !forestSummary" class="empty-hint">加载中…</div>
      <div v-else-if="matrixError" class="empty-hint error">{{ matrixError }}</div>
      <div v-else-if="!forestSummary || !forestSummary.forests || forestSummary.forests.length === 0" class="empty-hint">
        还没有注册任何森林. 去
        <router-link to="/admin/forest-registry" class="inline-link">域和森林注册</router-link>
        新建.
      </div>

      <!-- 一个森林一张子表 (forestSummary 已由上面守卫确认非空) -->
      <template v-else>
      <div v-for="forest in forestSummary.forests" :key="forest.id"
           class="forest-block" data-test="forest-block">
        <h4 class="forest-title">
          <span class="forest-icon">🌲</span>
          <span>{{ forest.forestName }}</span>
          <span class="forest-dn muted">{{ forest.rootDn }}</span>
          <span v-if="forest.isDefault" class="pill ok small">默认</span>
        </h4>
        <table class="matrix-table">
          <thead>
            <tr>
              <th class="col-name">域名</th>
              <th class="col-auto">自动同步</th>
              <th class="col-dc">DC</th>
              <th class="col-last">上次同步</th>
              <th class="col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="d in forest.domains" :key="d.id">
              <tr :class="['matrix-row',
                           { expanded: expandedDomainId === d.id,
                             syncing: syncingDomainIds.has(d.id),
                             failed: d.lastRun?.status === 'failed' }]"
                  :data-test="`matrix-row-${d.id}`"
                  @click="onRowClick(d, $event)">
                <td class="col-name">
                  <span class="caret" @click.stop="toggleExpand(d.id)">
                    {{ expandedDomainId === d.id ? '▾' : '▸' }}
                  </span>
                  <span class="d-name">{{ d.domainName }}</span>
                  <span class="d-dn muted">{{ d.domainDn }}</span>
                  <span v-if="d.role === 'root'" class="pill ok small">根域</span>
                </td>
                <td class="col-auto">
                  <span :class="['chip', d.syncEnabled ? 'chip-ok' : 'chip-warn']">
                    {{ d.syncEnabled ? '启用' : '禁用' }}
                  </span>
                </td>
                <td class="col-dc">
                  <span v-if="dcCountByDomain.has(d.id)"
                        class="dc-count" :title="dcStatusTooltip(d.id)">
                    {{ dcCountByDomain.get(d.id) }}
                    <small class="muted">台</small>
                  </span>
                  <span v-else-if="bindingLoadingDomainIds.has(d.id)"
                        class="muted small">加载…</span>
                  <span v-else-if="dcErrorByDomain.has(d.id)"
                        class="chip chip-err" :title="dcErrorByDomain.get(d.id)">?</span>
                  <span v-else class="muted small">…</span>
                </td>
                <td class="col-last">
                  <component :is="lastRunPill(d.lastRun)" />
                </td>
                <td class="col-action">
                  <!-- R158.5.4 (2026-10-04) — operator: 「上次没有同步完成, 同步按钮就不可用」.
                       既看前端 in-flight (syncingDomainIds), 也看 backend run 状态 (lastRun.status==='running')
                       避免 polling 完成但 backend 仍卡 (preflight 漏 throw / finalize 漏跑) 时误触. -->
                  <button class="sync-btn"
                          :disabled="isSyncLocked(d)"
                          :title="syncBtnTitle(d)"
                          @click.stop="onSyncOne(d)">
                    {{ syncBtnLabel(d) }}
                  </button>
                </td>
              </tr>
              <!-- 行内展开面板 (单选 — expandedDomainId 单值) -->
              <tr v-if="expandedDomainId === d.id" class="expand-row"
                  :data-test="`expand-row-${d.id}`">
                <td colspan="5">
                  <SnapshotTreePanel
                    :domain="d"
                    :binding="bindingByDomain.get(d.id)"
                    :binding-loading="bindingLoadingDomainIds.has(d.id)"
                    :default-dc="defaultDcByDomain.get(d.id) || ''"
                    @select-dc="onSelectDc(d.id, $event)"
                    @open-setting="goToForestRegistry"
                  />
                </td>
              </tr>
            </template>
            <tr v-if="forest.domains.length === 0">
              <td colspan="5" class="empty-hint">
                该森林暂无域. 去
                <router-link to="/admin/forest-registry" class="inline-link">域和森林注册</router-link>
                新建子域.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </template>
    </section>

    <!-- ============== 实时同步日志 (R158.44.1 — operator 「增加同步日志信息」) ============== -->
    <section class="card log-card" data-test="sync-log-card">
      <header class="log-head">
        <h3>📋 实时同步日志</h3>
        <div class="log-actions">
          <span class="muted small">最近 {{ syncLog.length }} 条 · 同步过程中实时追加</span>
          <button class="link-btn" @click="clearSyncLog" :disabled="!syncLog.length">清空</button>
        </div>
      </header>
      <div v-if="!syncLog.length" class="empty-hint">暂无日志. 点击矩阵行的 [Sync now] 触发同步后会在这里追加.</div>
      <ul v-else class="sync-log-list" data-test="sync-log-list">
        <li v-for="(l, idx) in [...syncLog].reverse()" :key="idx"
            :class="['sync-log-line', `level-${l.level}`]">
          <span class="log-ts">{{ fmt(l.ts) }}</span>
          <span :class="['log-level', `level-${l.level}`]">[{{ l.level }}]</span>
          <span class="log-msg" :title="l.detail || ''">{{ l.msg }}</span>
        </li>
      </ul>
    </section>

    <!-- ============== 全局 toast ============== -->
    <div v-if="msg" class="global-msg" :class="msgCls">{{ msg }}</div>

    <!-- ============== 历史 runs ============== -->
    <section class="card runs-card">
      <h3>最近同步历史</h3>
      <table class="t">
        <thead>
          <tr>
            <th>开始时间</th>
            <th>森林</th>
            <th>域</th>
            <th>DC</th>
            <th>状态</th>
            <th>用户</th>
            <th>组</th>
            <th>OU</th>
            <th>耗时</th>
            <th>触发</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!runs.length"><td colspan="11" class="empty">暂无记录</td></tr>
          <tr v-for="r in runs" :key="r.id">
            <td>{{ fmt(r.startedAt) }}</td>
            <td>{{ r.forestName || '—' }}</td>
            <td>{{ r.domainName || '—' }}</td>
            <td>{{ r.dcName }}</td>
            <td>
              <span :class="['status-pill', `status-${r.status}`]">{{ r.status }}</span>
            </td>
            <td>{{ r.userCount ?? '—' }}</td>
            <td>{{ r.groupCount ?? '—' }}</td>
            <td>{{ r.ouCount ?? '—' }}</td>
            <td>{{ duration(r) }}</td>
            <td>{{ r.triggeredBy }}</td>
            <td class="err-cell" :title="r.errorMessage || ''">
              <!-- R158.44.1 — operator 「增加同步日志信息」 → 错误信息不再截断40 字符,
                   整段展开, 失败时更醒目. -->
              <span v-if="r.errorMessage" class="err-text">{{ r.errorMessage }}</span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </AdminLayout>
</template>

<script setup>
// R158.44 (2026-10-04) — DirectorySyncView 矩阵化重写.
import { onMounted, onBeforeUnmount, ref, computed, h } from 'vue';
import { useRouter } from 'vue-router';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
import SnapshotTreePanel from './SnapshotTreePanel.vue';

const router = useRouter();

// ---- matrix 主数据 ----
const forestSummary = ref(null);     // GET /forest-summary
const matrixLoading = ref(false);
const matrixError = ref('');

// ---- R158.45.34 — 同步周期设置 (intervalMinutes) ----
// 跟 status 端点同步: getDirectorySyncStatus 返 { intervalMinutes, lastRun,
// nextRunEstimate }. input 编辑触发 dirty, save 调 PUT 端点写 system_config.
// 后端 cron tick 每次读这个 key, 改完即时生效 (不需 restart backend).
// R158.46.1 (2026-10-06) — operator 改单位 小时→分钟. 范围 1-1440, 默认 60.
const intervalMinutesInput = ref(60);     // 本地编辑 state
const intervalMinutesServer = ref(60);    // 上次从 server 拉到的值 (dirty 比较)
const intervalLoading = ref(false);   // 加载 status
const intervalSaving = ref(false);     // 保存中
const intervalMinutesSaved = ref(false); // 保存成功提示 (3s 后消失)
const lastRunFinishedAt = ref(null);   // 用于算下次预计时间
const nextRunEstimateFromServer = ref(null);
const intervalMinutesValid = computed(() => {
  const n = Number(intervalMinutesInput.value);
  return Number.isInteger(n) && n >= 1 && n <= 1440;
});
const intervalMinutesDirty = computed(() => {
  return Number(intervalMinutesInput.value) !== Number(intervalMinutesServer.value);
});
const nextRunEstimateText = computed(() => {
  if (!lastRunFinishedAt.value || !intervalMinutesValid.value) return '—';
  // R158.46.1 — 单位换算: 分钟 → 毫秒 = × 60_000 (旧 × 3_600_000).
  const next = new Date(new Date(lastRunFinishedAt.value).getTime() + Number(intervalMinutesInput.value) * 60_000);
  return next.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
});

// ---- 行展开 + 异步 binding 缓存 ----
const expandedDomainId = ref(0);     // 单选: 一次只展一个
const bindingByDomain = ref(new Map());         // domainId -> binding wire
const bindingLoadingDomainIds = ref(new Set()); // 正在拉的 domainId 集合
const defaultDcByDomain = ref(new Map());        // domainId -> hostname (matrix 行内 DC 选)
const dcErrorByDomain = ref(new Map());          // domainId -> error message

// ---- 行级触发同步 ----
const syncingDomainIds = ref(new Set());

// ---- 历史 runs ----
const runs = ref([]);
const msg = ref('');
const msgCls = ref('msg-ok');

// ---- R158.44.1 — 实时同步日志 (operator 「增加同步日志信息」) ----
// syncLog: [{ ts: ISO, level: 'info'|'warn'|'err'|'ok', msg: string, detail?: string }]
// 最多保留 100 条, 滚动: 新条目放尾部, 渲染时 reverse().
const syncLog = ref([]);
const SYNC_LOG_MAX = 100;
function appendLog(level, msg, detail) {
  const line = { ts: new Date().toISOString(), level, msg };
  if (detail) line.detail = String(detail).slice(0, 500);
  const next = [...syncLog.value, line];
  if (next.length > SYNC_LOG_MAX) next.splice(0, next.length - SYNC_LOG_MAX);
  syncLog.value = next;
}
function clearSyncLog() { syncLog.value = []; }

// ---- poll 句柄 ----
let runPollHandle = null;
let runsTablePollHandle = null;

// flatten forests[].domains[].lastRun, sort by finishedAt DESC, 取第 1 条
const latestRun = computed(() => {
  const all = [];
  for (const f of (forestSummary.value?.forests || [])) {
    for (const d of (f.domains || [])) {
      if (d.lastRun?.finishedAt) all.push(d.lastRun);
    }
  }
  if (all.length === 0) return null;
  return all.sort((a, b) =>
    new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())[0];
});

// dcCountByDomain: 读 bindingByDomain 缓存; 没拉的 Map.has()=false
const dcCountByDomain = computed(() => {
  const m = new Map();
  for (const [id, binding] of bindingByDomain.value.entries()) {
    m.set(id, binding?.dcs?.length ?? 0);
  }
  return m;
});

// ---- R158.44.1 orphan DC 检测 + 一键清理 ----
const orphanDcs = ref([]);           // [{ dcName, orphanDomainId }]
const orphanLoading = ref(false);
const orphanUnbinding = ref(false);
async function reloadOrphanDcs() {
  orphanLoading.value = true;
  try {
    const { data } = await adminApi.listOrphanDcs();
    orphanDcs.value = data.orphans || [];
  } catch (e) {
    appendLog('warn', `扫描孤儿 DC 失败: ${e?.response?.data?.error || e?.message}`);
    orphanDcs.value = [];
  } finally {
    orphanLoading.value = false;
  }
}
async function onUnbindAllOrphans() {
  if (orphanUnbinding.value) return;
  if (!confirm(`将清空 ${orphanDcs.value.length} 台 DC 的 forest_domain_id (→ NULL). 此操作不可逆 (但 DC 行不删, 之后可重新指派). 确认?`)) return;
  orphanUnbinding.value = true;
  appendLog('info', `一键清理孤儿 DC: ${orphanDcs.value.length} 台`, orphanDcs.value.map(o => `${o.dcName} → ${o.orphanDomainId}`).join('\n'));
  try {
    const { data } = await adminApi.unbindAllOrphanDcs();
    appendLog('ok', `孤儿清理完成: 影响 ${data.affectedRows} 行, 重新扫描中…`);
    msg.value = `已清空 ${data.affectedRows} 台 DC 的孤儿归属, 请到 DC 总览重新指派`;
    msgCls.value = 'msg-ok';
    await reloadOrphanDcs();      // 重新扫描 (期望变 0)
    await reloadMatrix();         // 矩阵行 auto-sync chip 也要刷
  } catch (e) {
    const errMsg = e?.response?.data?.error || e?.message;
    msg.value = `清理失败: ${errMsg}`;
    msgCls.value = 'msg-err';
    appendLog('err', `孤儿清理失败: ${errMsg}`);
  } finally {
    orphanUnbinding.value = false;
  }
}

// ---- mount / refresh ----
async function reloadMatrix() {
  matrixLoading.value = true;
  matrixError.value = '';
  try {
    const res = await adminApi.getDirectorySyncForestSummary();
    forestSummary.value = res.data || { forests: [] };
  } catch (e) {
    matrixError.value = '加载矩阵失败: ' + (e?.response?.data?.error || e?.message);
  } finally {
    matrixLoading.value = false;
  }
}

// R158.45.34 — 加载 status 端点拿 intervalMinutes + lastRun + nextRunEstimate
// R158.46.1 (2026-10-06) — 字段名 intervalHours → intervalMinutes, 默认 60.
async function reloadSyncStatus() {
  intervalLoading.value = true;
  try {
    const { data } = await adminApi.getDirectorySyncStatus();
    const m = Number(data?.intervalMinutes) || 60;
    intervalMinutesServer.value = m;
    intervalMinutesInput.value = m;
    lastRunFinishedAt.value = data?.lastRun?.finishedAt || null;
    nextRunEstimateFromServer.value = data?.nextRunEstimate || null;
  } catch (e) {
    appendLog('warn', `加载同步周期状态失败: ${e?.response?.data?.error || e?.message}`);
  } finally {
    intervalLoading.value = false;
  }
}

// R158.45.34 — 保存 intervalMinutes 到 system_config
// R158.46.1 — 字段名改, 默认 60, 单位"分钟".
async function onSaveIntervalMinutes() {
  if (!intervalMinutesValid.value || intervalMinutesDirty.value === false) return;
  intervalSaving.value = true;
  intervalMinutesSaved.value = false;
  try {
    await adminApi.setDirectorySyncIntervalMinutes(Number(intervalMinutesInput.value));
    intervalMinutesServer.value = Number(intervalMinutesInput.value);
    appendLog('ok', `同步周期已更新: ${intervalMinutesServer.value} 分钟`);
    msg.value = `同步周期已设为 ${intervalMinutesServer.value} 分钟`;
    msgCls.value = 'msg-ok';
    intervalMinutesSaved.value = true;
    setTimeout(() => { intervalMinutesSaved.value = false; }, 3000);
  } catch (e) {
    const errMsg = e?.response?.data?.error || e?.message;
    msg.value = `保存同步周期失败: ${errMsg}`;
    msgCls.value = 'msg-err';
    appendLog('err', `保存同步周期失败: ${errMsg}`);
  } finally {
    intervalSaving.value = false;
  }
}

async function refreshRuns() {
  try {
    const { data } = await adminApi.listDirectorySyncRuns(20);
    runs.value = data.runs || [];
  } catch (e) {
    // 非致命: 保留旧列表
    // eslint-disable-next-line no-console
    console.warn('directory-sync runs list failed', e);
  }
}

onMounted(async () => {
  await reloadMatrix();
  await refreshRuns();
  await reloadOrphanDcs();   // R158.44.1 — mount 时扫一次孤儿 DC
  await reloadSyncStatus();  // R158.45.34 — 拉 intervalMinutes + lastRun
  // runs 表每 30s 自动刷新
  runsTablePollHandle = setInterval(refreshRuns, 30_000);
});

onBeforeUnmount(() => {
  if (runsTablePollHandle) clearInterval(runsTablePollHandle);
  if (runPollHandle) clearInterval(runPollHandle);
});

// ---- 行交互 ----
async function onRowClick(domain, ev) {
  // 切展开态
  if (expandedDomainId.value === domain.id) {
    expandedDomainId.value = 0;
    return;
  }
  expandedDomainId.value = domain.id;
  // 懒拉 binding (matrix mount 时不发 N+1)
  if (!bindingByDomain.value.has(domain.id)) {
    const next = new Set(bindingLoadingDomainIds.value);
    next.add(domain.id);
    bindingLoadingDomainIds.value = next;

    // 清理旧错误
    if (dcErrorByDomain.value.has(domain.id)) {
      const eMap = new Map(dcErrorByDomain.value);
      eMap.delete(domain.id);
      dcErrorByDomain.value = eMap;
    }

    try {
      const res = await adminApi.getDirectorySyncDomainBinding(domain.id);
      const bMap = new Map(bindingByDomain.value);
      bMap.set(domain.id, res.data);
      bindingByDomain.value = bMap;
      // 默认选 PDC (沿用 R158.43 305-308 行逻辑)
      const dcs = res.data?.dcs || [];
      const pdc = dcs.find(x => x.isPdc);
      const def = pdc || dcs[0];
      if (def) {
        const dMap = new Map(defaultDcByDomain.value);
        dMap.set(domain.id, def.hostname);
        defaultDcByDomain.value = dMap;
      }
    } catch (e) {
      const eMap = new Map(dcErrorByDomain.value);
      eMap.set(domain.id, e?.response?.data?.error || e?.message);
      dcErrorByDomain.value = eMap;
    } finally {
      const next = new Set(bindingLoadingDomainIds.value);
      next.delete(domain.id);
      bindingLoadingDomainIds.value = next;
    }
  }
}

function toggleExpand(domainId) {
  expandedDomainId.value = expandedDomainId.value === domainId ? 0 : domainId;
}

function onSelectDc(domainId, hostname) {
  const dMap = new Map(defaultDcByDomain.value);
  dMap.set(domainId, hostname);
  defaultDcByDomain.value = dMap;
}

function goToForestRegistry() {
  router.push({ path: '/admin/forest-registry' });
}

function dcStatusTooltip(domainId) {
  const binding = bindingByDomain.value.get(domainId);
  if (!binding) return '';
  const dcs = binding.dcs || [];
  return dcs.map(dc => `${dc.hostname}${dc.isPdc ? ' (PDC)' : ''} · ${sourceLabel(dc.source)}`).join('\n');
}

// ---- R158.5.4 — 同步按钮 lock / label / tooltip ----
// operator 反馈: 「上次没有同步完成, 同步按钮就不可用」.
// 双重锁: (a) 前端 in-flight (syncingDomainIds); (b) backend run status=running.
// (b) 防 polling 完成 + backend 仍卡 (preflight 漏 throw) 时误触重复同步.
function isSyncLocked(domain) {
  if (syncingDomainIds.value.has(domain.id)) return true;
  if (domain.lastRun?.status === 'running') return true;
  return false;
}
function syncBtnLabel(domain) {
  if (syncingDomainIds.value.has(domain.id)) return '同步中…';
  if (domain.lastRun?.status === 'running') return '运行中…';
  return 'Sync now';
}
function syncBtnTitle(domain) {
  if (syncingDomainIds.value.has(domain.id)) return '本前端有同步请求尚未结束';
  if (domain.lastRun?.status === 'running') {
    return `上一次同步仍在 backend 运行中 (开始于 ${fmt(domain.lastRun.startedAt)})`;
  }
  return '';
}

// ---- 行内触发同步 ----
async function onSyncOne(domain) {
  if (syncingDomainIds.value.has(domain.id)) return;
  const next = new Set(syncingDomainIds.value);
  next.add(domain.id);
  syncingDomainIds.value = next;
  const triggeredAt = new Date().toISOString();
  msg.value = `已入队域 ${domain.domainName} 同步`;
  msgCls.value = 'msg-info';
  appendLog('info', `触发同步: 域 ${domain.domainName} (id=${domain.id})`, `at ${triggeredAt}`);

  let targetRunIds = [];
  try {
    const { data } = await adminApi.triggerDirectorySync({ domainIds: [domain.id] });
    targetRunIds = data.runs?.map(r => r.id) || (data.runId ? [data.runId] : []);
    if (targetRunIds.length === 0) {
      appendLog('warn', `同步触发但 backend 未返 runId (data=${JSON.stringify(data).slice(0,200)})`);
    } else {
      appendLog('info', `已入队 ${targetRunIds.length} 个 run: ${targetRunIds.join(', ')}`);
    }
    await pollRunsUntilSettled(targetRunIds, domain);
    await reloadMatrix();   // 刷新 lastRun chip
  } catch (e) {
    const errMsg = e?.response?.data?.error || e?.message;
    msg.value = `触发失败: ${errMsg}`;
    msgCls.value = 'msg-err';
    appendLog('err', `同步触发失败: ${errMsg}`, e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : null);
  } finally {
    const next = new Set(syncingDomainIds.value);
    next.delete(domain.id);
    syncingDomainIds.value = next;
  }
}

function pollRunsUntilSettled(targetRunIds, domain) {
  if (!targetRunIds || targetRunIds.length === 0) return Promise.resolve();
  let polls = 0;
  const startedAtMs = Date.now();
  return new Promise(resolve => {
    runPollHandle = setInterval(async () => {
      polls++;
      if (polls > 60) {
        clearInterval(runPollHandle); runPollHandle = null;
        const elapsed = ((Date.now() - startedAtMs) / 1000).toFixed(1);
        msg.value = `同步超时 (${elapsed}s, 3min 上限), 检查历史`;
        msgCls.value = 'msg-err';
        appendLog('err', `同步超时 (${elapsed}s): run=${targetRunIds.join(',')} 仍未结束, 检查历史表`);
        resolve();
        return;
      }
      try {
        await refreshRuns();
        const targets = runs.value.filter(r => targetRunIds.includes(r.id));
        const settled = targets.filter(r =>
          (r.status === 'success' || r.status === 'failed'));
        // R158.44.1 — 每 3s 追加进度日志 (有 running 才追加, 避免与 trigger 日志重复刷屏)
        if (polls >= 2) {
          const elapsed = ((Date.now() - startedAtMs) / 1000).toFixed(1);
          const running = targets.filter(r => r.status === 'running').length;
          if (running > 0) {
            appendLog('info', `同步进行中 (${elapsed}s): ${running} 个 run 仍在 running`, `runIds=${targetRunIds.join(',')}`);
          }
        }
        if (settled.length === targetRunIds.length && targetRunIds.length > 0) {
          clearInterval(runPollHandle); runPollHandle = null;
          const ok = settled.filter(r => r.status === 'success').length;
          const fail = settled.length - ok;
          const elapsed = ((Date.now() - startedAtMs) / 1000).toFixed(1);
          if (fail > 0) {
            msg.value = `${ok} 成功 / ${fail} 失败 (用时 ${elapsed}s) — 查看下方日志`;
            msgCls.value = 'msg-err';
            appendLog('err', `同步完成 (${elapsed}s): ${ok} 成功 / ${fail} 失败`,
              settled.map(r => `run=${r.id} status=${r.status} err=${r.errorMessage || '—'}`).join('\n'));
            // 每条失败的 run 单独追加一行, 含完整 errorMessage
            for (const r of settled.filter(x => x.status === 'failed')) {
              appendLog('err',
                `run=${r.id} dc=${r.dcName} domain=${r.domainName || domain.domainName} failed: ${r.errorMessage || '—'}`,
                `startedAt=${r.startedAt}\nfinishedAt=${r.finishedAt}\nuserCount=${r.userCount}\ngroupCount=${r.groupCount}\nouCount=${r.ouCount}`);
            }
          } else {
            msg.value = `${ok} 个 DC 全部同步成功 (用时 ${elapsed}s)`;
            msgCls.value = 'msg-ok';
            for (const r of settled) {
              appendLog('ok',
                `run=${r.id} dc=${r.dcName} domain=${r.domainName || domain.domainName} success: ${r.userCount}U / ${r.groupCount}G / ${r.ouCount}OU`,
                `startedAt=${r.startedAt}\nfinishedAt=${r.finishedAt}\ndurationMs=${new Date(r.finishedAt) - new Date(r.startedAt)}`);
            }
          }
          resolve();
        }
      } catch (e) {
        appendLog('warn', `poll #${polls} 异常: ${e?.message || e}`);
        // keep polling
      }
    }, 3000);
  });
}

// ---- LastRunPill (inline 渲染函数, 不独立文件) ----
function lastRunPill(run) {
  if (!run) {
    return h('span', { class: 'status-pill status-never' }, '— 从未同步');
  }
  const cls = `status-pill status-${run.status}`;
  if (run.status === 'success') {
    return h('span', { class: cls, title: runTooltip(run) },
      ['✓ ', fmtRelative(run.finishedAt)]);
  }
  if (run.status === 'running') {
    return h('span', { class: cls, title: runTooltip(run) },
      ['⏳ ', fmtRelative(run.startedAt)]);
  }
  if (run.status === 'failed') {
    return h('span', { class: cls, title: runTooltip(run) },
      ['✗ ', fmtRelative(run.startedAt)]);
  }
  return h('span', { class: cls, title: runTooltip(run) }, run.status);
}

function runTooltip(run) {
  if (!run) return '';
  const parts = [];
  if (run.startedAt) parts.push(`开始: ${run.startedAt}`);
  if (run.finishedAt) parts.push(`结束: ${run.finishedAt}`);
  if (run.userCount != null) parts.push(`用户: ${run.userCount}`);
  if (run.groupCount != null) parts.push(`组: ${run.groupCount}`);
  if (run.ouCount != null) parts.push(`OU: ${run.ouCount}`);
  if (run.errorMessage) parts.push(`错误: ${run.errorMessage}`);
  return parts.join('\n');
}

// ---- 工具 ----
function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}
function duration(r) {
  if (!r?.startedAt || !r?.finishedAt) return '—';
  const ms = new Date(r.finishedAt) - new Date(r.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
function sourceLabel(src) {
  if (src === 'assignment') return '绑定';
  if (src === 'domain_default') return '默认';
  if (src === 'pdc_fallback') return 'PDC';
  return '';
}
</script>

<style scoped>
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px 20px; margin-bottom: 16px; }
.card h3 { margin: 0 0 12px; }

/* ---- header ---- */
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.page-summary { margin: 0; color: var(--muted); font-size: 12px; max-width: 760px; }
.head-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.inline-link { color: var(--accent, #60a5fa); text-decoration: none; }
.inline-link:hover { text-decoration: underline; }
.ldap-link {
  display: inline-block;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 12px;
  background: var(--input-bg);
}
.ldap-link:hover { border-color: var(--accent, #60a5fa); color: var(--accent, #60a5fa); }

/* ---- chip (顶部 + 矩阵行内) ---- */
.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
}
.chip-ok { background: rgba(34, 197, 94, 0.14); color: #22c55e; }
.chip-warn { background: rgba(234, 179, 8, 0.16); color: #eab308; }
.chip-err { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
.chip-neutral { background: rgba(107, 114, 128, 0.14); color: #9ca3af; }
.chip-meta { font-weight: 400; margin-left: 6px; opacity: 0.8; }

/* ---- 矩阵 ---- */
.matrix-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.matrix-head h3 { margin: 0; }
.matrix-actions button {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
}
.matrix-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

.forest-block { margin-bottom: 18px; }
.forest-block:last-child { margin-bottom: 0; }
.forest-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.forest-icon { font-size: 16px; }
.forest-dn { font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill.ok { background: rgba(34, 197, 94, 0.14); color: #22c55e; }
.pill.small { font-size: 10px; padding: 0 6px; }
.muted { color: var(--muted); }
.muted.small { font-size: 11px; }

.matrix-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.matrix-table th { padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 600; text-align: left; background: var(--panel-alt, rgba(255,255,255,0.02)); }
.matrix-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.col-name { min-width: 220px; }
.col-auto { width: 90px; }
.col-dc { width: 70px; }
.col-last { width: 110px; }
.col-action { width: 100px; text-align: right; }

.matrix-row { cursor: pointer; transition: background 0.1s; }
.matrix-row:hover { background: var(--panel-alt, rgba(255,255,255,0.04)); }
.matrix-row.expanded { background: rgba(96, 165, 250, 0.05); }
.matrix-row.syncing { background: rgba(96, 165, 250, 0.08); }
.matrix-row.failed { background: rgba(239, 68, 68, 0.04); }

.caret { display: inline-block; width: 14px; color: var(--text-muted); cursor: pointer; user-select: none; font-size: 11px; }
.d-name { font-weight: 500; margin-right: 4px; }
.d-dn { font-family: 'JetBrains Mono', Consolas, monospace; font-size: 11px; }

.dc-count { font-weight: 500; }
.expand-row td { padding: 8px 8px 12px; border-bottom: 2px solid var(--accent, #60a5fa); background: var(--panel-alt, rgba(255,255,255,0.02)); }

.sync-btn {
  padding: 4px 10px;
  border: 1px solid var(--accent, #60a5fa);
  border-radius: 4px;
  cursor: pointer;
  background: var(--accent, #60a5fa);
  color: white;
  font-size: 12px;
}
.sync-btn:hover:not(:disabled) { filter: brightness(1.1); }
.sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- lastRun status pill (渲染函数生成的 class) ---- */
.matrix-table .status-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.matrix-table .status-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid #4ade80; }
.matrix-table .status-running { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid #60a5fa; }
.matrix-table .status-failed  { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid #f87171; }
.matrix-table .status-never   { background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid #6b7280; }

/* ---- 空态 / toast ---- */
.empty-hint { color: var(--text-muted); font-size: 13px; padding: 24px; text-align: center; }
.empty-hint.error { color: #ef4444; }
.global-msg {
  margin: 12px 0;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 13px;
  border: 1px solid var(--border);
}
.msg-ok { background: rgba(34, 197, 94, 0.10); color: #4ade80; border-color: #4ade80; }
.msg-err { background: rgba(239, 68, 68, 0.10); color: #f87171; border-color: #f87171; }
.msg-info { background: rgba(96, 165, 250, 0.10); color: #60a5fa; border-color: #60a5fa; }

/* ---- runs 表 (沿用旧样式) ---- */
.runs-card .t { width: 100%; border-collapse: collapse; }
.runs-card th, .runs-card td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; font-size: 13px; vertical-align: top; }
.runs-card th { color: var(--text-muted); font-weight: 600; }
.runs-card .empty { text-align: center; color: var(--text-muted); padding: 24px; }
.runs-card .err-cell { max-width: 480px; color: #ef4444; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.runs-card .err-text { display: inline-block; }
.runs-card .status-pill { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.runs-card .status-running { background: rgba(96, 165, 250, 0.14); color: #60a5fa; }
.runs-card .status-success { background: rgba(34, 197, 94, 0.14); color: #22c55e; }
.runs-card .status-failed  { background: rgba(239, 68, 68, 0.14); color: #ef4444; }

/* ---- R158.45.34 同步周期设置 ---- */
.interval-card { background: var(--panel); }
.interval-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.interval-head h3 { margin: 0; }
.interval-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.interval-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); }
.interval-label input {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 13px;
  width: 80px;
  font-family: 'JetBrains Mono', Consolas, monospace;
}
.interval-label input:focus { outline: none; border-color: var(--accent, #60a5fa); }
.interval-label input:disabled { opacity: 0.5; cursor: not-allowed; }
.primary-btn {
  padding: 5px 14px;
  background: var(--accent, #3b82f6);
  color: white;
  border: 1px solid var(--accent, #3b82f6);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.primary-btn:hover:not(:disabled) { filter: brightness(1.1); }
.primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ok.small { color: #22c55e; font-size: 11px; }
.err.small { color: #ef4444; font-size: 11px; }

/* ---- R158.44.1 orphan DC 警告 ---- */
.orphan-card { background: rgba(239, 68, 68, 0.04); border-color: rgba(239, 68, 68, 0.35); }
.orphan-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 12px; flex-wrap: wrap; }
.orphan-head h3 { margin: 0; color: #ef4444; }
.orphan-actions { display: flex; gap: 8px; }
.danger-btn { background: #ef4444; color: white; border: 1px solid #ef4444; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
.danger-btn:hover:not(:disabled) { background: #dc2626; border-color: #dc2626; }
.danger-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.orphan-desc { color: var(--text-muted); font-size: 12px; margin: 0 0 10px; }
.orphan-desc code { background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 2px; font-size: 11px; }
.orphan-list { display: flex; flex-wrap: wrap; gap: 6px; max-height: 180px; overflow-y: auto; }
.orphan-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--panel); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 3px; font-size: 12px; }
.orphan-chip strong { color: #ef4444; }
.orphan-chip small { font-size: 11px; }

/* ---- R158.44.1 实时同步日志卡 ---- */
.log-card { background: var(--panel); }
.log-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.log-head h3 { margin: 0; }
.log-actions { display: flex; align-items: center; gap: 12px; }
.link-btn { background: none; border: 1px solid var(--border); color: var(--text); padding: 2px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; }
.link-btn:hover:not(:disabled) { border-color: var(--accent, #60a5fa); color: var(--accent, #60a5fa); }
.link-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sync-log-list { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--input-bg, rgba(0,0,0,0.02)); }
.sync-log-line { display: grid; grid-template-columns: 160px 60px 1fr; gap: 8px; padding: 4px 10px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; border-bottom: 1px solid var(--border); align-items: start; }
.sync-log-line:last-child { border-bottom: none; }
.sync-log-line.level-info { background: rgba(96, 165, 250, 0.04); }
.sync-log-line.level-warn { background: rgba(234, 179, 8, 0.05); }
.sync-log-line.level-err  { background: rgba(239, 68, 68, 0.05); }
.sync-log-line.level-ok   { background: rgba(34, 197, 94, 0.05); }
.log-ts { color: var(--text-muted); font-size: 11px; }
.log-level { font-weight: 700; font-size: 11px; padding: 0 4px; border-radius: 2px; text-align: center; }
.log-level.level-info { color: #60a5fa; }
.log-level.level-warn { color: #eab308; }
.log-level.level-err  { color: #ef4444; }
.log-level.level-ok   { color: #22c55e; }
.log-msg { color: var(--text); white-space: pre-wrap; word-break: break-word; }
</style>