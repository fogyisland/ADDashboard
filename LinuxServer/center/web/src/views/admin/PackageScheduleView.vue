<!--
  R158 (2026-09-30) — 包执行计划 (PackageScheduleView)
  R158.X.99.6 (2026-10-15) — 整行点击 → 右侧 drawer 显示该包最近执行结果

  Operator directive (2026-09-30):
  "修复啊，不然他不动我们就没办法看到结果，然后在后台，列出一个页面，
   按AD 执行计划包，这样可以让Agent 能够执行对应的计划效果，最迟延迟一分钟，
   可以手动出发包的执行"

  R158.X.99.6 operator follow-up (2026-10-15):
  "点击包后弹出右边框，显示所有的包执行结果" + 抽屉内同入口"再触发一次"

  What this page does:
   - lists every installed package (same /api/admin/packages source as
     PackagesView) plus its 24h execution summary from
     /api/dashboard/packages-runs (cross-pack run count + last run time).
   - one-click "立即触发" button per row that POSTs
     /api/admin/packages/:name/trigger-once. Backend (services/trigger-
     queue.js + cron-scheduler.fireTriggers) writes a pending_trigger
     row; every agent picks it up on its next heartbeat (≤ 60s latency,
     capped by R157's 60s heartbeat interval).
   - 30s polling on the run-health table so the operator can confirm
     "yes, the trigger landed in package_runs" within a refresh window.
     Without polling this page would feel inert — the manual click is
     the only non-trivial action, and the operator needs visual
     confirmation that the trigger reached the centre + agents.
   - click row → right-side drawer with the per-agent recent run rows
     for this package. Data comes from the same packages[].recent[] we
     already fetch (R67-T2 PackageRunsMonitorView contract) — no new
     endpoint. Drawer footer also carries a "再触发一次" button routed
     to the same trigger-now handler as the row button.

  Data sources (two read paths):
    GET /api/admin/packages          → items[] (the existing list view)
    GET /api/dashboard/packages-runs → packages[] with per-package 24h
                                      summary + recent runs table
    POST /api/admin/packages/:name/trigger-once  → manual trigger
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">运维管理 · 执行计划</div>
        <h2 class="page-title">包执行计划</h2>
        <p class="subtitle">
          查看每台服务器上每个包的运行节奏;
          单次触发后, 60 秒内由该服务器在下一次心跳时取走触发指令并执行。
        </p>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
        <router-link class="btn-secondary" to="/admin/packages">← 返回包管理</router-link>
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>
    <div v-if="triggerOk" class="ok-banner" data-test="trigger-ok-banner">
      ✓ {{ triggerOk }}
    </div>

    <div v-if="!items.length && !error" class="empty" data-test="empty">
      暂无已安装的包 — 请在 /admin/packages 上传脚本
    </div>

    <!-- R158.X.99.16 (2026-10-18) — AD / MemberServer 分两段展示.
         1:1 平行 PackagesView.vue adItems/noAdItems 设计. 顺序 AD 在前
         (R66 T10 原生 AD-first 习惯), MemberServer 在后. 顶部 0 segment
         切换, 1:1 平行 R158.77.2 sidebar 精简 precedent. -->
    <div v-if="adRows.length" class="fleet-section" data-test="fleet-section-ad">
      <h3 class="fleet-section-title">AD 域控 ({{ adRows.length }})</h3>
    <div class="t-wrap">
      <table class="t" data-test="schedule-table">
        <thead>
          <tr>
            <th>包名</th>
            <th>启用</th>
            <th class="num">间隔（秒）</th>
            <th>近 24 小时成功/失败</th>
            <th>最近触发</th>
            <th>最近一次采集</th>
            <th>上次触发完成</th>
            <th class="actions-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in adRows"
            :key="row.name"
            class="script-row"
            :class="{ 'is-selected': selectedName === row.name }"
            :data-test="`row-${row.name}`"
            @click="openDrawer(row.name)"
          >
            <td class="col-name">
              <span class="pkg-label">{{ row.label }}</span>
              <span class="pkg-name-zh">{{ row.name }}</span>
              <span class="pkg-cadence">⏱ {{ row.cadence }}</span>
              <span class="pkg-version">v{{ row.version || '—' }}</span>
            </td>
            <td>
              <span :class="['pill', row.enabled ? 'pill-ok' : 'pill-off']" :data-test="`enabled-${row.name}`">
                {{ row.enabled ? '已启用' : '已禁用' }}
              </span>
            </td>
            <td class="num">{{ row.intervalSec ?? '—' }}</td>
            <td>
              <span class="counts">
                <span class="count-ok">{{ row.summary.success }}</span>
                <span class="count-sep">/</span>
                <span class="count-fail">{{ row.summary.failure }}</span>
              </span>
            </td>
            <td>{{ row.lastRunAt ? fmt(row.lastRunAt) : '— 暂无执行' }}</td>
            <td>
              <span v-if="row.lastEtl" class="etl-summary" :data-test="`etl-${row.name}`">
                {{ row.lastEtl }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td :data-test="`triggered-col-${row.name}`">
              <span v-if="row.lastTriggered" class="triggered-pill" :class="triggeredPillClass(row.lastTriggered)">
                <!-- R158.X.99.21 (2026-10-18) — 操作员 directive "在包执行计划
                     写上 trigger once, 如果是 schedule 则写上 schedule". 加
                     模式 pill: trigger once (蓝) / schedule (灰). -->
                <span class="triggered-mode" :class="row.lastTriggered.triggerOnce ? 'mode-trigger' : 'mode-schedule'">
                  {{ row.lastTriggered.triggerOnce ? '单次触发' : '定时触发' }}
                </span>
                <span class="triggered-at">{{ fmt(row.lastTriggered.lastTriggeredAt) }}</span>
                <span class="triggered-counts" :data-test="`triggered-counts-${row.name}`">
                  {{ row.lastTriggered.completion.success }}/{{ row.lastTriggered.completion.total }}
                </span>
              </span>
              <span v-else class="muted" :data-test="`triggered-empty-${row.name}`">—</span>
            </td>
            <td class="actions-col" @click.stop>
              <button
                class="btn-primary btn-sm"
                :data-test="`trigger-${row.name}`"
                :disabled="triggering[row.name]"
                @click="openTriggerModal(row.name)"
              >
                {{ triggering[row.name] ? '触发中…' : '▶ 单次触发' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </div>
    <!-- R158.X.99.16 (2026-10-18) — MemberServer (NoAD) 段. 跟 AD 段
         1:1 平行, 同一组件同一模板, 仅数据源切到 noAdRows. -->
    <div v-if="noAdRows.length" class="fleet-section" data-test="fleet-section-noad">
      <h3 class="fleet-section-title">成员服务器 ({{ noAdRows.length }})</h3>
    <div class="t-wrap">
      <table class="t" data-test="schedule-table-noad">
        <thead>
          <tr>
            <th>包名</th>
            <th>启用</th>
            <th class="num">间隔（秒）</th>
            <th>近 24 小时成功/失败</th>
            <th>最近触发</th>
            <th>最近一次采集</th>
            <th>上次触发完成</th>
            <th class="actions-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in noAdRows"
            :key="row.name"
            class="script-row"
            :class="{ 'is-selected': selectedName === row.name }"
            :data-test="`row-${row.name}`"
            @click="openDrawer(row.name)"
          >
            <td class="col-name">
              <span class="pkg-label">{{ row.label }}</span>
              <span class="pkg-name-zh">{{ row.name }}</span>
              <span class="pkg-cadence">⏱ {{ row.cadence }}</span>
              <span class="pkg-version">v{{ row.version || '—' }}</span>
            </td>
            <td>
              <span :class="['pill', row.enabled ? 'pill-ok' : 'pill-off']" :data-test="`enabled-${row.name}`">
                {{ row.enabled ? '已启用' : '已禁用' }}
              </span>
            </td>
            <td class="num">{{ row.intervalSec ?? '—' }}</td>
            <td>
              <span class="counts">
                <span class="count-ok">{{ row.summary.success }}</span>
                <span class="count-sep">/</span>
                <span class="count-fail">{{ row.summary.failure }}</span>
              </span>
            </td>
            <td>{{ row.lastRunAt ? fmt(row.lastRunAt) : '— 暂无执行' }}</td>
            <td>
              <span v-if="row.lastEtl" class="etl-summary" :data-test="`etl-${row.name}`">
                {{ row.lastEtl }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td :data-test="`triggered-col-${row.name}`">
              <span v-if="row.lastTriggered" class="triggered-pill" :class="triggeredPillClass(row.lastTriggered)">
                <!-- R158.X.99.21 (2026-10-18) — 1:1 平行 AD 段, 模式 pill 同逻辑. -->
                <span class="triggered-mode" :class="row.lastTriggered.triggerOnce ? 'mode-trigger' : 'mode-schedule'">
                  {{ row.lastTriggered.triggerOnce ? '单次触发' : '定时触发' }}
                </span>
                <span class="triggered-at">{{ fmt(row.lastTriggered.lastTriggeredAt) }}</span>
                <span class="triggered-counts" :data-test="`triggered-counts-${row.name}`">
                  {{ row.lastTriggered.completion.success }}/{{ row.lastTriggered.completion.total }}
                </span>
              </span>
              <span v-else class="muted" :data-test="`triggered-empty-${row.name}`">—</span>
            </td>
            <td class="actions-col" @click.stop>
              <button
                class="btn-primary btn-sm"
                :data-test="`trigger-${row.name}`"
                :disabled="triggering[row.name]"
                @click="openTriggerModal(row.name)"
              >
                {{ triggering[row.name] ? '触发中…' : '▶ 单次触发' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </div>

    <div v-if="recentTriggers.length" class="recent-triggers" data-test="recent-triggers">
      <h3 class="recent-title">本页触发记录</h3>
      <table class="t recent-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>包名</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(t, i) in recentTriggers" :key="i" :data-test="`recent-trigger-${i}`">
            <td>{{ fmt(t.at) }}</td>
            <td>{{ t.name }}</td>
            <td>
              <span :class="['pill', t.ok ? 'pill-ok' : 'pill-fail']">
                {{ t.ok ? '已入队' : (t.error || '失败') }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- R158.X.99.6 — right-side drawer -->
    <transition name="drawer-slide">
      <aside
        v-if="drawerOpen && drawerRow"
        class="drawer"
        :data-test="`drawer-${drawerRow.name}`"
        role="complementary"
        aria-label="包执行明细"
        @click.stop
      >
        <header class="drawer-header">
          <div class="drawer-title-wrap">
            <div class="drawer-eyebrow">{{ drawerRow.summary.success + drawerRow.summary.failure }} 条记录 · 近 24 小时</div>
            <h3 class="drawer-title">{{ drawerRow.label || drawerRow.name }}</h3>
            <span class="drawer-sub">v{{ drawerRow.version || '—' }} · {{ drawerRow.cadence || `间隔 ${drawerRow.intervalSec ?? '—'} 秒` }}</span>
          </div>
          <button class="drawer-close" data-test="drawer-close" aria-label="关闭" @click="closeDrawer">×</button>
        </header>

        <div class="drawer-stats">
          <span class="stat-ok">{{ drawerRow.summary.success }} 成功</span>
          <span class="stat-fail" v-if="drawerRow.summary.failure">{{ drawerRow.summary.failure }} 失败</span>
          <span class="stat-muted" v-else>0 失败</span>
        </div>

        <div class="drawer-table-wrap">
          <table class="t drawer-table" data-test="drawer-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>执行方</th>
                <th>状态</th>
                <th class="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!drawerRows.length">
                <td colspan="4" class="muted center">该包暂无历史执行记录</td>
              </tr>
              <tr
                v-for="(r, i) in drawerRows"
                :key="i"
                :class="{ 'row-fail': isFailRow(r) }"
                :data-test="`drawer-row-${i}`"
              >
                <td class="num ts">{{ fmt(r.startedAt) }}</td>
                <td class="agent" :title="r.agentId || ''">{{ r.agentId || '—' }}</td>
                <td>
                  <span :class="['pill', pillClass(r)]" :data-test="`drawer-pill-${i}`">
                    {{ statusLabel(r) }}
                  </span>
                </td>
                <td class="num">{{ r.durationMs != null ? `${r.durationMs}ms` : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="drawer-footer">
          <button
            class="btn-primary btn-sm"
            data-test="drawer-trigger"
            :disabled="drawerTriggering"
            @click="openTriggerModal(drawerRow.name)"
          >
            {{ drawerTriggering ? '触发中…' : '▶ 再触发一次' }}
          </button>
          <button class="btn-secondary btn-sm" @click="closeDrawer">关闭</button>
        </footer>
      </aside>
    </transition>
    <div v-if="drawerOpen" class="drawer-scrim" @click="closeDrawer" data-test="drawer-scrim"></div>

    <!-- R158.X.99.20 (2026-10-18) — "单次触发" 弹窗. 操作员多选 DC subset,
         透传 targetDcs 给后端 trigger-now 端点. 0 引 element-plus (R158.111 锁),
         纯 div + checkbox 实现. 跟既有 drawer 1:1 平行 (scrim + 居中浮层). -->
    <div v-if="modalOpen" class="modal-scrim" @click="closeTriggerModal" data-test="trigger-modal-scrim">
      <div class="modal" @click.stop role="dialog" aria-label="选择目标 DC" data-test="trigger-modal">
        <header class="modal-header">
          <div>
            <div class="modal-eyebrow">单次触发 — 选择目标 DC</div>
            <h3 class="modal-title">{{ modalPkgName }}</h3>
            <p class="modal-sub">
              留空 = 全部已启用的域控都会收到 (默认行为); 勾选 = 仅发到所选域控, 其余域控不会收到.
            </p>
          </div>
          <button class="drawer-close" data-test="modal-close" aria-label="关闭" @click="closeTriggerModal">×</button>
        </header>

        <div class="modal-body">
          <div class="modal-toolbar">
            <span class="modal-count" data-test="modal-count">
              已选 {{ selectedDcs.size }} / {{ dcList.length }} 台
            </span>
            <div class="modal-toolbar-btns">
              <button class="btn-secondary btn-sm" data-test="modal-select-all" :disabled="dcLoading || !dcList.length" @click="selectAllDcs">全选</button>
              <button class="btn-secondary btn-sm" data-test="modal-clear-all" :disabled="!selectedDcs.size" @click="clearAllDcs">全不选</button>
            </div>
          </div>

          <div v-if="dcLoading" class="modal-empty" data-test="modal-loading">DC 列表加载中…</div>
          <div v-else-if="dcLoadError" class="modal-empty modal-error" data-test="modal-error">{{ dcLoadError }}</div>
          <div v-else-if="!dcList.length" class="modal-empty" data-test="modal-empty">没有可用的 DC 记录</div>
          <div v-else class="dc-list" data-test="dc-list">
            <label
              v-for="dc in dcList"
              :key="dc.dcName"
              class="dc-item"
              :class="{ 'is-checked': selectedDcs.has(dc.dcName) }"
              :data-test="`dc-${dc.dcName}`"
            >
              <input
                type="checkbox"
                :checked="selectedDcs.has(dc.dcName)"
                :data-test="`dc-cb-${dc.dcName}`"
                @change="toggleDc(dc.dcName)"
              />
              <span class="dc-name">{{ dc.dcName }}</span>
              <span class="dc-flags">
                <span v-if="dc.isPdc" class="dc-flag dc-flag-pdc">PDC</span>
                <span v-if="dc.isGc" class="dc-flag dc-flag-gc">GC</span>
              </span>
            </label>
          </div>
        </div>

        <footer class="modal-footer">
          <button class="btn-secondary btn-sm" data-test="modal-cancel" @click="closeTriggerModal">取消</button>
          <button
            class="btn-primary btn-sm"
            data-test="modal-confirm"
            :disabled="triggering[modalPkgName]"
            @click="confirmTrigger"
          >
            {{ triggering[modalPkgName] ? '触发中…' : (selectedDcs.size > 0 ? `触发 ${selectedDcs.size} 台` : '触发全部 DC') }}
          </button>
        </footer>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { packagesApi } from '../../api/packages.js';
import { dashboardApi } from '../../api/dashboard.js';
// R158.X.99.20 (2026-10-18) — 单次触发弹窗用 dcs-catalog 拉 DC 列表.
// 复用 src/api/admin.js listDcsCatalog (1:1 平行 DcsCatalogView/FilePushView precedent).
import { adminApi } from '../../api/admin.js';

// R158.72.x.6 (2026-10-16) — PackageScheduleView 中文化 + 运行节奏说明.
//   操作员 directive: "完成包的内容中文化, 不要大段看不懂的语言, 用口语化的语言
//   写入内容, 另外加入执行周期说明".
//   0 改后端 / 0 改 manifest / 0 改 agent. 纯前端展示增强.
//   cadence 字段来源: 5 老包是 self-setInterval 节奏, ad_account_change 是
//   R158.72.x.5 ship 后的中心端 cron + Jitter 0~30min, 3 on-demand 走
//   R158.60.10 schedule-suppression signal.
const PACKAGE_DISPLAY = {
  ad_account_change: {
    label: '账户变更记录',
    description: '记录 AD 账户每天的创建、修改、删除、启用、禁用、解锁。',
    // R158.X.99.18.c (2026-10-18) — 操作员 directive "默认走计划方向, 后台能够走单次执行路线".
    //   1:1 平行 ad_admin_members R158.72.x.15 1.0.2 ship 范式: 每天凌晨 2 点中心端定时 + Jitter 0~30min
    //   per-DC, 后台"单次触发"按钮可临时手动 1-click (triggerOnce 端点 wire).
    //   改 0 写 "33 台" DC 台数 (操作员 2026-10-18 directive 锁 0 写 DC 台数, 通用说法).
    cadence: '每天凌晨 2 点由中心端统一定时触发, 各域控在 0~30 分钟内错开执行, 避免同时冲击域控。也可点击「单次触发」立即手动执行一次。'
  },
  ad_admin_members: {
    label: '管理员组成员',
    description: '列出所有域管理员和企业管理员组成员。变更不频繁, 每 24 小时采集一次。',
    // R158.72.x.15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC, 1:1 平行 R158.72.x.13 6 包范式
    //   (操作员 directive 锁 "定义2点触发"). 老 '每 24 小时跑一次 (凌晨随机时段)' 是 R158.95 ship 完 setInterval 86400 范式描述,
    //   跟 aac / apid / ad_lockout_summary / ad_lockout_list / ad_failed_logon_collector / ad_dc_probe_inbound / ad_os_baseline 1:1 平行.
    cadence: '每天凌晨 2 点由中心端统一定时触发, 各域控在 0~30 分钟内错开执行, 避免同时冲击域控。'
  },
  ad_eventlog_collector: {
    // R158.72.x.14 (2026-10-17) — 操作员 directive 锁 "ad_eventlog_collector 改 2 小时执行一次" (之前 5min 1 拍错).
    //   cronExpr='0 */2 * * *' (12 拍/天) + Jitter 0~5min per-DC. 1:1 平行 R158.72.x.13 6 包范式 + R158.72.x.6 cadence 描述.
    //   0 改后端 / 0 改 manifest / 0 改 agent binary (0.1.7 已吃 */N step form via cron-parser.js).
    label: '事件日志汇总 (系统 / 应用程序 / AD Web 服务 / 文件系统复制)',
    description: '域控 4 个事件日志通道 (系统、应用程序、AD Web 服务、分布式文件系统复制) 的告警与错误汇总及明细, 保留 24 小时。',
    cadence: '每 2 小时自动执行一次 (一天共 12 次), 各域控在 0~5 分钟内错开执行。'
  },
  ad_lockout_list: {
    label: '账户锁定列表',
    description: '采集 AD 中被锁定的账户、解锁事件以及登录失败事件 (安全事件 4625), 按域汇总。',
    // R158.72.x.13 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 15 分钟' 是 R158.72.x.6 ship 时 setInterval 900s 范式描述).
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). 跟 R158.72.x.16 ad_dc_probe_inbound 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_lockout_summary: {
    // R158.72.x.13 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (前端 dict 缺此条, R158.72.x.6 ship 漏加, 1:1 平行 R158.72.x.14 aelc 1:1 修).
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). 跟 R158.72.x.16 ad_dc_probe_inbound 1:1 平行.
    label: '账户锁定汇总',
    description: '账户锁定事件按域 + 小时的汇总指标.',
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_failed_logon_collector: {
    label: '失败登录采集',
    description: '从域控安全日志中采集登录失败与登录成功事件 (安全事件 4625 / 4624), 写入集中表。',
    // R158.72.x.13 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 15 分钟' 是 R158.72.x.6 ship 时 setInterval 900s 范式描述).
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式, 跟 R158.58 window 900s 1:1 平行). 跟 R158.72.x.16 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。采集数据保留 7 天, 之后自动清理。'
  },
  ad_dc_probe_inbound: {
    // R158.72.x.16 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). R158.72.x.13
    //   误把本包入 6 daily 2:00 跟其它 5 包 1:1 平行, 但 ad_dc_probe_inbound 实际是 TCP
    //   端口健康探针, 高频语义 (R155.3 原始 setInterval 900s 1:1 平行保留). 中心端
    //   cron 0 fire, 走 R158.60.10 第 1 idiom agent 端 self-setInterval 900s 1:1 平行.
    label: 'DC 入站复制端口探活',
    description: '探测其他域控的入站复制端口是否可达, 维护域间复制健康状态。',
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_os_baseline: {
    label: 'OS 基线指标',
    description: '采集域控的 CPU、内存、磁盘、网络等基础运行指标, 用于性能面板。',
    // R158.72.x.13 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 1 分钟' 是 R158.72.x.6 ship 时 setInterval 60s 范式描述).
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (操作员 directive 锁跟 3 锁包 1:1 平行). 跟 R158.72.x.16 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_partner_inbound_discover: {
    label: '伙伴域发现',
    description: '扫描林里其它域的域控 + 端口, 维护域间复制拓扑.',
    // R158.X.99.11 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 5 分钟 (R159 后中心端 cron 调度)' 是 R157.4 ship 时 setInterval 300s 范式描述, 但 R158.X.99.11 已切 cronExpr='0 2 * * *' daily 2:00).
    cadence: '每天凌晨 2 点由中心端统一定时触发, 各域控在 0~30 分钟内错开执行, 避免同时冲击域控。'
  },
  ad_ad_groups_write: {
    label: 'AD 组写入 (按需触发)',
    description: '手动写入 AD 组, 不自动执行, 仅在点击「单次触发」按钮时运行。',
    cadence: '不自动执行, 只在点击「单次触发」时运行。'
  },
  ad_ad_users_write: {
    label: 'AD 用户写入 (按需触发)',
    description: '手动写入 AD 用户, 不自动执行。',
    cadence: '不自动执行, 只在点击「单次触发」时运行。'
  },
  ad_ad_account_quickfix: {
    label: 'AD 账户快捷修复 (按需触发)',
    description: '解锁、重置密码、启用等快捷操作, 不自动执行。',
    cadence: '不自动执行, 只在点击「单次触发」时运行。'
  }
};

function displayFor(name) {
  return PACKAGE_DISPLAY[name] || {
    label: name,
    description: '自定义脚本包, 说明由包配置文件维护。',
    cadence: name === 'ad_account_change'
      ? '每天凌晨 2 点 + 0~30min 错峰'
      : '由执行计划的「间隔（秒）」列决定。'
  };
}

const items = ref([]);

// R158.X.99.16 (2026-10-18) — 按 agentType 切 AD / MemberServer 两组.
// 1:1 平行 PackagesView.vue adItems/noAdItems computed, 1:1 平行
// member-servers-public.js:664-669 filter (R158.92 dashboard 反向 filter
// 1:1 平行).
const adRows = computed(() => {
  return items.value
    .filter((it) => (it.agentType || 'ad') === 'ad')
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
});
const noAdRows = computed(() => {
  return items.value
    .filter((it) => (it.agentType || 'ad') === 'non-ad' && !String(it.name || '').startsWith('ad_'))
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
});
const error = ref('');
const loading = ref(false);
const lastLoadedAt = ref(null);
const polling = ref(false);
const triggering = ref({});
const triggerOk = ref('');
// R158.X.99.7 follow-up — persist trigger history across F5.
// localStorage-only, in-view, single key, 0 backend / 0 endpoint / 0 schema
// change. Mirrors D:\dashboard\center\web\src\composables\useTheme.js:16-28
// pattern (STORAGE_KEY + typeof localStorage guard). `RECENT_TRIGGERS_MAX`
// is the single source of truth for both the in-memory cap and the
// persisted cap.
const RECENT_TRIGGERS_KEY = 'pkg-schedule-recent-triggers';
const RECENT_TRIGGERS_MAX = 10;

function loadRecentTriggers() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_TRIGGERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.name === 'string' && typeof r.at === 'string')
      .slice(0, RECENT_TRIGGERS_MAX);
  } catch (_) {
    // JSON.parse fail / quota zero / corrupt — degrade silently
    return [];
  }
}

function saveRecentTriggers() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENT_TRIGGERS_KEY, JSON.stringify(recentTriggers.value));
  } catch (_) {
    // quota exceeded / private mode — in-memory list still works,
    // next F5 will simply start empty again (no regression vs R158.X.99.6)
  }
}

const recentTriggers = ref(loadRecentTriggers());

// R158.X.99.6 — drawer state. `selectedName` drives `drawerRow` (looked
// up from items[] on each open); `recentByName` carries the packages[].recent[]
// rows we already fetch so the drawer doesn't need a new endpoint.
const selectedName = ref('');
const recentByName = ref(new Map());
const drawerOpen = ref(false);
const drawerRow = ref(null);
const drawerRows = ref([]);
const drawerTriggering = ref(false);
// (R158.X.99.20 之后: drawerTriggering 不再被读, drawer 内 "再触发一次" 改走
//   openTriggerModal, 跟行内 1:1 平行, ref 保留 0 删以减小差异, 0 影响.)

// R158.X.99.20 (2026-10-18) — "单次触发" 弹窗. 操作员 directive "在包执行计划中
//   添加一个弹出框, 支持在特定的 AD 中执行, 不是 cron". 后端 trigger-now
//   端点 (router.js:344-370) 接 targetDcs: string[] 数组, NULL = 向后兼容
//   全员触发. 前端弹窗让操作员多选 DC subset, 走 wire shape 1:1 平行
//   R158.72.x.12 B' triggerOnce precedent.
//   state:
//   - modalOpen: bool, 控制浮层显示
//   - modalPkgName: string, 当前触发的包名 (展示用)
//   - dcList: DC 列表 (从 /api/admin/dcs-catalog 拉, 1:1 平行 DcsCatalogView)
//   - selectedDcs: Set<string>, 已勾选的 DC hostname. 0 选 = 后端走全 DC
//   - dcLoading / dcLoadError: 拉取状态
const modalOpen = ref(false);
const modalPkgName = ref('');
const dcList = ref([]);
const selectedDcs = ref(new Set());
const dcLoading = ref(false);
const dcLoadError = ref('');

let pollTimer = null;

// Map dashboardApi.getPackagesRuns envelope → per-name summaries.
// Shape (from R67-T2 PackageRunsMonitorView contract):
//   packages: [{ name, version, summary24h: {success, failure, partial, total, lastRunAt}, recent: [{...}] }]
// We keep only the fields this view needs so the merge stays cheap.
function buildRunIndex(runsResp) {
  const idx = new Map();
  // R158.72.x.11.1 (2026-10-17) — wire shape 同步. /api/dashboard/packages-runs
  // 后端从 R158.76 / R158.95-ext ship 起返顶层 `packages` 字段, 不再是 `cards`
  // (跟 PackageRunsMonitorView.vue:740 `r.data?.packages` 1:1 平行). 本 view 是
  // 唯一还读 `cards` 的 view → 永远 undefined → idx 永远空 Map → 14 张包
  // 24h 计数列全走 fallback { success: 0, failure: 0 } (R158.95-ext ship
  // 漏改本 view 1 处, 跟 R158.61~68 "删 R62 端点同步删前端引用" 同型 bug).
  // 0 改后端 / 0 改 SQL helper / 0 改 wire shape (1:1 同步 R158.76 锁).
  const cards = Array.isArray(runsResp?.data?.packages) ? runsResp.data.packages : [];
  for (const c of cards) {
    const recent = Array.isArray(c.recent) ? c.recent : [];
    const lastEtl = recent[0]
      ? describeEtl(recent[0])
      : null;
    idx.set(c.name, {
      summary: {
        success: c.summary24h?.success ?? 0,
        failure: c.summary24h?.failure ?? 0
      },
      lastRunAt: c.summary24h?.lastRunAt || null,
      lastEtl,
      // R158.X.99.6 — keep the per-agent run rows so the drawer can
      // re-use them without hitting a second endpoint.
      recent,
      // R158.Y (2026-10-16) — lastTriggered 字段 (中心端
      //   packageRuns.lastTriggeredRunsByName 返). 0 改 wire shape,
      //   老 caller 0 影响. null = 120min 内 0 trigger (高 cadence 包
      //   24h 内 288 次 fire 所以 99% 命中).
      lastTriggered: c.lastTriggered || null
    });
  }
  return idx;
}

// One-line summary of the most recent run for this package. Used in
// the 最近一次 ETL column. Tries to surface what the operator
// actually cares about: exit code + script version mismatch (R154.5
// stale highlight).
function describeEtl(run) {
  if (!run) return '';
  const parts = [];
  if (run.exitCode != null) parts.push(`exit=${run.exitCode}`);
  if (run.durationMs != null) parts.push(`${run.durationMs}ms`);
  if (run.scriptVersion) parts.push(`v${run.scriptVersion}`);
  if (run.stderrPreview) parts.push('有 stderr');
  return parts.join(' · ');
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const [pkgResp, runResp] = await Promise.all([
      packagesApi.list(),
      dashboardApi.getPackagesRuns().catch(() => ({ data: { packages: [] } }))
    ]);
    const pkgs = Array.isArray(pkgResp.data?.items) ? pkgResp.data.items : [];
    const idx = buildRunIndex(runResp);
    // R158.X.99.6 — keep both the per-package summary and the raw recent
    // rows. The drawer indexes by name so we don't need a parallel fetch.
    recentByName.value = idx;
    items.value = pkgs.map((p) => {
      // R158.72.x.6 — attach Chinese label / description / cadence from
      // the static PACKAGE_DISPLAY dict. Fallback handled by displayFor.
      const display = displayFor(p.name);
      return {
        name: p.name,
        label: display.label,
        description: display.description,
        cadence: display.cadence,
        version: p.version,
        enabled: !!p.enabled,
        intervalSec: p.intervalSec,
        // R158.X.99.16 (2026-10-18) — 透传 agentType 给 computed group_by.
        // agentType ∈ {'ad','non-ad'} from /api/admin/packages response
        // (src/packages/router.js:117-155, derived from manifest.agent.type).
        agentType: p.agentType || 'ad',
        summary: idx.get(p.name)?.summary || { success: 0, failure: 0 },
        lastRunAt: idx.get(p.name)?.lastRunAt || null,
        lastEtl: idx.get(p.name)?.lastEtl || null,
        // R158.Y (2026-10-16) — 上次触发完成数据传给模板
        lastTriggered: idx.get(p.name)?.lastTriggered || null
      };
    });
    lastLoadedAt.value = new Date();
    // If the drawer was open, refresh its row list inline so the
    // operator sees new agent reports without closing/reopening.
    if (drawerOpen.value && selectedName.value) {
      const row = items.value.find((x) => x.name === selectedName.value);
      if (row) {
        drawerRow.value = row;
        drawerRows.value = (idx.get(row.name)?.recent || []).slice();
      }
    }
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    loading.value = false;
  }
}

// R158.X.99.6 — drawer handlers. ESC closes, scrim clicks close, the
// inline "单次触发" button itself uses @click.stop so it doesn't toggle
// the drawer while it triggers.
function openDrawer(name) {
  const row = items.value.find((x) => x.name === name);
  if (!row) return;
  selectedName.value = name;
  drawerRow.value = row;
  drawerRows.value = (recentByName.value.get(name)?.recent || []).slice();
  drawerOpen.value = true;
}
function closeDrawer() {
  drawerOpen.value = false;
  // Keep selectedName so the inline "is-selected" highlight stays
  // pinned until next click on another row.
}

// R158.X.99.20 (2026-10-18) — 弹窗入口. 取代原本 inline 按钮的"直接触发".
//   弹窗打开 → 拉 DC 列表 → 操作员多选 → 确认 → trigger(name, selectedDcs).
//   抽屉内 "再触发一次" 按钮也走这里, 跟行内按钮 1:1 平行.
function openTriggerModal(name) {
  modalPkgName.value = name;
  modalOpen.value = true;
  selectedDcs.value = new Set();  // 每次重置
  if (dcList.value.length === 0) {
    loadDcs();
  }
}

function closeTriggerModal() {
  modalOpen.value = false;
  // Keep modalPkgName 留最近一次, 关弹窗时不让 OK 按钮响应继续 trigger.
  selectedDcs.value = new Set();
}

async function loadDcs() {
  dcLoading.value = true;
  dcLoadError.value = '';
  try {
    const r = await adminApi.listDcsCatalog();
    // R158.44.1 (2026-10-04) wire shape: { dcs: [...] } wrapper.
    const list = Array.isArray(r.data?.dcs) ? r.data.dcs : [];
    // 按 dc_name 排序, 操作员查找快. 0 写 DC 台数 (操作员 directive 锁).
    dcList.value = list
      .map((d) => ({
        dcName: d.dc_name || d.dcName || '',
        isPdc: !!d.isPdc,
        isGc: !!d.isGc
      }))
      .filter((d) => d.dcName)
      .sort((a, b) => String(a.dcName).localeCompare(String(b.dcName)));
  } catch (e) {
    dcLoadError.value = e?.response?.data?.error || 'DC 列表加载失败';
    dcList.value = [];
  } finally {
    dcLoading.value = false;
  }
}

function toggleDc(dcName) {
  const next = new Set(selectedDcs.value);
  if (next.has(dcName)) next.delete(dcName);
  else next.add(dcName);
  selectedDcs.value = next;
}

function selectAllDcs() {
  selectedDcs.value = new Set(dcList.value.map((d) => d.dcName));
}

function clearAllDcs() {
  selectedDcs.value = new Set();
}

// R158.X.99.6 — row → pill mapping. recent[] rows carry a status field
// populated by the centre's packages/runner.js ingest (success / failed
// / partial / consumed-trigger / pending_trigger). Fall back to
// exitCode for older rows.
function statusLabel(r) {
  if (!r) return '—';
  if (r.status === 'consumed-trigger') return '已认领';
  if (r.status === 'pending_trigger') return '待认领';
  if (r.status === 'partial') return '部分成功';
  if (r.status === 'failed') return '失败';
  if (r.status === 'success') return '成功';
  if (r.status === 'running') return '运行中';
  if (r.exitCode != null && r.exitCode !== 0) return '失败';
  return '成功';
}
function pillClass(r) {
  if (isFailRow(r)) return 'pill-fail';
  if (r?.status === 'consumed-trigger' || r?.status === 'pending_trigger') return 'pill-warn';
  return 'pill-ok';
}
function isFailRow(r) {
  if (!r) return false;
  if (r.status === 'failed' || r.status === 'partial') return true;
  if (r.exitCode != null && r.exitCode !== 0) return true;
  return false;
}

// R158.Y (2026-10-16) — "上次触发完成" 单元格 pill 颜色逻辑.
// 跟 R158.50.7g status decision tree 1:1 平行 (success=绿 / partial=黄
// / failed=红). 仍然 in-flight (total=0 OR success+partial+failed<total)
// = 蓝,表示"等待中"。
function triggeredPillClass(lastTriggered) {
  if (!lastTriggered) return 'muted';
  const c = lastTriggered.completion;
  if (!c || c.total === 0) return 'pill-warn';   // 等待中
  const accountedFor = (c.success || 0) + (c.partial || 0) + (c.failed || 0);
  if (accountedFor < c.total) return 'pill-warn';  // 仍有 running
  if (c.failed > 0) return 'pill-fail';
  if (c.partial > 0) return 'pill-warn';
  return 'pill-ok';
}

// R158 — manual trigger. POST returns { ok, name, triggeredAt, fired }.
// `triggeredAt` is the timestamp the centre wrote the pending_trigger
// row — operator can mentally anchor "wait ≤ 60s for agent pickup".
// R158.72.x.12 B' (2026-10-17) — trigger once 大改 (改 center + 改 agent
//   双边匹配). 操作员 1 click = 1 跑 0 持续 1min 1 拍 (跟 R158.72.x.11 ship
//   闭合误判真因: 1.0.6 setInterval 写死 60s + 启动条件 = 看到 row 1:1 平行).
//   triggerOnce: true → 后端 fireTriggers 写 trigger_once=1 → agent 1.0.7
//   看到跑 1 次 0 启 setInterval (跟 R158.60.10 on-demand skip 1:1 平行).
//   0 引新 endpoint / 0 引新 wrapper (R158.86.6 #5 1:1 平行).
async function trigger(name, targetDcs = null) {
  triggering.value = { ...triggering.value, [name]: true };
  triggerOk.value = '';
  // R158.X.99.20 (2026-10-18) — 透传 targetDcs. 后端: NULL/空数组 = 全员
  //   触发 (老行为 1:1); 有值 = 只发到指定 DC subset (CSV 写 package_runs.target_agents).
  const body = {
    actor: 'admin-ui',
    triggerOnce: true   // R158.72.x.12 B' (2026-10-17) — 1 click = 1 跑
  };
  if (Array.isArray(targetDcs) && targetDcs.length > 0) {
    body.targetDcs = targetDcs;
  }
  try {
    // R158.X.99.26 (2026-10-18) — packagesApi.triggerNow → triggerOnce rename.
    //   端点 URL /trigger-now → /trigger-once 同步 (lesson 13 endpoint shape 改
    //   必 sync frontend data.X). 响应 shape 多了 `deduplicated` 字段告知
    //   操作员同 minute 已触发过 vs 真 fire 1 拍.
    const r = await packagesApi.triggerOnce(name, body);
    const at = r.data?.triggeredAt || new Date().toISOString();
    // R158.X.99.26 — 区分真 fire / dedup 跳过 / 失败 3 种状态. 操作员观察 ≠ 实际
    //   bug (lesson 19 锁), 真闭合 = UI 显"已入队" 或 "已触发过(同 minute)" 显区分.
    const fired = r.data?.fired === true;
    const deduplicated = r.data?.deduplicated === true;
    const onceFlag = fired ? ' (触发 1 次)' : (deduplicated ? ' (同分钟已触发过, dedup 跳过)' : '');
    const targetDcsResp = r.data?.targetDcs;
    const dcHint = Array.isArray(targetDcsResp) && targetDcsResp.length > 0
      ? ` (${targetDcsResp.length} 台指定 DC)`
      : '';
    triggerOk.value = `已入队: ${name}${onceFlag}${dcHint} (${at})`;
    recentTriggers.value = [
      { name, at, ok: true, triggerOnce: fired, deduplicated, targetDcs: targetDcsResp || null },
      ...recentTriggers.value
    ].slice(0, RECENT_TRIGGERS_MAX);
    saveRecentTriggers();
    // Refresh immediately so the operator sees the new pending_trigger
    // row reflected in the table (it shows up in lastRunAt when the
    // agent reports back within the 30s polling window).
    refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || '触发失败';
    triggerOk.value = '';
    error.value = `${name}: ${msg}`;
    recentTriggers.value = [
      { name, at: new Date().toISOString(), ok: false, error: msg, targetDcs: targetDcs || null },
      ...recentTriggers.value
    ].slice(0, RECENT_TRIGGERS_MAX);
    saveRecentTriggers();
  } finally {
    triggering.value = { ...triggering.value, [name]: false };
  }
}

// R158.X.99.20 (2026-10-18) — 弹窗确认触发. 走 trigger(name, targetDcs),
//   targetDcs = selectedDcs 数组 (空 → 不传 → 后端走全 DC).
function confirmTrigger() {
  const name = modalPkgName.value;
  if (!name) return;
  const arr = Array.from(selectedDcs.value);
  closeTriggerModal();
  return trigger(name, arr);
}

// Polling cadence: 30s. Half of R157's heartbeat interval, so the
// operator sees the agent's run row appear within 1 polling window
// after the trigger lands. Cleared on unmount.
function startPolling() {
  polling.value = true;
  pollTimer = setInterval(() => {
    refresh();
  }, 30_000);
}
function stopPolling() {
  polling.value = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

const fmt = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
};

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  // R158.X.99.20 — modal 优先级高于 drawer (modal 是顶层).
  if (modalOpen.value) {
    closeTriggerModal();
    return;
  }
  if (drawerOpen.value) closeDrawer();
}

onMounted(() => {
  refresh();
  startPolling();
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  stopPolling();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;
}
.page-titles .eyebrow {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--muted);
}
.page-titles h2 { margin: 4px 0 6px; font-size: 18px; font-weight: 600; color: var(--text); }
.page-titles .subtitle { margin: 0; font-size: 12.5px; color: var(--muted); }
.page-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.page-meta .time { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.page-meta .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--muted);
}
.page-meta .dot.on { background: #4ade80; }
.page-meta .dot.off { background: var(--muted); }

.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer;
  border: 1px solid var(--border); font-size: 13px;
  background: var(--input-bg); color: var(--text);
  text-decoration: none;
  display: inline-block;
}
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 4px 10px; font-size: 12px; }

.error-banner { padding: 10px 14px; background: rgba(239, 68, 68, 0.10); color: #fca5a5; border-left: 2px solid #ef4444; margin-bottom: 14px; font-size: 13px; }
.ok-banner { padding: 10px 14px; background: rgba(74, 222, 128, 0.10); color: #86efac; border-left: 2px solid #4ade80; margin-bottom: 14px; font-size: 13px; }
.empty { padding: 32px 18px; color: var(--muted); text-align: center; border: 1px dashed var(--border); border-radius: 4px; }

.t-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
.t { width: 100%; border-collapse: collapse; font-size: 13px; }
.t thead th {
  text-align: left;
  padding: 8px 12px;
  background: var(--sidebar-bg);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.t tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  color: var(--text);
}
.t tbody tr:last-child td { border-bottom: 0; }
.t tbody tr:hover { background: rgba(96, 165, 250, 0.04); }

.col-name { display: flex; flex-direction: column; gap: 1px; }
.pkg-name { font-weight: 600; color: var(--text); }
.pkg-version { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* R158.72.x.6 — PackageScheduleView 中文化 + 运行节奏 */
.pkg-label { font-weight: 600; color: var(--text); font-size: 13.5px; }
.pkg-name-zh { font-size: 10.5px; color: var(--muted); font-family: monospace; }
.pkg-cadence { font-size: 11px; color: var(--accent); margin-top: 2px; line-height: 1.4; }

/* R158.X.99.21 (2026-10-18) — "上次触发完成" 列加 trigger once / schedule
   模式 pill. trigger once = 蓝 (accent 复用), schedule = 灰. 0 引新 token. */
.triggered-mode {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  font-weight: 600;
  text-transform: lowercase;
  font-family: monospace;
  vertical-align: middle;
}
.triggered-mode.mode-trigger {
  background: var(--accent);
  color: #fff;
}
.triggered-mode.mode-schedule {
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
}

.num { text-align: right; font-variant-numeric: tabular-nums; }
.actions-col { text-align: right; white-space: nowrap; }

.pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
}
.pill-ok { background: rgba(74, 222, 128, 0.14); color: #86efac; }
.pill-off { background: rgba(120, 120, 120, 0.14); color: var(--muted); }
.pill-fail { background: rgba(239, 68, 68, 0.14); color: #fca5a5; }

.counts { display: inline-flex; gap: 4px; font-variant-numeric: tabular-nums; }
.count-ok { color: #86efac; font-weight: 600; }
.count-sep { color: var(--muted); }
.count-fail { color: #fca5a5; font-weight: 600; }

.etl-summary { font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }

/* R158.Y (2026-10-16) — 上次触发完成 pill 样式 (跟 R158.50.7g
   status decision tree 颜色 1:1 平行).  */
.triggered-pill {
  display: inline-flex; flex-direction: column; gap: 1px;
  font-size: 11px; line-height: 1.3;
}
.triggered-at { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 10.5px; }
.triggered-counts { font-variant-numeric: tabular-nums; font-weight: 600; }

.recent-triggers { margin-top: 24px; }
.recent-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 0 0 8px; }
.recent-table { font-size: 12px; }

/* R158.X.99.6 — drawer */
.script-row { cursor: pointer; }
.script-row.is-selected { background: rgba(96, 165, 250, 0.10); }

.drawer-scrim {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 90;
}
.drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 420px; max-width: 92vw;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.25);
  display: flex; flex-direction: column;
  z-index: 100;
}
.drawer-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px; padding: 16px 18px 10px;
  border-bottom: 1px solid var(--border);
}
.drawer-eyebrow {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.10em;
  text-transform: uppercase; color: var(--muted);
}
.drawer-title-wrap { min-width: 0; flex: 1; }
.drawer-title { margin: 4px 0 2px; font-size: 16px; font-weight: 600; color: var(--text); word-break: break-all; }
.drawer-sub { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.drawer-close {
  width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
  background: transparent; border: 1px solid var(--border);
  color: var(--muted); font-size: 18px; line-height: 1; flex: 0 0 auto;
}
.drawer-close:hover { color: var(--text); border-color: var(--accent); }

.drawer-stats {
  display: inline-flex; gap: 12px; padding: 10px 18px 6px;
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.stat-ok { color: #86efac; font-weight: 600; }
.stat-fail { color: #fca5a5; font-weight: 600; }
.stat-muted { color: var(--muted); }

.drawer-table-wrap { flex: 1; overflow: auto; padding: 0 18px 12px; }
.drawer-table { font-size: 12px; }
.drawer-table thead th { background: var(--sidebar-bg); }
.drawer-table .ts { white-space: nowrap; }
.drawer-table .agent { word-break: break-all; }
.drawer-table .center { text-align: center; padding: 18px 0; }
.drawer-table tr.row-fail { background: rgba(239, 68, 68, 0.10); }

.pill-warn {
  background: rgba(250, 204, 21, 0.14);
  color: #facc15;
}

.drawer-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

/* slide transition */
.drawer-slide-enter-active, .drawer-slide-leave-active {
  transition: transform 0.22s ease;
}
.drawer-slide-enter-from, .drawer-slide-leave-to {
  transform: translateX(100%);
}

/* R158.X.99.20 (2026-10-18) — "单次触发" 弹窗样式. 跟 drawer 1:1 平行
   视觉 (scrim + 浮层), 居中布局, 0 引 element-plus (R158.111 锁). */
.modal-scrim {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 110;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
  width: 480px; max-width: 100%;
  max-height: 80vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.modal-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px; padding: 16px 18px 10px;
  border-bottom: 1px solid var(--border);
}
.modal-eyebrow {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.10em;
  text-transform: uppercase; color: var(--muted);
}
.modal-title {
  margin: 4px 0 2px; font-size: 16px; font-weight: 600; color: var(--text);
  font-family: monospace; word-break: break-all;
}
.modal-sub {
  margin: 4px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.5;
}

.modal-body {
  flex: 1; overflow: auto; padding: 12px 18px;
}
.modal-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 0 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}
.modal-count {
  font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.modal-toolbar-btns { display: inline-flex; gap: 6px; }

.dc-list { display: flex; flex-direction: column; gap: 2px; }
.dc-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 3px;
  cursor: pointer; user-select: none;
  font-size: 13px;
}
.dc-item:hover { background: rgba(96, 165, 250, 0.06); }
.dc-item.is-checked { background: rgba(96, 165, 250, 0.10); }
.dc-item input[type="checkbox"] {
  width: 14px; height: 14px; flex: 0 0 auto; cursor: pointer;
}
.dc-name {
  flex: 1; color: var(--text); font-family: monospace; font-size: 12.5px;
  word-break: break-all;
}
.dc-flags { display: inline-flex; gap: 4px; }
.dc-flag {
  font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px;
  letter-spacing: 0.04em;
}
.dc-flag-pdc { background: rgba(250, 204, 21, 0.18); color: #facc15; }
.dc-flag-gc { background: rgba(74, 222, 128, 0.18); color: #86efac; }

.modal-empty {
  padding: 24px 12px; text-align: center; color: var(--muted); font-size: 12.5px;
}
.modal-error { color: #fca5a5; }

.modal-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}
</style>
