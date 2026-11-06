<!--
  R66 T10 — 包管理 (PackagesView)

  Operator can:
   - see all installed scripts (rows from GET /api/admin/packages, new
     envelope {items: [...]})
   - upload raw PS1 scripts via UploadScriptModal
   - view the raw script body via EditScriptModal (viewMode, R67-T1)
   - edit a script body via EditScriptModal (PUT .../script)
   - edit a script's policy via EditPolicyModal (PUT .../policy)
   - toggle enabled (PUT .../enable / disable)
   - delete with confirm (DELETE .../:name)

  The view talks directly to packagesApi (no Pinia store). The legacy
  Pinia store at src/stores/packages.js is intentionally kept alive for
  PackageEditView / RegistryView — T13 cleans them up.

  Visual language matches R49 ops-console: dimmer L1 title, status-pill
  3-color, tnum on numbers, 2px left rail on row hover.

  data-test contract (matched by tests/packages-view.test.js):
    upload-btn                 — "+ 上传脚本" toolbar button
    refresh-btn                — "↻ 刷新" toolbar button
    row-${name}                — table row
    script-row                 — table row class
    view-script-${name}        — per-row 查看 button (R67-T1, opens modal in viewMode)
    edit-script-${name}        — per-row 脚本 button (opens EditScriptModal)
    edit-policy-${name}        — per-row 策略 button
    toggle-${name}             — per-row 启用/禁用 button
    delete-${name}             — per-row 删除 button
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">运维管理 · 脚本与策略</div>
        <h2 class="page-title">包管理</h2>
        <p class="subtitle">上传脚本并配置执行策略;支持启用/禁用、按间隔与超时自动执行。</p>
      </div>
      <div class="page-meta">
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
        <router-link class="btn-secondary" data-test="goto-schedule-btn" to="/admin/packages-schedule">▶ 包执行计划</router-link>
        <button class="btn-primary" data-test="upload-btn" @click="openUpload">+ 上传脚本</button>
      </div>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- R158.X.99.16 (2026-10-18) — AD / MemberServer 分两段展示. 包数据
         `agentType` 字段 (manifest.agent.type ∈ {'ad','non-ad'}) 已
         在 /api/admin/packages response 顶层 (src/packages/router.js:117-155),
         前端 computed group_by 0 改 endpoint/service/DB. 1:1 平行 R158.77.2
         sidebar 精简 precedent (顶部 0 segment 切换, 直接 2 段 table 串展示).
         顺序: AD 在前 (R66 T10 原生 AD-first 习惯), MemberServer 在后.
         on-demand 4 个 AD 包硬编码 ONDEMAND_PACKAGES 保留, 不动 R158.60.4
         既有行为. -->
    <div v-if="adItems.length" class="fleet-section" data-test="fleet-section-ad">
      <h3 class="fleet-section-title">AD 域控 ({{ adItems.length }})</h3>
    <div class="t-wrap">
    <table class="t">
      <thead>
        <tr>
          <th><!-- R152 — expand triangle column --></th>
          <th>名称</th>
          <th>版本</th>
          <th>类型</th>
          <th>启用</th>
          <th class="num">间隔(s)</th>
          <th class="num">超时(ms)</th>
          <th>来源</th>
          <th>最后修改</th>
          <!-- R158.60.4 — 只在表里有 on-demand 包时显示整列 -->
          <th v-if="hasAnyOndemand" class="run-col-head">执行状态</th>
          <th class="actions-col">操作</th>
        </tr>
      </thead>
      <tbody>
        <!-- R158.x — 主 row + fold-out history + on-demand recent 三个 <tr>
             用 <template v-for="it in items"> 包起来, 让它们按 items 顺序
             穿插渲染 (fold-out / recent 紧跟各自主 row)。
             之前 R152 用嵌套 <tbody v-for="it in items"> 包, 但 HTML spec
             不允许 <tbody> 嵌套, 浏览器把内层 tbody 提升 → colgroup 上下文
             断裂 → CSS :nth-child(N) 列宽错位 (表头跟行 td 对不上)。
             R152 注释里担心的 "Vue can't reconcile fragment" 是过度防御:
             <template v-for> 的 children 是多个 element 时 Vue 3 vnode
             会正确 reconcile, 不会丢 click handler。fold-out 子 row 用
             v-if="isExpanded" 跟 on-demand 子 row 用更复杂 v-if, 都是
             template fragment 的 sibling, 浏览器会把它们当成主 row 的
             sibling <tr> 渲染, 列宽共享同一 colgroup 上下文。
             expandedItems / ondemandRecentItems 这两个 computed 现在
             不再被 template 使用, 保留供调试/外部读取。 -->
        <template v-for="it in adItems" :key="it.name">
        <tr
          class="script-row"
          :class="{ expanded: isExpanded(it.name) }"
          :data-test="`row-${it.name}`"
        >
            <td class="expand-cell">
              <!-- R152 — click triangle (or the cell) to fold/unfold the
                   version history under this row. Multiple rows can be
                   expanded simultaneously (independent state). -->
              <button
                class="expand-btn"
                :data-test="`expand-${it.name}`"
                :aria-label="isExpanded(it.name) ? '折叠历史版本' : '展开历史版本'"
                @click.stop="toggleExpand(it.name)"
              >{{ isExpanded(it.name) ? '▼' : '▶' }}</button>
            </td>
            <td class="name-cell">
              <span class="name">{{ it.name }}</span>
              <!-- R158.60.4 — 4 个 on-demand 包视觉标识 (R158.56c-d ship) -->
              <span
                v-if="isOndemand(it.name)"
                class="ondemand-badge"
                title="无自动调度周期, 仅通过手动触发"
              >ondemand</span>
              <!-- R152 — show history badge if the expanded fetch
                   yielded > 1 row OR synthesized. Helps the operator
                   spot pre-R152 installs at a glance. -->
              <span
                v-if="historyFor(it.name) && historyFor(it.name).length > 1"
                class="history-badge"
                :title="`已发布 ${historyFor(it.name).length} 个版本`"
              >历史 {{ historyFor(it.name).length }}</span>
            </td>
            <td><code class="version">{{ it.version }}</code></td>
            <td><span class="type-tag" :class="`type-${it.type}`">{{ typeLabel(it.type) }}</span></td>
            <td>
              <span :class="['status-pill', it.enabled ? 'ok' : 'off']">
                <span class="dot"></span>{{ it.enabled ? '已启用' : '已禁用' }}
              </span>
            </td>
            <td class="num">{{ it.intervalSec ?? '—' }}</td>
            <td class="num">{{ it.timeoutMs ?? '—' }}</td>
            <td><code class="source">{{ sourceLabel(it.source) }}</code></td>
            <td>{{ fmt(it.updatedAt) }}</td>
            <!-- R158.60.4 — 4 个 on-demand 包执行状态列 (30s 轮询)
                 R158.60.6 — operator 反馈 2026-10-09: pill + "On-demand" 标识
                 同时显 (双重信号: 4 个 on-demand 包永远是 operator-hand 触发的,
                 跟 9 个内置 cron 包区别). 永远额外显示 "On-demand" 标签,
                 pill + 时间只在最近 24h 触发过才出现 (status 反馈). -->
            <td v-if="hasAnyOndemand" class="run-cell" :data-test="`run-${it.name}`">
              <template v-if="!isOndemand(it.name)">
                <span class="run-empty">—</span>
              </template>
              <template v-else>
                <!-- R158.60.6 — 4 个 on-demand 包永远显 "On-demand" 标识 (不管 pill) -->
                <span
                  class="run-ondemand-tag"
                  :data-test="`run-ondemand-tag-${it.name}`"
                  title="无自动调度周期, 仅通过手动触发"
                >On-demand</span>
                <!-- pill + 时间只在 24h 总运行数 > 0 才出现 -->
                <template v-if="runsError[it.name]">
                  <span class="run-err" :title="runsError[it.name]">查询失败</span>
                </template>
                <template v-else-if="!runsByName[it.name] || !runsByName[it.name].summary">
                  <span class="run-empty">—</span>
                </template>
                <template v-else-if="runsByName[it.name].summary.total > 0">
                  <span
                    :class="['run-pill', `run-${lastRunClass(runsByName[it.name].summary)}`]"
                    :data-test="`run-pill-${it.name}`"
                    :title="`最近 24h: ${runsByName[it.name].summary.success} 成功 / ${runsByName[it.name].summary.failure} 失败 / ${runsByName[it.name].summary.partial} 部分`"
                  >
                    <span class="dot"></span>{{ lastRunLabel(runsByName[it.name].summary) }}
                  </span>
                  <span class="run-time">{{ lastRunTime(runsByName[it.name].summary) }}</span>
                </template>
              </template>
            </td>
            <td class="row-actions">
              <!-- R152 — icon-only buttons + title tooltip to keep the
                   row on a single line at narrow widths (operator
                   2026-09-29: "行内尽量一行"). data-test unchanged so
                   existing tests still match. -->
              <button class="icon-btn" :data-test="`view-script-${it.name}`" title="查看脚本" @click="openViewScript(it)">👁</button>
              <button class="icon-btn" :data-test="`edit-script-${it.name}`" title="编辑脚本" @click="openEditScript(it)">✎</button>
              <button class="icon-btn" :data-test="`edit-policy-${it.name}`" title="编辑策略" @click="openEditPolicy(it)">⚙</button>
              <button class="icon-btn" :data-test="`toggle-${it.name}`" :title="it.enabled ? '禁用' : '启用'" @click="toggleEnabled(it)">
                {{ it.enabled ? '⏸' : '▶' }}
              </button>
              <button class="icon-btn danger" :data-test="`delete-${it.name}`" title="删除" @click="confirmDelete(it)">✕</button>
            </td>
          </tr>
          <!-- R158.x — fold-out history 子 row. 用 v-if 保留原 R152 行为
               (展开才渲染, 多 row 可同时展开, 互相独立)。 跟随主 row 的
               <template v-for> scope, 拿 it.name。 -->
          <tr
            v-if="isExpanded(it.name)"
            class="history-row"
            :data-test="`history-${it.name}`"
          >
            <td :colspan="hasAnyOndemand ? 11 : 10" class="history-cell">
              <div v-if="historyLoading(it.name)" class="history-loading">加载历史版本…</div>
              <div v-else-if="historyError(it.name)" class="history-error">{{ historyError(it.name) }}</div>
              <table v-else-if="historyFor(it.name).length" class="history-t">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>SHA256</th>
                    <th>来源</th>
                    <th>发布时间</th>
                    <th>标识</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="h in historyFor(it.name)"
                    :key="`${h.version}-${h.scriptSha256}`"
                    :class="{ 'history-current': h.version === it.version && h.scriptSha256 === it.scriptSha256 }"
                  >
                    <td><code class="version">{{ h.version }}</code></td>
                    <td>
                      <code class="sha" :title="h.scriptSha256">{{ h.scriptSha256.slice(0, 12) }}…</code>
                    </td>
                    <td><code class="source">{{ sourceLabel(h.source) }}</code></td>
                    <td>{{ fmt(h.publishedAt) }}</td>
                    <td>
                      <span
                        v-if="h.version === it.version && h.scriptSha256 === it.scriptSha256"
                        class="current-tag"
                      >当前</span>
                      <span v-else class="older-tag">历史</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="history-empty">暂无历史记录</div>
            </td>
          </tr>
          <!-- R158.60.4 + R158.x — on-demand 包最近 10 次执行折叠.
               v-if 条件跟 R158.60.4 原版一致 (展开 + on-demand + 有 recent
               数据)。复用 history-row 视觉。 -->
          <tr
            v-if="isExpanded(it.name) && isOndemand(it.name) && runsByName[it.name] && runsByName[it.name].recent && runsByName[it.name].recent.length"
            class="history-row ondemand-recent-row"
            :data-test="`ondemand-recent-${it.name}`"
          >
            <td :colspan="hasAnyOndemand ? 11 : 10" class="history-cell">
              <h5 class="ondemand-recent-title">最近 {{ runsByName[it.name].recent.length }} 次执行</h5>
              <table class="history-t ondemand-recent-t">
                <thead>
                  <tr>
                    <th>开始</th>
                    <th>Agent</th>
                    <th>状态</th>
                    <th class="num">耗时</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in runsByName[it.name].recent"
                    :key="r.id"
                    :class="`recent-${runRowClass(r)}`"
                  >
                    <td>{{ fmt(r.startedAt) }}</td>
                    <td><code class="agent-id">{{ r.agentId }}</code></td>
                    <td>
                      <span :class="['run-pill', `run-${runRowClass(r)}`]">
                        <span class="dot"></span>{{ runRowLabel(r) }}
                      </span>
                    </td>
                    <td class="num">{{ r.durationMs != null ? `${r.durationMs} ms` : '—' }}</td>
                    <td class="err-cell" :title="r.error || ''">{{ r.error || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    </div>
    </div>
    <!-- R158.X.99.16 (2026-10-18) — MemberServer (NoAD) 段. 跟 AD 段
         1:1 平行, 同一组件同一模板, 仅数据源切到 noAdItems computed.
         命名空间 filter: 1:1 平行 member-servers-public.js:664-669 — agentType
         === 'non-ad' AND name 不以 'ad_' 开头 (跟 R158.92 dashboard
         packages-runs 反向 filter 1:1 平行). -->
    <div v-if="noAdItems.length" class="fleet-section" data-test="fleet-section-noad">
      <h3 class="fleet-section-title">MemberServer ({{ noAdItems.length }})</h3>
    <div class="t-wrap">
    <table class="t">
      <thead>
        <tr>
          <th><!-- R152 — expand triangle column --></th>
          <th>名称</th>
          <th>版本</th>
          <th>类型</th>
          <th>启用</th>
          <th class="num">间隔(s)</th>
          <th class="num">超时(ms)</th>
          <th>来源</th>
          <th>最后修改</th>
          <th v-if="hasAnyOndemand" class="run-col-head">执行状态</th>
          <th class="actions-col">操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="it in noAdItems" :key="it.name">
        <tr
          class="script-row"
          :class="{ expanded: isExpanded(it.name) }"
          :data-test="`row-${it.name}`"
        >
            <td class="expand-cell">
              <button
                class="expand-btn"
                :data-test="`expand-${it.name}`"
                :aria-label="isExpanded(it.name) ? '折叠历史版本' : '展开历史版本'"
                @click.stop="toggleExpand(it.name)"
              >{{ isExpanded(it.name) ? '▼' : '▶' }}</button>
            </td>
            <td class="name-cell">
              <span class="name">{{ it.name }}</span>
              <span
                v-if="isOndemand(it.name)"
                class="ondemand-badge"
                title="无自动调度周期, 仅通过手动触发"
              >ondemand</span>
              <span
                v-if="historyFor(it.name) && historyFor(it.name).length > 1"
                class="history-badge"
                :title="`已发布 ${historyFor(it.name).length} 个版本`"
              >历史 {{ historyFor(it.name).length }}</span>
            </td>
            <td><code class="version">{{ it.version }}</code></td>
            <td><span class="type-tag" :class="`type-${it.type}`">{{ typeLabel(it.type) }}</span></td>
            <td>
              <span :class="['status-pill', it.enabled ? 'ok' : 'off']">
                <span class="dot"></span>{{ it.enabled ? '已启用' : '已禁用' }}
              </span>
            </td>
            <td class="num">{{ it.intervalSec ?? '—' }}</td>
            <td class="num">{{ it.timeoutMs ?? '—' }}</td>
            <td><code class="source">{{ sourceLabel(it.source) }}</code></td>
            <td>{{ fmt(it.updatedAt) }}</td>
            <td v-if="hasAnyOndemand" class="run-cell" :data-test="`run-${it.name}`">
              <template v-if="!isOndemand(it.name)">
                <span class="run-empty">—</span>
              </template>
              <template v-else>
                <span
                  class="run-ondemand-tag"
                  :data-test="`run-ondemand-tag-${it.name}`"
                  title="无自动调度周期, 仅通过手动触发"
                >On-demand</span>
                <template v-if="runsError[it.name]">
                  <span class="run-err" :title="runsError[it.name]">查询失败</span>
                </template>
                <template v-else-if="!runsByName[it.name] || !runsByName[it.name].summary">
                  <span class="run-empty">—</span>
                </template>
                <template v-else-if="runsByName[it.name].summary.total > 0">
                  <span
                    :class="['run-pill', `run-${lastRunClass(runsByName[it.name].summary)}`]"
                    :data-test="`run-pill-${it.name}`"
                    :title="`最近 24h: ${runsByName[it.name].summary.success} 成功 / ${runsByName[it.name].summary.failure} 失败 / ${runsByName[it.name].summary.partial} 部分`"
                  >
                    <span class="dot"></span>{{ lastRunLabel(runsByName[it.name].summary) }}
                  </span>
                  <span class="run-time">{{ lastRunTime(runsByName[it.name].summary) }}</span>
                </template>
              </template>
            </td>
            <td class="row-actions">
              <button class="icon-btn" :data-test="`view-script-${it.name}`" title="查看脚本" @click="openViewScript(it)">👁</button>
              <button class="icon-btn" :data-test="`edit-script-${it.name}`" title="编辑脚本" @click="openEditScript(it)">✎</button>
              <button class="icon-btn" :data-test="`edit-policy-${it.name}`" title="编辑策略" @click="openEditPolicy(it)">⚙</button>
              <button class="icon-btn" :data-test="`toggle-${it.name}`" :title="it.enabled ? '禁用' : '启用'" @click="toggleEnabled(it)">
                {{ it.enabled ? '⏸' : '▶' }}
              </button>
              <button class="icon-btn danger" :data-test="`delete-${it.name}`" title="删除" @click="confirmDelete(it)">✕</button>
            </td>
          </tr>
          <!-- R158.X.99.16 — fold-out history 子 row (1:1 平行 AD 段 R152 行为) -->
          <tr v-if="isExpanded(it.name)" class="history-row" :data-test="`history-${it.name}`">
            <td :colspan="hasAnyOndemand ? 11 : 10" class="history-cell">
              <div v-if="historyMetaByName[it.name]?.loading" class="history-loading">加载历史版本…</div>
              <div v-else-if="historyMetaByName[it.name]?.error" class="history-error">{{ historyMetaByName[it.name].error }}</div>
              <table v-else-if="historyFor(it.name)?.length" class="history-t">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>来源</th>
                    <th>脚本 SHA-256</th>
                    <th>发布时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="h in historyFor(it.name)" :key="`${it.name}-${h.version}-${h.createdAt}`">
                    <td><code class="version">{{ h.version }}</code></td>
                    <td><code class="source">{{ sourceLabel(h.source) }}</code></td>
                    <td><code class="sha">{{ h.scriptSha256 ? h.scriptSha256.slice(0, 12) + '…' : '—' }}</code></td>
                    <td>{{ fmt(h.createdAt) }}</td>
                    <td>
                      <button class="icon-btn" :data-test="`view-history-${it.name}-${h.version}`" title="查看该版本脚本" @click="openViewHistory(it, h)">👁</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="history-empty">无历史版本</div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    </div>
    </div>
    <div v-else-if="!loading && !error" class="empty">
      暂无脚本。点 + 上传脚本 添加。
    </div>

    <UploadScriptModal
      v-if="showUpload"
      @close="showUpload = false"
      @uploaded="refresh"
    />
    <EditScriptModal
      v-if="editingScript"
      :item="editingScript"
      :view-mode="viewingScript"
      @close="closeScriptModal"
      @saved="refresh"
    />
    <EditPolicyModal
      v-if="editingPolicy"
      :item="editingPolicy"
      @close="editingPolicy = null"
      @saved="refresh"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import UploadScriptModal from '../../components/admin/UploadScriptModal.vue';
import EditScriptModal from '../../components/admin/EditScriptModal.vue';
import EditPolicyModal from '../../components/admin/EditPolicyModal.vue';
import { packagesApi } from '../../api/packages.js';
import { dashboardApi } from '../../api/dashboard.js';
import { formatDateTime } from '../../lib/timezone.js';

// R158.60.4 — 4 个 on-demand 包 (R158.56c-d ship) 单独标识. 这些包
// 没有 agent.intervalSec, 走 R75 drainAdCommands → dispatchAdCommand
// 路径触发, 不进 setInterval 定时器. 详见 R158.60.3 memory.
const ONDEMAND_PACKAGES = new Set([
  'ad_ad_groups_write',
  'ad_ad_users_write',
  'ad_ad_object_move',
  'ad_ad_ou_create'
]);
const isOndemand = (name) => ONDEMAND_PACKAGES.has(name);

const items = ref([]);
const error = ref('');
const loading = ref(false);

// R158.X.99.16 (2026-10-18) — 按 agentType 切 AD / MemberServer 两组.
// 1:1 平行 member-servers-public.js:664-669 filter 规则:
//   - AD: agentType === 'ad' (含 on-demand 4 个, 跟 R158.60.4 ONDEMAND_PACKAGES 1:1 平行)
//   - MemberServer: agentType === 'non-ad' AND name NOT startsWith 'ad_'
//     (跟 R158.92 dashboard packages-runs:1995-2001 反向 filter 1:1 平行, 防止 ad_ 前缀
//     但 agentType 误标 'non-ad' 的边界 case 漏到 NoAD 段).
// 顺序稳定: sort by name asc (跟原 /api/admin/packages ORDER BY name 1:1 平行).
const adItems = computed(() => {
  return items.value
    .filter((it) => (it.agentType || 'ad') === 'ad')
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
});
const noAdItems = computed(() => {
  return items.value
    .filter((it) => (it.agentType || 'ad') === 'non-ad' && !String(it.name || '').startsWith('ad_'))
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
});

// R158.60.4 — on-demand 包最近 10 次执行 (用 /api/dashboard/packages-runs
// 数据, 跟 PackageRunsMonitorView 同源). 4 个包名才进 map, 其它包不存,
// 减少内存 + 不渲染无关行.
const runsByName = ref({});
const runsError = ref({});

// 30s 轮询 timer. onMounted 启动, onUnmounted 清, 跟 /packages-runs 监控
// 视图同频. 单个 fetch 失败 .catch() 隔离, 不影响 packagesApi.list.
let pollTimer = null;
const POLL_MS = 30_000;

// R152 — fold-out version history state. Each entry is keyed by package
// name. We keep three orthogonal maps so re-renders of unrelated rows
// don't re-trigger the deep watchers:
//   expanded        — Set of names whose history panel is open
//   historyByName   — name -> items[] (resolved history rows)
//   historyMetaByName — name -> { loading: boolean, error: string|null }
// One fetch per name per expand; collapses back don't re-fetch.
const expanded = ref(new Set());
const historyByName = ref({});
const historyMetaByName = ref({});

function isExpanded(name) { return expanded.value.has(name); }
function historyFor(name) { return historyByName.value[name] || []; }
function historyLoading(name) { return !!historyMetaByName.value[name]?.loading; }
function historyError(name) { return historyMetaByName.value[name]?.error || ''; }

const showUpload = ref(false);
const editingScript = ref(null);
// R67-T1 — distinguishes view-mode (true) from edit-mode (false) for the
// shared EditScriptModal instance. Both flows set `editingScript`; this
// flag tells the modal which mode to render in.
const viewingScript = ref(false);
const editingPolicy = ref(null);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    // R158.60.4 — 并行拉取包列表 + 4 个 on-demand 包的执行数据.
    // /api/dashboard/packages-runs 1 round-trip 全量 packages[], 前端
    // O(N) 过滤, 比 4 次单独 fetch 少 3 个 round-trip.
    const [pkgRes] = await Promise.all([
      packagesApi.list(),
      fetchOndemandRuns()
    ]);
    items.value = Array.isArray(pkgRes.data?.items) ? pkgRes.data.items : [];
  } catch (e) {
    // T7's router returns `{ error: "..." }` directly on validation
    // failures and `{ error: "internal" }` on 500 — both shapes are a
    // single string, not the legacy `{ error: { message } }` wrapper.
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    loading.value = false;
  }
}

// R158.60.4 — fetch 4 个 on-demand 包的 summary24h + recent[10].
// 后端 1 round-trip 全包 (dashboard.js:1813 /api/dashboard/packages-runs),
// 这边按 name 过滤 + 切片. 全局失败 .catch() 隔离, 不影响 packagesApi.list.
async function fetchOndemandRuns() {
  if (!items.value.length) return;
  try {
    const r = await dashboardApi.getPackagesRuns();
    const all = Array.isArray(r.data?.packages) ? r.data.packages : [];
    const next = {};
    const nextErr = {};
    for (const it of items.value) {
      if (!isOndemand(it.name)) continue;
      const pkg = all.find(p => p.name === it.name);
      if (pkg) {
        next[it.name] = { summary: pkg.summary24h, recent: pkg.recent };
        nextErr[it.name] = '';
      } else {
        next[it.name] = null;
        nextErr[it.name] = '';
      }
    }
    runsByName.value = next;
    runsError.value  = { ...runsError.value, ...nextErr };
  } catch (e) {
    // 全局失败: 4 个 on-demand 包都标 error, runsByName 保留旧值, UI 显 "查询失败".
    const err = e?.response?.data?.error || e?.message || 'fetch failed';
    const nextErr = {};
    for (const it of items.value) {
      if (isOndemand(it.name)) nextErr[it.name] = err;
    }
    runsError.value = { ...runsError.value, ...nextErr };
  }
}

// R152 — toggle the fold-out panel. First expand triggers a fetch;
// subsequent toggles use the cached `historyByName[name]` value (no
// refetch on collapse-then-expand). Errors are sticky until the operator
// refreshes the page or re-toggles.
async function toggleExpand(name) {
  const set = expanded.value;
  if (set.has(name)) {
    set.delete(name);
    // Force reactivity on Set (Vue 3's reactive() wraps but raw Set
    // mutations don't always notify — using a new Set is the safest).
    expanded.value = new Set(set);
    return;
  }
  set.add(name);
  expanded.value = new Set(set);

  if (!historyByName.value[name] && !historyMetaByName.value[name]?.loading) {
    historyMetaByName.value = {
      ...historyMetaByName.value,
      [name]: { loading: true, error: '' }
    };
    try {
      const r = await packagesApi.history(name);
      const items = Array.isArray(r.data?.items) ? r.data.items : [];
      historyByName.value = { ...historyByName.value, [name]: items };
      historyMetaByName.value = {
        ...historyMetaByName.value,
        [name]: { loading: false, error: '' }
      };
    } catch (e) {
      historyMetaByName.value = {
        ...historyMetaByName.value,
        [name]: { loading: false, error: e?.response?.data?.error || '加载历史失败' }
      };
    }
  }
}

function openUpload() { showUpload.value = true; }
function openEditScript(it) { editingScript.value = it; viewingScript.value = false; }
// R67-T1 — view-only entry point. Same modal, but viewMode=true triggers
// the GET /api/admin/packages/:name/script auto-fetch + readonly render.
function openViewScript(it) { editingScript.value = it; viewingScript.value = true; }
function closeScriptModal() { editingScript.value = null; viewingScript.value = false; }
function openEditPolicy(it) { editingPolicy.value = it; }

async function toggleEnabled(it) {
  error.value = '';
  try {
    if (it.enabled) await packagesApi.disable(it.name);
    else await packagesApi.enable(it.name);
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || '操作失败';
  }
}

async function confirmDelete(it) {
  if (!window.confirm(`确认删除脚本 ${it.name}?该操作不可恢复。`)) return;
  error.value = '';
  try {
    await packagesApi.deleteScript(it.name);
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || '删除失败';
  }
}

function fmt(s) {
  if (!s) return '—';
  return formatDateTime(s, { fallback: String(s) });
}

// 包类型 / 包来源 — 后端返回的英文枚举值翻译成中文.
// 名称列原本有一处旁路标签 (v-if="it.source === 'builtin-seed'") 渲染
// "内置",现在统一切到 sourceLabel,确保 admin-upload / 后续新枚举值也
// 有中文展示。fallback 走原文 + 圆括号,新值出现不空白。
const TYPE_LABEL = {
  gauge: '指标',
  counter: '计数器',
  status: '状态',
  timeseries: '时序'
};
function typeLabel(t) {
  if (t == null || t === '') return '—';
  return TYPE_LABEL[t] || `${t}`;
}
const SOURCE_LABEL = {
  'builtin-seed': '内置',
  'admin-upload': '后台上传'
};
function sourceLabel(s) {
  if (s == null || s === '') return '—';
  return SOURCE_LABEL[s] || `${s}`;
}

// R158.60.4 — 表里是否有任何 on-demand 包, 用来控制 th + td 的 v-if.
// 没 on-demand 包时整列消失, colspan / 列宽都按 10 列走, 旧 colspan=10 命中.
const hasAnyOndemand = computed(() => items.value.some(it => isOndemand(it.name)));

// R158.60.4 — summary24h → 状态色 / 文字 / 时间
function lastRunClass(s) {
  if (!s) return 'unknown';
  if (s.failure > 0 && s.success === 0) return 'failed';
  if (s.failure > 0) return 'partial';
  if (s.success > 0) return 'success';
  return 'idle';
}
function lastRunLabel(s) {
  if (!s || s.total === 0) return '未执行';
  const c = lastRunClass(s);
  return c === 'success' ? '成功'
    : c === 'partial'  ? '部分失败'
    : c === 'failed'   ? '失败'
    : '未执行';
}
function lastRunTime(s) {
  if (!s?.lastRunAt) return '—';
  return formatDateTime(s.lastRunAt);
}

// R158.60.4 — recent[] 单行 → 状态色 / 文字 (PackageRunsMonitorView 风格)
function runRowClass(r) {
  if (r.status === 'success') return 'success';
  if (r.status === 'failed')  return 'failed';
  if (r.status === 'partial') return 'partial';
  if (r.status === 'running') return 'running';
  return 'unknown';
}
function runRowLabel(r) {
  const c = runRowClass(r);
  return { success: '成功', failed: '失败', partial: '部分', running: '执行中', unknown: '—' }[c];
}

onMounted(() => {
  refresh();
  // R158.60.4 — 30s 轮询, on-demand 触发完成后 ≤ 30s 看到状态刷新.
  pollTimer = setInterval(refresh, POLL_MS);
});

onUnmounted(() => {
  // R158.60.4 — 离开 /admin/packages 路由时清掉轮询 timer, 避免 NSSM
  // node 进程里残留 setInterval 句柄 (后续回到路由 onMounted 会重建).
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<style scoped>
/* ===== Page header ===================================================== */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 24px; margin-bottom: 18px; padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase;
}
.page-title {
  margin: 0; font-size: 20px; font-weight: 600; color: var(--text);
  letter-spacing: -0.01em;
}
.subtitle { margin: 0; font-size: 13px; color: var(--muted); }
.page-meta { display: flex; gap: 8px; align-items: center; }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer;
  font-size: 13px; border: 1px solid var(--border);
}
.btn-primary {
  background: var(--accent); color: var(--sidebar-bg); border-color: var(--accent); font-weight: 600;
}
.btn-secondary { background: var(--sidebar-bg); color: var(--text); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Error / empty states ============================================ */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); font-size: 13px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 48px 16px; font-size: 13px;
  background: var(--panel); border: 1px dashed var(--border); border-radius: 4px;
}

/* ===== Table =========================================================== */
/* R152 — table-layout: fixed + min-width on the table makes the row
   stay on a single line and overflows horizontally instead of
   wrapping cells. Page wrapper keeps overflow-x: auto so the scrollbar
   appears at the page edge, not inside the table. */
.t {
  width: 100%; min-width: 1360px;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel); border: 1px solid var(--border); border-radius: 4px;
}
.t th, .t td {
  padding: 11px 14px; text-align: left; font-size: 14px;
  color: var(--text); vertical-align: middle;
  border-top: 1px solid rgba(51, 65, 85, 0.4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.t tbody tr:first-child td { border-top: 0; }
.t th {
  background: var(--panel-alt); color: var(--muted);
  font-size: 11px; font-weight: 600; letter-spacing: 0.10em;
  text-transform: uppercase; padding: 10px 14px; border-top: 0;
  font-family: ui-monospace, monospace;
}
.t th.num, .t td.num { text-align: right; font-feature-settings: "tnum"; }
/* Column widths — fixed-layout so the operator gets a deterministic
   layout regardless of content. Total ~1140px; narrow viewports get
   a page-level horizontal scroll via .t-wrap. */
.t th:nth-child(1), .t td.expand-cell { width: 36px; padding: 6px 8px; }
.t th:nth-child(2), .t td.name-cell   { width: 260px; }
.t th:nth-child(3), .t td:nth-child(3) { width: 90px; }
.t th:nth-child(4), .t td:nth-child(4) { width: 80px; }
.t th:nth-child(5), .t td:nth-child(5) { width: 80px; }
.t th:nth-child(6), .t td:nth-child(6) { width: 80px; }
.t th:nth-child(7), .t td:nth-child(7) { width: 90px; }
.t th:nth-child(8), .t td:nth-child(8) { width: 110px; }
.t th:nth-child(9), .t td:nth-child(9) { width: 140px; }    /* 最后修改 */
.t th.run-col-head, .t td.run-cell    { width: 240px; }    /* R158.60.4 — 执行状态 */
.t th.actions-col, .t td.row-actions  { width: 160px; }

/* Row hover: 2px left rail tint (R49 vocabulary). The default tint is
   accent so enabled rows still feel "active" on hover, with no other
   state-driven color to avoid clashing with status pills. */
.script-row td:first-child {
  border-left: 2px solid transparent;
  padding-left: 10px;
}
.script-row:hover td:first-child { border-left-color: var(--accent); }

/* Name + built-in badge in the first column */
.name-cell { display: flex; align-items: center; gap: 8px; }
.name { font-weight: 500; }
.source-tag.builtin {
  font-size: 9px; padding: 1px 5px; border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

/* Metric type tag */
.type-tag {
  font-size: 11px; padding: 3px 9px; border-radius: 3px;
  font-family: ui-monospace, monospace; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.type-gauge     { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 30%, transparent); }
.type-counter   { background: color-mix(in srgb, var(--yellow) 10%, transparent); color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 30%, transparent); }
.type-status    { background: var(--chip-purple-bg); color: var(--chip-purple-fg); border: 1px solid var(--chip-purple-border); }
.type-timeseries{ background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }

/* Status pill — R49 3-color (green on, gray off) */
.status-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; padding: 3px 10px; border-radius: 3px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; }
.status-pill.ok   { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 30%, transparent); }
.status-pill.ok .dot   { background: var(--green); }
.status-pill.off  { background: var(--panel-alt); color: var(--muted); border: 1px solid var(--border); }
.status-pill.off .dot  { background: var(--muted); }

/* Code-style cells */
.version, .source {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; background: var(--panel-alt);
  padding: 2px 8px; border-radius: 3px; border: 1px solid var(--border);
  color: var(--text);
}
.source { color: var(--muted); }

/* Row action buttons — R152 icon-only. Title (tooltip) carries the
   human label; glyph stays compact so all 5 fit in the 160px column. */
.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.row-actions .icon-btn {
  width: 28px; height: 28px; padding: 0; line-height: 1;
  font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--panel-alt); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  cursor: pointer; font-family: inherit;
}
.row-actions .icon-btn:hover { background: var(--bg); border-color: var(--accent); color: var(--accent); }
.row-actions .icon-btn.danger:hover { background: color-mix(in srgb, var(--red) 10%, transparent); border-color: var(--red); color: var(--red); }

/* R152 — page-edge horizontal scroll instead of cell wrapping.
   .t-wrap sits above the .t table and owns the scroll context so the
   bar appears below the page header, not inside the table border. */
.t-wrap { overflow-x: auto; border-radius: 4px; }

/* ===== R152 — Fold-out version history ================================= */
/* Expand triangle column. Triangle rotates from ▶ to ▼ via JS string
   swap (no CSS rotation needed — keeps the layout predictable across
   fonts and locales). */
.expand-cell { width: 36px; padding: 6px 8px; text-align: center; }
.expand-btn {
  background: transparent; border: 0; cursor: pointer; padding: 0;
  font-size: 14px; color: var(--muted); line-height: 1;
  width: 26px; height: 26px; border-radius: 3px;
}
.expand-btn:hover { background: var(--panel-alt); color: var(--accent); }
/* When the row is expanded we tint the triangle cell so the operator
   knows "this is the one whose history is open". */
.script-row.expanded .expand-btn { color: var(--accent); }

/* History badge next to the name — "历史 N" */
.history-badge {
  font-size: 10px; padding: 2px 7px; border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  letter-spacing: 0.06em; font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  font-family: ui-monospace, monospace;
}

/* History subrow: full-width (colspan 10), indented slightly. Background
   is panel-alt to visually separate from the parent row. */
.history-row td.history-cell {
  background: var(--panel-alt);
  padding: 14px 18px 16px 44px;
  border-top: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
}
.history-loading, .history-empty, .history-error {
  font-size: 13px; color: var(--muted); padding: 6px 0;
}
.history-error { color: var(--red); }

/* Inner history table — same column rhythm as the outer table but with
   fewer columns. Compact padding to keep the fold-out readable without
   dominating the page. */
.history-t {
  width: 100%; border-collapse: collapse;
  background: var(--panel); border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.history-t th, .history-t td {
  padding: 9px 14px; font-size: 13px; text-align: left;
  border-top: 1px solid var(--border);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-t tbody tr:first-child td { border-top: 0; }
.history-t th {
  background: var(--panel-alt); color: var(--muted);
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; font-family: ui-monospace, monospace;
}
.history-t .sha { font-size: 11px; }
.history-t .history-current {
  background: color-mix(in srgb, var(--green) 6%, transparent);
}
.current-tag {
  font-size: 10px; padding: 2px 8px; border-radius: 3px;
  background: color-mix(in srgb, var(--green) 14%, transparent);
  color: var(--green);
  letter-spacing: 0.08em; font-weight: 700; text-transform: uppercase;
  border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
  font-family: ui-monospace, monospace;
}
.older-tag {
  font-size: 10px; padding: 2px 8px; border-radius: 3px;
  background: var(--panel-alt); color: var(--muted);
  letter-spacing: 0.08em; font-weight: 600; text-transform: uppercase;
  border: 1px solid var(--border);
  font-family: ui-monospace, monospace;
}

/* ===== R158.60.4 — on-demand 包标识 + 执行状态列 ======================
   R158.60.6 (operator "badge 是圆形 On-demand 徽章") — 改成 border-radius
   9999px 完全圆胶囊, 跟历史 history-badge (方形) 区分. */
.ondemand-badge {
  font-size: 9px; padding: 1px 9px; border-radius: 9999px;
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--yellow);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 800;
  border: 1px solid color-mix(in srgb, var(--yellow) 38%, transparent);
  font-family: ui-monospace, monospace;
}

/* Run pill — 跟 R49 status-pill 视觉一致, 3 色 + 1 running/idle */
.run-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 3px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.run-pill .dot { width: 5px; height: 5px; border-radius: 50%; }
.run-success { background: color-mix(in srgb, var(--green)  12%, transparent); color: var(--green);  border: 1px solid color-mix(in srgb, var(--green)  30%, transparent); }
.run-success .dot { background: var(--green); }
.run-failed  { background: color-mix(in srgb, var(--red)    12%, transparent); color: var(--red);    border: 1px solid color-mix(in srgb, var(--red)    30%, transparent); }
.run-failed .dot  { background: var(--red); }
.run-partial { background: color-mix(in srgb, var(--yellow) 12%, transparent); color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 30%, transparent); }
.run-partial .dot { background: var(--yellow); }
.run-running { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
.run-running .dot { background: var(--accent); }
.run-unknown, .run-idle { background: var(--panel-alt); color: var(--muted); border: 1px solid var(--border); }
.run-unknown .dot, .run-idle .dot { background: var(--muted); }

.run-time {
  font-size: 11px; color: var(--muted);
  margin-left: 6px;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
}
.run-skel, .run-empty { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
.run-err  { color: var(--red);   font-size: 11px; font-family: ui-monospace, monospace; }

/* R158.60.6 — 4 个 on-demand 包永久 "On-demand" 标签 + pill+时间 (24h 触发后)
   并列. 同 ondemand-badge 黄色配色, 跟 pill 用 gap 隔开. operator 反馈
   "badge 应该是圆形" (feedback 2026-10-09 5th iter). 改成 border-radius 9999px
   完全圆胶囊. */
.run-ondemand-tag {
  display: inline-block;
  padding: 1px 9px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--yellow);
  border: 1px solid color-mix(in srgb, var(--yellow) 38%, transparent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-family: ui-monospace, monospace;
  margin-right: 6px;
  line-height: 1.4;
}

.run-cell { white-space: nowrap; }

/* On-demand recent 折叠 — 复用 .history-cell + .history-t 视觉 */
.ondemand-recent-title {
  font-size: 11px; font-weight: 600; color: var(--muted);
  letter-spacing: 0.10em; text-transform: uppercase;
  margin: 0 0 8px 0; padding: 0;
}
.ondemand-recent-t .agent-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.ondemand-recent-t .err-cell { max-width: 360px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 11px; }
.ondemand-recent-t tr.recent-failed td.err-cell { color: var(--red); }
</style>
