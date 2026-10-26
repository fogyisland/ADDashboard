<!--
  R158.34 (2026-10-02) — DailyOpsView.vue
  R158.34.4 (2026-10-02) — 拿掉 <AdminLayout> wrapper, 改用独立 chrome.
  R158.35 (2026-10-03) — 嵌入 UserManagementView/GroupManagementView (dataSource='snapshot')
  R158.36 (2026-10-03) — 三栏 AD 管理工具改造. Operator directive:
    "其实我们这个操作可以这样在左边显示树状目录, 然后中间显示结果,
     就像活动目录管理工具一样, 右边针对不同的对象进行处理"

  R158.40 (2026-10-03) — ADUC 完整复刻. Operator directive:
    "在顶部选择森林、域、服务器 然后下面列出树状目录, 中间为对象,
     右边为依据不同的对象进行不同的操作"

  R158.41 (2026-10-03) — 3 件收尾:
    (a) TopContextPicker 4 级 dropdown: 加 📍 站点 (sites) 第 4 级
    (b) DcsCatalogView 行级「所属域」dropdown 主路径走 listDcsByDomain
    (c) DailyOpsView 加 sites state + loadDomainSites + 改 loadDomains/loadDomainDcs
        + topContext 4 元组
  R158.41.2 (2026-10-03) — 默认域选择: 跨域并发探测 DC 数, 选第一个有 DC 的域
  R158.41 no-pkg-entry (2026-10-03) — 去掉 📦 包 (中心仓) 入口 (operator "将界面中心包 的内容去掉").
    DC tab + user/group 节点 tab 的 quickfix 表单保留 (走 /api/admin/ad-account/quickfix),
    仅删 selection.kind === 'package' 分支 + 包入口 UI + 相关 state/handlers.

  R158.43.1 (2026-10-04) — AD 树挪到顶部 / 站点树折叠降级为二级入口.
    operator 反馈: "当前日常管理界面出来的是站点, 我要去的是 AD 里面的数据".
    改造: 左栏 📂 OU 树挪到 📍 站点树之前 (默认第一眼看到 AD 目录),
    站点树降级为默认收起的 details → 排查 DC 健康/锁定数时再展开.

  R158.43.2 (2026-10-04) — 左栏彻底移除站点树 + 概览 DC tile 数据源解耦.
    反馈一 "下面 DC 树不显示站点数据" → 左栏整段站点树删 (上一轮).
    反馈二 "概览这里会开始显示 DC, 后面突然间消失" → race 根因:
      sites.value 同时被 picker (来自 adminApi.listDcsByDomain, 分组 schema
      {id, name, dcCount, dcs}) 和 refreshAll (来自 /api/dashboard/agents,
      分组 schema {id, name, dcs}, 没 dcCount) 两种不同 schema 覆盖. agents
   先到时 tile 显示, loadDomainSites 后到时覆盖但 shape 变 → 偶发
   dcs 字段不一致引发 UI 跳; 30s refreshAll 再覆盖一次. 修: 拆
   overviewDcs ref (扁平, 仅来自 agents) 给概览 tile 用, sites 仅由
   loadDomainSites 写入喂 picker. 单一数据源 = 不再 race.

  新结构 (R158.43.2 matches ADUC 模式):
    左 320px  ───  中 1fr  ───  右 380px
    OU 树          结果列表        属性 + 操作面板
    ┌────────┐    ┌──────────┐    ┌──────────┐
    │ 📂 OU  │    │ 用户列表  │    │ 属性表   │
    │  └ OU  │    │ Group列表 │    │ 操作按钮 │
    │  └ ... │    │ 详情      │    │  popover │
    └────────┘    └──────────┘    └──────────┘

  Selection model (R158.40 + R158.41):
    {kind: 'dc', hostname}            — 选中 DC (中栏: 4 tab, 右栏: DC 概览)
    {kind: 'ou', dc, dn, node}        — 选中 OU 节点 (中栏: 3 tab OuScopedView, 右栏: OuActionPanel)
    {kind: 'user', dc, dn, sam}       — [R158.45.21 移除] 虚拟「用户列表」节点, 现走 OuScopedView + kindFilter
    {kind: 'group', dc, dn, name}     — [R158.45.21 移除] 虚拟「组列表」节点, 现走 OuScopedView + kindFilter
    {kind: 'builtin', dc, dn, node}   — 选中 CN=Builtin (中栏: 只读内置对象, 右栏: OuActionPanel disabledAll)

  树层级 (R158.40 ADUC + R158.41 no-pkg-entry):
    🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC (顶部 TopContextPicker 4 级)
    站点 → DC (R158.36 保留左栏树 — R158.41 移除了 OU 树上方的 📦 包入口)
    📂 OU 树 (选 DC 后加载 ad_ous_snapshot, 递归 OuTreeNode)

  写动作迁移: UserPropertyPanel.vue / GroupPropertyPanel.vue / OuActionPanel.vue
  承担重置密码 / 启用 / 禁用 / 解锁 / 编辑属性 / 设置经理 / 组成员 / 删除
  / 创建 OU / 创建用户 / 创建组 / 删除对象 等全部写动作。

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM, 落地后
  `[System.IO.File]::ReadAllBytes + Encoding.UTF8.GetString` 校验.
-->
<template>
  <div class="daily-ops-shell">
    <header class="daily-ops-topbar">
      <div class="daily-ops-topbar-left">
        <router-link to="/" class="back-link">← 返回看板</router-link>
        <span class="daily-ops-title">日常管理</span>
      </div>
      <div class="topbar-actions">
        <span class="user-chip">{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        <button class="theme-toggle" :title="theme === 'dark' ? '切换到白天' : '切换到黑夜'" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '🌙' }}</button>
        <!-- R158.60.13 (2026-10-09) — 操作平台 topbar 加 AD 运维日志入口,
             一键跳 /admin/ad-management-log 看 ad_command_* 实时结果. -->
        <router-link to="/admin/ad-management-log" class="ad-mgmt-link"
                     data-test="ad-mgmt-link">🛠️ AD 运维日志</router-link>
        <button @click="logout">退出</button>
      </div>
    </header>

    <section class="daily-ops-content">
      <header class="page-header">
        <div class="page-titles">
          <div class="eyebrow">运维管理 · 日常管理</div>
          <h2 class="page-title">日常管理</h2>
          <p class="subtitle">
            三栏布局, 类似活动目录管理工具 — 左 OU 树 / 中对象列表 / 右写动作面板 · 选中对象 (OU / 用户 / 组 / 内置容器) 后右侧呈现对应写动作
          </p>
        </div>
        <div class="page-meta">
          <!-- R158.41 sites (2026-10-03) — 顶部 4 级 dropdown (🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC). -->
          <TopContextPicker
            v-model="topContext"
            :forests="forests"
            :domains="domains"
            :sites="sites"
            :dcs="dcs"
          />
          <span class="refresh-indicator">
            <span :class="['dot', polling ? 'on' : 'off']"></span>
            <span>{{ polling ? `每 ${refreshSeconds}s 刷新` : '暂停刷新' }}</span>
          </span>
          <button class="btn-secondary" @click="refreshAll" :disabled="loading">↻ 刷新</button>
        </div>
      </header>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <!-- R158.40 — 三栏 grid: 320px 树 + 1fr 列表 + 380px 属性 -->
      <div class="daily-ops-grid">
        <!-- 左: 树状目录 -->
        <aside class="tree-panel">
          <div class="tree-toolbar">
            <!-- R158.43.2 (2026-10-04) — 左栏只显示 OU 树 (站点 / DC 树拿掉),
                 filter 只过滤 OU 节点, placeholder 同步收敛.
                 R158.45.23 (2026-10-05) — filter 扩到 name ∪ dn ∪ description. -->
            <input
              v-model="filterText"
              placeholder="过滤 OU (名称 / DN / 描述)…"
              class="filter-input"
              data-test="tree-filter"
            />
          </div>

          <div class="tree-scroll">
            <!-- R158.41 no-pkg-entry — 移除左栏顶部"📦 包 (中心仓)" 入口.
                 selection.kind === 'package' 全部分支随之移除. DC tab / user/group 节点
                 tab 里的 quickfix 表单保留 (走 /api/admin/ad-account/quickfix). -->

            <!-- R158.43.1 (2026-10-04) — AD 树挪到顶部, 默认进入日常管理第一眼
                 看到 AD 目录 (OU + 用户 + 组), 不再是站点. operator 反馈:
                 "你出来的是站点, 我要去的是 AD 里面的数据". 站点树降级为
                 折叠的二级 section (默认收起, 排查 DC 健康用). -->

            <!-- OU 树 (R158.40 ADUC, R158.43.1 前置)
                 R158.45.10 (2026-10-05) — 改成按 domainId 显示 (operator "选森林和域就显示域树").
                 R158.45.34 (2026-10-06) — operator "必须按顺序选森林→域→站点→DC 才显示":
                   改回 topContext.dcHostname (R158.45.10 之前的语义). 4 级 picker
                   顺序选完 (DC) 才出 OU 树, 跟 R158.45.10 之前行为一致. OU 树数据
                   仍按 domainName 查 (R158.45.10 后端改动保留). -->
            <details
              v-if="topContext?.dcHostname"
              class="tree-section"
              open
              data-test="ou-tree-section"
            >
              <summary class="tree-section-title">
                <span class="ts-icon">📂</span>
                <span>OU 树 ({{ topContextDomainName }})</span>
                <span class="ts-meta">{{ ouCache.length }} OU<span v-if="ouSnapshotAt"> · 同步 {{ formatRelative(ouSnapshotAt) }}</span></span>
              </summary>
              <div v-if="ouLoading" class="empty-hint">OU 加载中…</div>
              <!-- R158.43.1 — operator: "在同步完成才加载, 没有同步完成显示暂未加载".
                   ouSnapshotAt === null = ad_ous_snapshot 该 DC 还没跑过 LDAP 同步
                   (源头是 /admin/directory-sync 的 cron + 手动触发). -->
              <div v-else-if="!ouSnapshotAt" class="empty-hint ou-not-synced">
                <div class="ou-not-synced-title">⏳ 暂未加载</div>
                <div class="ou-not-synced-sub">该域控尚未跑过 AD 信息同步 — 请去「AD 信息同步」配置 LDAP 并触发同步</div>
              </div>
              <div v-else-if="!filteredOuRoots.length" class="empty-hint">该域控已同步 ({{ formatRelative(ouSnapshotAt) }}), 但无 OU 数据</div>
              <ul v-else class="tree-list ou-roots">
                <OuTreeNode
                  v-for="root in filteredOuRoots"
                  :key="root.dn"
                  :node="root"
                  :selected-dn="selection?.dn || ''"
                  :selected-kind="selection?.kind || ''"
                  :expanded-dn-set="expandedDnSet"
                  :filter-text="filterText"
                  @select="onSelectOu"
                  @selectBuiltin="onSelectBuiltin"
                  @selectUsers="onSelectOuUsers"
                  @selectGroups="onSelectOuGroups"
                  @selectComputers="onSelectOuComputers"
                  @toggleExpand="onToggleExpand"
                />
              </ul>
            </details>
            <div v-else-if="forests.length > 0 && !topContext?.domainId" class="empty-hint">
              顶部选择森林 / 域后加载 OU 树
            </div>

            <!-- R158.43.2 (2026-10-04) — 左栏彻底不显示站点树.
                 operator 反馈: "下面 DC 树不显示站点数据". 站点维度仅在顶部
                 TopContextPicker 4 级 dropdown 里作为 DC 筛选条件 (DC 太多时
                 帮 operator 缩范围), 左栏直接列 OU 树 (选 DC 后加载).
                 loadDomainSites / sites / dcs state 仍保留 (喂给 picker). -->
          </div>
        </aside>

        <!-- 中: 结果列表 + tab 切换 -->
        <section class="list-panel">
          <!-- 默认: 概览 (未选中任何节点) -->
          <div v-if="!selection" class="detail-default">
            <h3>概览</h3>
            <p class="hint">
              顶部选择 🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC · 左侧 OU 树展开后选中节点 → 中间呈现对应对象列表, 右侧呈现属性 + 操作。点击行可继续深入 (用户 / 组)。
            </p>
            <div class="overview-tiles">
              <article v-for="dc in allDcs" :key="dc.hostname" class="ov-tile" @click="selectDc(dc.hostname)">
                <header class="ov-tile-header">
                  <span :class="['hb-dot', dc.status || 'unknown']"></span>
                  <strong>{{ dc.hostname }}</strong>
                </header>
                <div class="ov-tile-meta">
                  <span v-if="dc.lockedCount > 0" class="locked-chip">🔒 {{ dc.lockedCount }} 锁定</span>
                  <span v-else class="muted">无锁定</span>
                  <span v-if="dc.lastQuickfixAt" class="muted">最近重置: {{ fmtRelative(dc.lastQuickfixAt) }}</span>
                  <span v-else class="muted">最近重置: —</span>
                </div>
              </article>
            </div>
          </div>

          <!-- 选中 OU: OuScopedView (3 tab) -->
          <template v-else-if="selection.kind === 'ou'">
            <OuScopedView
              :dc="selection.dc"
              :domain="topContextDomainName"
              :ou-dn="selection.dn"
              :ou-node="selection.node"
              :ou-cache="ouCache"
              :data-source="directoryConfigured ? 'snapshot' : 'live'"
              :selected-sam="focusedObj?.kind === 'user' ? focusedObj.sam : ''"
              :selected-name="focusedObj?.kind === 'group' ? focusedObj.name : ''"
              :computer-selected-sam="computerSelectedSam"
              :kind-filter="selection.kindFilter || 'all'"
              :filter="ouFilter"
              @select-user="onSelectUser"
              @select-group="onSelectGroup"
              @select-ou="onSelectOu"
              @select-computer="onSelectComputer"
              @kind-change="onKindChange"
            />
          </template>

          <!-- 选中 builtin container / 通用兜底: 走 OuScopedView 树 (OU 详情 R158.45.27).
               R158.45.27 — OU 虚拟节点 (👤/🛡/💻) 不再切 selection.kind='user'/'group'/'computer',
               直接 selection.kind='ou' + kindFilter='user'/'group'/'computer', 由 OuScopedView
               按 kindFilter 渲染对应行, 不再触发 UserManagementView/GroupManagementView embedded
               chrome (operator "颠倒 OU 树虚拟节点 → 不再进 ad 用户管理"). -->

          <!-- R158.45.21 + R158.45.27 (2026-10-05) — operator "快速管理这些其实不需要" + "OU 虚拟节点直接列出对应的人":
               删 DC 视图 4 tab (用户 / 组 / 快速重置 / 历史) + 嵌入子组件 chrome.
               DC 选中后中栏只显示引导提示, 引导 operator 到左侧 OU 树下钻.
               写动作 (重置密码 / 编辑 / 删除) 全部由 OU 视图右栏属性面板承担.
               UserManagementView / GroupManagementView 文件保留 (DailyOpsView 不再
               embedded 调用, 留作后续 sprint 可能复用). -->
          <template v-else-if="selection.kind === 'dc'">
            <header class="detail-dc-header">
              <h3>{{ selection.hostname }}</h3>
            </header>
            <div class="dc-pivot-hint">
              <p class="hint">
                DC 视图仅展示基本信息 (右栏由 <em>DcOverviewPanel</em> 渲染心跳 / 站点 / 锁定账户 / 同步状态).
                请展开 <strong>左侧 OU 树</strong> →
                <strong>中栏</strong> 列出该 OU 下所有对象 (用户 / 组 / 电脑 / 子 OU) →
                <strong>右栏</strong> 出现属性 + 写动作 (重置密码 / 编辑 / 启用 / 删除 等).
              </p>
              <p class="hint">
                OU 树上的 <strong>👤 用户 (N)</strong> / <strong>🛡 组 (N)</strong> /
                <strong>💻 电脑 (N)</strong> 虚拟节点会直接筛选中栏对应类型, 不再进入旧的「AD 用户管理」/「AD 组管理」tab.
              </p>
            </div>
          </template>

          <!-- 选中 Builtin 容器: 只读内置组列表 -->
          <div v-else-if="selection.kind === 'builtin'" class="detail-builtin">
            <h3>CN=Builtin 内置容器</h3>
            <p class="hint">AD 系统内置容器 (Administrators / Users / Guests 等), 只读不可修改。</p>
            <div v-if="builtinGroupsLoading" class="empty-hint">加载中…</div>
            <div v-else-if="!builtinGroups.length" class="empty-hint">该 DC 上暂无快照内置组</div>
            <ul v-else class="builtin-group-list">
              <li v-for="g in builtinGroups" :key="g.name" class="tree-leaf">
                <span class="leaf-icon">⚙️</span>
                <span class="leaf-label">{{ g.name }}</span>
                <span class="leaf-meta">{{ g.samAccountName || '—' }}</span>
              </li>
            </ul>
          </div>

          <!-- R158.41 no-pkg-entry — 移除 selection.kind === 'package' 分支.
               包入口相关中栏 / 右栏 UI + handlers (loadPackageDetail / submitPackageQuickfix / selectPackage / pkgQf / pkgDetail / packages) 全部删除.
               包管理仍可通过 /admin/packages 路由访问 (PackagesView.vue 不动). -->
        </section>

        <!-- 右: 属性 + 操作面板 -->
        <aside class="prop-panel">
          <!-- R158.45.31 (2026-10-05) — operator "点中栏某行 → 右栏出现该对象操作";
               R158.45.19 设计遗漏: focusedObj.user/group 必须优先于 selection.kind='ou'
               命中, 否则 OU 选中状态下右栏永远停在 OuActionPanel, user/group 行 click
               看不到属性面板. focusedObj=null 才回落到 OuActionPanel (OU 写动作). -->
          <UserPropertyPanel
            v-if="focusedObj?.kind === 'user'"
            :key="`user-${focusedObj.sam}`"
            :dc="focusedObj.dc"
            :domain="topContextDomainName"
            :sam="focusedObj.sam"
            :data-source="directoryConfigured ? 'snapshot' : 'live'"
          />
          <GroupPropertyPanel
            v-else-if="focusedObj?.kind === 'group'"
            :key="`group-${focusedObj.name}`"
            :dc="focusedObj.dc"
            :domain="topContextDomainName"
            :name="focusedObj.name"
            :data-source="directoryConfigured ? 'snapshot' : 'live'"
          />

          <!-- 选中 DC: DC 概览 -->
          <DcOverviewPanel v-else-if="selection?.kind === 'dc'" :hostname="selection.hostname" />

          <!-- R158.46b (2026-10-06) — operator "root OU 也应该有创建入口 + 保留筛选":
               顶级 OU (depth=0) 选中时右栏上半 = OuActionPanel (创建用户/组/OU),
               下半 = OuFilterPanel (筛选). 二级 OU 选中仍只显示 OuActionPanel
               (无筛选). R158.45.32 原 design "root OU 只显示 OuFilterPanel" 改:
               root OU 跟二级 OU 操作入口一致 + 额外保留筛选面板. depth 由
               buildOuTree (R158.45.11) walk(n, 0) 设置, root 节点 depth=0. -->
          <div v-else-if="selection?.kind === 'ou' && (selection.node?.depth === 0 || !selection.node?.parentDn)" class="root-ou-stack">
            <OuActionPanel
              :dc="selection.dc"
              :ou-node="selection.node"
              :submitting="ouActionSubmitting"
              @submit-command="onOuAction"
            />
            <OuFilterPanel
              :ou-node="selection.node"
              :applied-filter="ouFilter"
              @filter-change="onOuFilterChange"
            />
          </div>

          <!-- 选中 OU: OuActionPanel (focusedObj=null + 非顶级 OU 才走到) -->
          <OuActionPanel
            v-else-if="selection?.kind === 'ou'"
            :dc="selection.dc"
            :ou-node="selection.node"
            :submitting="ouActionSubmitting"
            @submit-command="onOuAction"
          />

          <!-- 选中 Builtin: OuActionPanel 只读 -->
          <OuActionPanel
            v-else-if="selection?.kind === 'builtin'"
            :dc="selection.dc"
            :ou-node="selection.node"
            :disabled-all="true"
          />

          <!-- R158.45.19 (2026-10-05) — operator "点中栏账户 → 右栏出现可操作
               项目". focusedObj 由中栏 unified list 行 click 设置, 不切 selection.kind.
               selection.kind 保持 'ou' → 中栏仍渲染 OuScopedView (unified list).
               右栏根据 focusedObj.kind 渲染对应属性面板.
               R158.45.31 — focusedObj 分支提前, 见上. -->
          <!-- R158.45.19 — computer 暂不实现 ComputerPropertyPanel, 沿用
               computerSelectedSam 路径让 ComputerList 高亮. 后续 sprint 落实. -->

          <!-- R158.41 no-pkg-entry — 移除 selection.kind === 'package' 右栏 prop-package. -->

          <!-- 默认空态 -->
          <div v-else class="prop-empty">
            <h3>属性面板</h3>
            <p class="hint">
              在左侧树中选中 <strong>OU 节点</strong> → 创建子 OU / 用户 / 组 · 选中 <strong>用户行</strong> / <strong>组行</strong> → 重置密码 / 编辑属性 / 删除 · 选中 <strong>Builtin 容器</strong> → 只读查看.
            </p>
          </div>
        </aside>
      </div>

      <!-- R158.45.17 (2026-10-05) — ADUC 风格 status bar. 显示当前 selection
           类型 + 计数, 跟整体视觉协调. -->
      <footer class="daily-ops-statusbar">
        <span class="status-section">{{ selectionLabel }}</span>
        <span class="status-divider">·</span>
        <span class="status-section" data-test="statusbar-selection">{{ selectionSummary }}</span>
        <span class="status-spacer"></span>
        <span class="status-section muted">{{ fmtTime(currentTime) }}</span>
      </footer>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useTheme } from '../../composables/useTheme.js';
// R158.45.21 + R158.45.27 — DailyOpsView 不再 embedded UserManagementView /
// GroupManagementView (oper "快速管理这些其实不需要" + "OU 虚拟节点直接列出对应的人").
// 这两个文件保留在仓库里, 供后续 sprint 复用或单页路由访问.
// import UserManagementView from './UserManagementView.vue';
// import GroupManagementView from './GroupManagementView.vue';
import UserPropertyPanel from './UserPropertyPanel.vue';
import GroupPropertyPanel from './GroupPropertyPanel.vue';
import DcOverviewPanel from './DcOverviewPanel.vue';
// R158.40 — ADUC 复刻新组件.
import TopContextPicker from './TopContextPicker.vue';
import OuTreeNode from './OuTreeNode.vue';
import OuScopedView from './OuScopedView.vue';
import OuActionPanel from './OuActionPanel.vue';
// R158.45.32 (2026-10-05) — 顶级 OU 选中时右栏 = 筛选入口 (OuFilterPanel),
//   跟普通 OU 选中时的 OuActionPanel (创建/删除) 分派.
import OuFilterPanel from './OuFilterPanel.vue';
import { forestRegistryApi, adminApi } from '../../api/admin.js';
import { adAdminApi } from '../../api/ad-admin.js';
// R158.43 (2026-10-03) — 抽到 utils/ouTreeBuilder.js, 供 SnapshotTreeSection
// 复用, 同 DC 在 DailyOpsView 和 /admin/directory-sync 渲染一致树.
// R158.44.7.10 (2026-10-05) — countUsersAndGroups → countUsersGroupsComputers
// 加第 3 object class (computer). OU 树每个节点显示 👤/👥/💻 3 个计数.
import { stripFirstRdn, firstRdnValue, countUsersGroupsComputers, buildOuTree } from '../../utils/ouTreeBuilder.js';

const auth = useAuthStore();
const router = useRouter();
const { theme, toggleTheme } = useTheme();
function logout() { auth.logout(); router.push('/login'); }

const loading = ref(false);
const error = ref('');
const polling = ref(true);
const refreshSeconds = 30;
let pollTimer = null;

// R158.35 — directory-sync visibility.
const directoryConfigured = ref(false);
const directoryLastRun = ref(null);
const directoryStale = ref(false);

// R158.41 sites (2026-10-03) — 顶部 4 级 dropdown state + 联动数据.
const forests = ref([]);
const domains = ref([]);
// R158.43.2 (2026-10-04) — sites 仅作 picker 用, 不再被概览 DC tile 复用.
const sites   = ref([]);   // R158.41 新增 — 站点候选 [{id, name, dcCount}]
const dcs     = ref([]);
// R158.41 — topContext 4 元组: { forestId, domainId, siteId, dcHostname }.
const topContext = ref(null);

// R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
//   OU 树按 domainName (FQDN) 加载, 站点/DC 不影响. computed 从 domains[] 查.
const topContextDomainName = computed(() => {
  if (!topContext.value?.domainId) return '';
  const d = domains.value.find(x => x.id === topContext.value.domainId);
  return d?.domainName || '';
});

// R158.43.2 (2026-10-04) — 概览页 DC tile 解构 sites.value 单一数据源.
// 之前 sites 同时被 picker (来自 adminApi.listDcsByDomain) 和 refreshAll (来自
// /api/dashboard/agents) 两个不同时序写不同 schema 覆盖, 引发 tile 出现 /
// 突然消失的 race. 现拆出 overviewDcs (扁平数组, 只来自 agents), 30s 刷新
// 只覆盖自身, 不再触碰 picker 的 sites, picker 的 sites 仅由 loadDomainSites
// 写入. 单一数据源 = 无 race.
const overviewDcs = ref([]);  // 扁平 DC tile 列表 [{hostname, status, lockedCount, lastQuickfixAt}]

const filteredSites = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return sites.value;
  return sites.value
    .map(s => ({
      ...s,
      dcs: s.dcs.filter(d =>
        d.hostname.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
      )
    }))
    .filter(s => s.dcs.length > 0 || s.name.toLowerCase().includes(q));
});

// R158.45.22 (2026-10-05) — operator "没选域之前不列出任何域的信息":
//   概览 DC tile 必须只来自当前 domain 的 dcs 列表 (来自 listDcsByDomain).
//   没选域 → dcs.value=[] → allDcs=[] (空, 不显示任何跨域 agent).
//   选了域 → allDcs = overviewDcs 中 hostname 匹配 dcs.hostname 的子集.
//   agents payload 没带 domainName, 所以用 hostname 交集做兜底.
const allDcs = computed(() => {
  if (!topContext.value?.domainId) return [];
  const hosts = new Set(dcs.value.map(d => d.hostname));
  return overviewDcs.value.filter(o => hosts.has(o.hostname));
});

// R158.41 no-pkg-entry — 移除 packages / pkgDetail / pkgQf 硬编码数组与 state.

// R158.41 — selection model 移除 kind='package'.
// R158.45.21 + R158.45.27 (2026-10-05) — 移除 kind='user'/'group'/'computer' 单独分支:
//   所有对象统一通过 OuScopedView (selection.kind='ou' + kindFilter) 渲染, 不再走
//   UserManagementView/GroupManagementView embedded chrome (operator "快速管理这些其实不需要"
//   + "OU 虚拟节点直接列出对应的人"). dcTab/tabs/qf/history 4 块 state + 关联 handler 全删.
const selection = ref(null);

const filterText = ref('');

// ── R158.40 — OU 树 state + cache ────────────────────────────────────
const ouCache = ref([]);          // 原始 ou list (snapshot 拉的)
const ouLoading = ref(false);
const ouTree = ref([]);           // buildOuTree 输出 (roots array)
// R158.43.1 (2026-10-04) — ad_ous_snapshot 最后同步时间. null = 该 DC 从未
// 跑过 LDAP 同步 (operator 反馈 "在同步完成才加载, 没有同步完成显示暂未加载").
const ouSnapshotAt = ref(null);
const ouCacheDc = ref('');        // 当前 ouCache 所属 DC (切换 DC 时跟 ouSnapshotAt 一起重置)
const expandedDnSet = ref(new Set());
const builtinGroups = ref([]);     // CN=Builtin 内置组 (snapshot)
const builtinGroupsLoading = ref(false);
const ouActionSubmitting = ref(false);
// R158.45.15 (2026-10-05) — ComputerList 选中行高亮. OU scope 内 computer 行
// click 不切 selection.kind, 只通过此 ref 让 ComputerList 高亮当前行.
const computerSelectedSam = ref('');

// filteredOuRoots — 按 filterText 模糊匹配的根节点; 命中节点保留其祖先.
// R158.45.23 (2026-10-05) — operator 决策: 过滤字段从 name 扩到 name ∪ dn ∪ description.
//   DN 是 FQDN (例 OU=SPHKDL,DC=sphkdl,DC=shaphar), 片段搜 "rhakdn" 也能定位.
//   description 偶尔 OU 维护员会写 (例 "财务部"), 多一个线索.
const filteredOuRoots = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return ouTree.value;
  // 用扁平遍历收集匹配节点, 然后从根向上保留祖先链.
  const matched = new Set();
  function walk(nodes) {
    for (const n of nodes) {
      const hitName = (n.name || '').toLowerCase().includes(q);
      const hitDn = (n.dn || '').toLowerCase().includes(q);
      const hitDesc = (n.description || '').toLowerCase().includes(q);
      if (hitName || hitDn || hitDesc) {
        matched.add(n.dn);
      }
      walk(n.children || []);
    }
  }
  walk(ouTree.value);
  // 过滤 — 节点在 matched 或 任何后代在 matched.
  const keep = new Set(matched);
  function addAncestors(n) {
    if (n.parentDn && !keep.has(n.parentDn)) {
      const parent = findNodeByDn(ouTree.value, n.parentDn);
      if (parent) {
        keep.add(parent.dn);
        addAncestors(parent);
      }
    }
  }
  for (const dn of matched) {
    const n = findNodeByDn(ouTree.value, dn);
    if (n) addAncestors(n);
  }
  function filterTree(nodes) {
    return nodes.filter(n => keep.has(n.dn)).map(n => ({
      ...n,
      children: filterTree(n.children || [])
    }));
  }
  return filterTree(ouTree.value);
});
function findNodeByDn(nodes, dn) {
  for (const n of nodes) {
    if (n.dn === dn) return n;
    const found = findNodeByDn(n.children || [], dn);
    if (found) return found;
  }
  return null;
}

// ── 数据加载 ────────────────────────────────────────────────────────
// R158.43.2 (2026-10-04) — refreshAll 不再写 sites.value, 只写 overviewDcs.
// 概览页 DC tile 走 overviewDcs (扁平), picker sites 走 loadDomainSites (分组).
// 单一数据源, 不再因 agents/picker 两种格式 shape 不同互相覆盖.
async function refreshAll() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.get('/api/dashboard/agents');
    const agents = r.data.agents || [];
    overviewDcs.value = agents.map(a => ({
      hostname: a.hostname || a.dcName || a.agentId || '(unknown)',
      status: a.status || 'unknown',
      lockedCount: a.lockedCount || 0,
      lastQuickfixAt: a.lastQuickfixAt || null
    })).sort((a, b) => a.hostname.localeCompare(b.hostname));
  } catch (e) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}

async function refreshDirectoryStatus() {
  try {
    const r = await api.get('/api/admin/directory-sync/status');
    directoryConfigured.value = Boolean(r.data?.configured);
    directoryLastRun.value = r.data?.lastRun?.startedAt || null;
    if (directoryLastRun.value) {
      const ageMs = Date.now() - new Date(directoryLastRun.value).getTime();
      directoryStale.value = ageMs > 24 * 60 * 60 * 1000;
    } else {
      directoryStale.value = true;
    }
  } catch {
    directoryConfigured.value = false;
    directoryLastRun.value = null;
    directoryStale.value = true;
  }
}

async function loadForests() {
  try {
    const r = await forestRegistryApi.listForests();
    forests.value = r.data.forests || [];
    if (forests.value.length > 0 && !topContext.value?.forestId) {
      // R158.52 — strict === true check. A legacy forest row with isDefault=null
      // would have falsely matched `find(f => f.isDefault)` and selected a
      // non-default forest as default. Cosmetic, but matters for multi-forest
      // deployments.
      const def = forests.value.find(f => f.isDefault === true);
      const fid = def ? def.id : forests.value[0].id;
      await loadDomains(fid);
    }
  } catch {
    forests.value = [];
  }
}
// R158.41 sites (2026-10-03) — loadDomains 跨域并发探测后调 loadDomainSites,
// R158.41.2 — 默认域选择策略延续: 优先 root 域, 但 root 域 0 DC 时跳到第一个有 DC 的 child.
async function loadDomains(forestId) {
  if (!forestId) {
    domains.value = [];
    dcs.value = [];
    sites.value = [];
    return;
  }
  try {
    const r = await forestRegistryApi.listDomains(forestId);
    domains.value = r.data.domains || [];
    const root = domains.value.find(d => d.role === 'root');
    const ordered = root
      ? [root, ...domains.value.filter(d => d.id !== root.id)]
      : domains.value;
    const counts = await Promise.all(
      ordered.map(async d => {
        try {
          const x = await adminApi.listDcsByDomain(d.id);
          return { id: d.id, count: x.data?.dcs?.length || 0 };
        } catch { return { id: d.id, count: 0 }; }
      })
    );
    const firstWithDc = counts.find(c => c.count > 0);
    const targetId = firstWithDc?.id ?? root?.id ?? ordered[0]?.id;
    if (targetId != null) {
      // R158.41 sites — 默认域选定后, 拉该域下的站点列表.
      await loadDomainSites(targetId);
    }
  } catch {
    domains.value = [];
    dcs.value = [];
    sites.value = [];
  }
}
// R158.41 sites (2026-10-03) — loadDomainSites: 拉 dcs-catalog/by-domain 端点,
// 按 siteId 分组出 [{id, name, dcCount}], 传给 TopContextPicker 作 sites prop.
// 同时填充 dcs.value 供 dcs dropdown 使用 (默认 site 由 TopContextPicker 自己选).
async function loadDomainSites(domainId) {
  if (!domainId) {
    sites.value = [];
    dcs.value = [];
    return;
  }
  try {
    const r = await adminApi.listDcsByDomain(domainId);
    const dcList = r.data?.dcs || [];
    // 按 siteId 分组 — null siteId 归到 '(未分配站点)' 占位.
    const bySite = new Map();
    for (const d of dcList) {
      const siteKey = d.siteId ?? 'unassigned';
      const siteName = d.siteName || '(未分配站点)';
      if (!bySite.has(siteKey)) {
        bySite.set(siteKey, { id: siteKey, name: siteName, dcCount: 0, isHub: false, dcs: [] });
      }
      const entry = bySite.get(siteKey);
      entry.dcCount += 1;
      // 站点 isHub 取 OR — 同 site 下任意 DC 标 isHub=true, 整站排前.
      if (d.isHub) entry.isHub = true;
      entry.dcs.push(d);
    }
    sites.value = [...bySite.values()].sort((a, b) => {
      // R158.60.15 (2026-10-09) — operator "HUB 站点默认排前面". HUB 是
      // 站点**类型** (ad_sites.is_hub), 不是名字. 任何 name 叫 "HUB"
      // 的非 hub 类型站点不会被优先 (避免跟中文/英文站点重名时误判).
      // 排序: 1) isHub=true 排最前; 2) 有 DC 优先; 3) 其余 localeCompare.
      if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
      // 第一个有 DC 的站点靠前 (R158.41.2 "有资源优先" 思想延续).
      if ((a.dcCount > 0) !== (b.dcCount > 0)) return b.dcCount - a.dcCount;
      return a.name.localeCompare(b.name);
    });
    dcs.value = dcList;
    // R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
    //   OU 树按域加载, 不再默认预设 site/dc. topContext 只设 domainId, 让 watch 触发
    //   loadOuTree. 写动作需要 dc 时, operator 主动从 TopContextPicker 选 (默认
    //   TopContextPicker 自身会在 sites/dcs 变化时自动选第一个 PDC).
    topContext.value = {
      forestId: topContext.value?.forestId ?? null,
      domainId,
      siteId: topContext.value?.siteId ?? null,
      dcHostname: topContext.value?.dcHostname ?? ''
    };
  } catch {
    sites.value = [];
    dcs.value = [];
  }
}

// R158.41 sites (2026-10-03) — topContext 联动: siteId 变化时重新按 siteId 过滤 DC,
// 设置 topContext 新 4 元组, 触发 loadOuTree.
// 保留原 onDomainChange (域变了 → 清空 site + dc, 触发 loadDomainSites).
async function onDomainChange(newDomainId) {
  if (!newDomainId) {
    dcs.value = [];
    sites.value = [];
    return;
  }
  await loadDomainSites(newDomainId);
}

// topContext change → 拉 OU + 内置组. 深 watch 维持 (R158.40 旧逻辑).
// R158.45.10 — OU 树按 domain 加载 (loadOuTree 走 domainName, 站点/DC 切不影响).
// R158.45.34 (2026-10-06) — operator "必须按顺序选森林→域→站点→DC 才显示":
//   触发条件改回 dcHostname (R158.45.10 之前的语义), 4 级 picker 选完 DC 才出树.
watch(topContext, async (tc) => {
  if (!tc?.dcHostname) {
    ouCache.value = [];
    ouTree.value = [];
    builtinGroups.value = [];
    // R158.43.1 — DC 清空时 ouSnapshotAt 跟 ouCacheDc 一起清, UI 显示 "暂未加载".
    ouSnapshotAt.value = null;
    ouCacheDc.value = '';
    return;
  }
  // R158.43.1 — 切域/DC 时先清旧 snapshot 状态 (避免上一域的 ouSnapshotAt 残留闪屏).
  // R158.45.34 — trigger 用 dcHostname, 但 cacheKey 沿用 domainId (跟 loadOuTree 内部 ouCacheDc 一致).
  const cacheKey = `${tc.domainId}`;
  if (ouCacheDc.value && ouCacheDc.value !== cacheKey) {
    ouSnapshotAt.value = null;
    ouCache.value = [];
    ouTree.value = [];
    builtinGroups.value = [];
  }
  loadOuTree(tc.domainId, topContextDomainName.value);
}, { deep: true });

// OU 切换时, topContext.domainId 变更 → loadOuTree.
// loadOuTree 拉一次 ad_ous_snapshot + ad_users_snapshot + ad_groups_snapshot,
// 按 OU DN 一次扫描填 userCount/groupCount, 重建树.
// R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
//   接受 domainId + domainName (FQDN). domainId 作 cacheKey (切站点/DC 不重载),
//   domainName 走新后端 `domain` 参数跳过 hostnameToDomainName 转换.
//   写动作仍要 dc (DC 级操作), 顶部 pick 站点/DC 用于写动作 targetDc.
async function loadOuTree(domainId, domainName) {
  if (!domainId || !domainName) return;
  ouLoading.value = true;
  builtinGroupsLoading.value = true;
  try {
    // R158.45.10 — 4 个 snapshot endpoint 都接受 `domain` 参数 (后端先改 R158.45.10
    // 接受 dc OR domain). 传 domainName 直接查 ad_*_snapshot, 跳过 hostname 转换.
    const [ousRes, usersRes, groupsRes, computersRes] = await Promise.all([
      adminApi.listAdOusByDomain(domainName),
      adminApi.listAdUsersByDomain({ domain: domainName, limit: 5000 }),
      adminApi.listAdGroupsByDomain({ domain: domainName, limit: 5000 }),
      adminApi.listAdComputersByDomain({ domain: domainName, limit: 5000 })
    ]);
    ouCache.value = ousRes.data?.ous || [];
    // R158.43.1 (2026-10-04) — operator 反馈 "在同步完成才加载, 没有同步完成
    // 显示暂未加载". snapshotAt 反映 ad_ous_snapshot 最后同步时间 (来自
    // /api/admin/ad-ous 的 MAX(snapshot_at)). 没用过的域 = null = "暂未加载".
    ouSnapshotAt.value = ousRes.data?.snapshotAt || null;
    ouCacheDc.value = `${domainId}`;
    // Builtin 内置组 (DN 包含 CN=Builtin)
    builtinGroups.value = (groupsRes.data?.groups || []).filter(g =>
      /CN=Builtin(,|$)/i.test(g.distinguishedName || '')
    );
    // 一次扫描填 userCount / groupCount / computerCount (snapshot DN → OU DN 配对).
    const users = usersRes.data?.users || [];
    const groups = groupsRes.data?.groups || [];
    const computers = computersRes.data?.computers || [];
    const { userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn } =
      countUsersGroupsComputers(users, groups, computers);
    ouTree.value = buildOuTree(ouCache.value, userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn);
    // R158.45.32 (2026-10-05) — operator "顶级 OU 默认折叠, 我点 caret 才展开":
    //   之前默认 add 每个 root OU dn → 顶级 OU 默认展开 + 子 OU 全展开. 改成
    //   **不自动 add**, OuTreeNode caret `▸`/`▾` 已就绪 (R158.40 L39-42), operator
    //   手动点 caret 展开. 也保留 operator 之前手动展开状态 (next = copy).
    if (ouTree.value.length > 0) {
      expandedDnSet.value = new Set(expandedDnSet.value);
    }
  } catch (e) {
    ouCache.value = [];
    ouTree.value = [];
    builtinGroups.value = [];
    ouSnapshotAt.value = null;
    ouCacheDc.value = `${domainId}`;
    error.value = e.response?.data?.error || e.message;
  } finally {
    ouLoading.value = false;
    builtinGroupsLoading.value = false;
  }
}

// stripFirstRdn / firstRdnValue / buildOuTree / countUsersAndGroups 已抽到
// ../../utils/ouTreeBuilder.js (R158.43), 此处仅 import 复用.

// OU 节点 userCount / groupCount / computerCount: 后端按 ouDn 过滤拉一次
// (轻量, OU 切换时 fetch). R158.44.7.10 — 加 computerCount (第 3 counter).
async function refreshOuCounts(ouDn) {
  if (!ouDn || !topContext.value?.dcHostname) return;
  // 在 OU 树节点的 userCount/groupCount/computerCount 属性上挂值.
  // 这里用 cache, 切换 OU 时即时拉一次 1000 上限.
  try {
    const [usersRes, groupsRes, computersRes] = await Promise.all([
      adminApi.listAdUsers({ dc: topContext.value.dcHostname, ouDn, limit: 1000 }),
      adminApi.listAdGroups({ dc: topContext.value.dcHostname, ouDn, limit: 1000 }),
      adminApi.listAdComputers({ dc: topContext.value.dcHostname, ouDn, limit: 1000 })
    ]);
    const n = findNodeByDn(ouTree.value, ouDn);
    if (n) {
      n.userCount = Number(usersRes.data?.total || usersRes.data?.users?.length || 0);
      n.groupCount = Number(groupsRes.data?.total || groupsRes.data?.groups?.length || 0);
      n.computerCount = Number(computersRes.data?.total || computersRes.data?.computers?.length || 0);
    }
  } catch {
    /* ignore */
  }
}

// ── 选择 / 展开 ────────────────────────────────────────────────────
// R158.45.21 — DC 选中仅设 selection, 不再设 dcTab / 不再 loadDcHistory
// (历史 tab 已删). 右栏 DcOverviewPanel 单独从 selection.hostname 拿上下文.
function selectDc(hostname) {
  selection.value = { kind: 'dc', hostname };
}
function onSelectOu(node) {
  selection.value = { kind: 'ou', dc: topContext.value?.dcHostname, dn: node.dn, node };
  // R158.45.19 — 切 OU 后清 focusedObj, 右栏回到 OU Action Panel (创建子 OU 等)
  // 而不是显示上一个 OU 选中的 user/group 属性.
  focusedObj.value = null;
  // 默认展开当前 OU
  const next = new Set(expandedDnSet.value);
  next.add(node.dn);
  expandedDnSet.value = next;
}
function onSelectBuiltin(node) {
  selection.value = { kind: 'builtin', dc: topContext.value?.dcHostname, dn: node.dn, node };
}
// R158.45.27 (2026-10-05) — operator "颠倒 OU 树虚拟节点 (👤 用户) →
// 直接列出对应的人即可, 不要走 ad 用户管理". 改成 selection.kind='ou' +
// kindFilter: 'user'/'group'/'computer'. OuScopedView 内部 v-if 按 kindFilter
// 决定渲染哪一类. 不再切到 selection.kind='user'/'group' (那条线触发的
// UserManagementView/GroupManagementView embedded chrome + OPERATIONS · AD 用户管理
// header, operator 不要). 树上的虚拟节点点击 = "切 OU 同 view + 按类型筛".
function onSelectOuUsers(ouDn) {
  // 找 ouCache/ouTree 里对应 dn 的 node, 跟 onSelectOu 同形.
  const node = findNodeByDn(ouTree.value, ouDn);
  selection.value = {
    kind: 'ou',
    dc: topContext.value?.dcHostname,
    dn: ouDn,
    node,
    kindFilter: 'user'
  };
  focusedObj.value = null;
  const next = new Set(expandedDnSet.value);
  next.add(ouDn);
  expandedDnSet.value = next;
}
function onSelectOuGroups(ouDn) {
  const node = findNodeByDn(ouTree.value, ouDn);
  selection.value = {
    kind: 'ou',
    dc: topContext.value?.dcHostname,
    dn: ouDn,
    node,
    kindFilter: 'group'
  };
  focusedObj.value = null;
  const next = new Set(expandedDnSet.value);
  next.add(ouDn);
  expandedDnSet.value = next;
}
function onSelectOuComputers(ouDn) {
  const node = findNodeByDn(ouTree.value, ouDn);
  selection.value = {
    kind: 'ou',
    dc: topContext.value?.dcHostname,
    dn: ouDn,
    node,
    kindFilter: 'computer'
  };
  focusedObj.value = null;
  const next = new Set(expandedDnSet.value);
  next.add(ouDn);
  expandedDnSet.value = next;
}
// R158.45.27 — toolbar chip 切换 kindFilter (不切 selection.dn 持久化 OU 选中感).
function onKindChange(newKind) {
  if (!selection.value) return;
  selection.value = { ...selection.value, kindFilter: newKind };
}
// R158.45.19 (2026-10-05) — operator "点中栏账户 → 右栏出现可操作项目, 中栏
// 不要进 management 界面": 不切 selection.kind (保持 'ou' 让中栏仍渲染
// OuScopedView unified list), 只更新 focusedObj 让右栏 panel 切到对应属性面板.
// 右栏 panel 跟中栏 selected row 共享同一对象引用 (selection.focusedObj).
const focusedObj = ref(null);

// R158.45.32 (2026-10-05) — operator "点 Root OU → 右栏筛选入口":
//   ouFilter 是顶层 state, 透传给 OuScopedView :filter. 右栏 OuFilterPanel
//   通过 emit('filter-change', v) 修改. 切 OU / DC / 域 → 清空避免 filter
//   残留作用到下次 OU.
const ouFilter = ref('');
watch(() => selection.value?.dn, () => {
  // 切 OU 节点 → 清 filter, 让新 OU 从 "显示全部" 开始.
  ouFilter.value = '';
});
function onOuFilterChange(v) {
  ouFilter.value = v;
  // 改 filter 时清 focusedObj, 避免右栏同时显示 user 属性 + OuFilterPanel.
  focusedObj.value = null;
}

function onSelectUser({ dc, sam }) {
  // R158.45.19 — 不切 selection.kind (否则中栏会换到 UserManagementView).
  // R158.45.31 (2026-10-05) — operator "单击选中, 再点取消": 同对象再点 → 清.
  const cur = focusedObj.value;
  if (cur && cur.kind === 'user' && cur.sam === sam && cur.dc === dc) {
    focusedObj.value = null;
    return;
  }
  focusedObj.value = { kind: 'user', dc, sam };
}
function onSelectGroup({ dc, name }) {
  // R158.45.31 — 同对象再点取消 (跟 user 一致).
  const cur = focusedObj.value;
  if (cur && cur.kind === 'group' && cur.name === name && cur.dc === dc) {
    focusedObj.value = null;
    return;
  }
  focusedObj.value = { kind: 'group', dc, name };
}
// R158.45.19 — computer 之前走 computerSelectedSam 路径, 现在跟 user/group
// 一致走 focusedObj. selection.kind 保持 'ou', 中栏 OuScopedView 不动.
// R158.45.31 — 加 toggle 逻辑.
function onSelectComputer({ dc, sam }) {
  const cur = focusedObj.value;
  if (cur && cur.kind === 'computer' && cur.sam === sam && cur.dc === dc) {
    computerSelectedSam.value = '';
    focusedObj.value = null;
    return;
  }
  computerSelectedSam.value = sam;
  focusedObj.value = { kind: 'computer', dc, sam };
}
// R158.41 no-pkg-entry — 移除 selectPackage 函数.

function onToggleExpand(dn) {
  const next = new Set(expandedDnSet.value);
  if (next.has(dn)) next.delete(dn);
  else next.add(dn);
  expandedDnSet.value = next;
}

// ── OuActionPanel 写动作入队 (ou_create / object_delete / user_create / group_create) ──
async function onOuAction({ commandType, params, onResult }) {
  if (!topContext.value?.dcHostname) {
    onResult({ ok: false, text: '未选 DC, 无法提交' });
    return;
  }
  ouActionSubmitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: topContext.value.dcHostname,
      commandType,
      params
    });
    onResult({
      ok: true,
      text: `已入队 (id=${r.data?.id ?? r.data?.commandId ?? '?'})`
    });
    // 写成功后 2s 重新拉 OU 树 (新建的 OU 立刻可见, 删除的 OU 消失)
    // R158.45.10 — OU 树按 domain 加载 (operator 决策), reload 用 domain.
    setTimeout(() => loadOuTree(topContext.value.domainId, topContextDomainName.value), 2000);
  } catch (e) {
    onResult({
      ok: false,
      text: e.response?.data?.error || e.message || '提交失败'
    });
  } finally {
    ouActionSubmitting.value = false;
  }
}

async function loadDcHistory(hostname) {
  try {
    const r = await api.get('/api/admin/ad-account/quickfix-history', { params: { dc: hostname } });
    history.value = r.data.runs || [];
  } catch (e) {
    history.value = [];
  }
}

// R158.45.21 — 移除 loadDcHistory + submitQuickfix 函数 (quickfix/history tab 已删).
// R158.41 no-pkg-entry — 移除 loadPackageDetail / submitPackageQuickfix 函数.

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

onMounted(() => {
  refreshAll();
  refreshDirectoryStatus();
  loadForests();   // R158.41 — 顶部 4 级 dropdown
  pollTimer = setInterval(() => {
    if (polling.value) {
      refreshAll();
      refreshDirectoryStatus();
    }
  }, refreshSeconds * 1000);
});
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); });

// R158.43.1 (2026-10-04) — 相对时间格式化 (OU 树 meta + "暂未加载" 提示复用).
// "5 分钟前" / "3 小时前" / "2 天前" / "刚刚". 入参 ISO 字符串或 null.
function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

// R158.45.17 (2026-10-05) — ADUC 风格 status bar: 当前 selection 标签 +
// 摘要 + 实时时钟. 摘要给 operator 一眼看到「选中什么」, 不需要看右栏.
const selectionLabel = computed(() => {
  const k = selection.value?.kind;
  if (k === 'ou') return '📂 OU 节点';
  if (k === 'user') return '👤 用户';
  if (k === 'group') return '🛡️ 组';
  if (k === 'computer') return '💻 电脑';
  if (k === 'dc') return '🖥 DC';
  if (k === 'builtin') return '🛡 内置容器';
  return '— 未选中 —';
});

const selectionSummary = computed(() => {
  const sel = selection.value;
  if (!sel || !sel.kind) return '请在左侧树中选中节点';
  if (sel.kind === 'ou') return sel.dn || sel.node?.dn || '—';
  if (sel.kind === 'user') return `${sel.sam || ''}${sel.dn ? '  ·  ' + sel.dn : ''}`;
  if (sel.kind === 'group') return `${sel.name || ''}${sel.dn ? '  ·  ' + sel.dn : ''}`;
  if (sel.kind === 'computer') return `${sel.sam || ''}${sel.dn ? '  ·  ' + sel.dn : ''}`;
  if (sel.kind === 'dc') return sel.hostname || sel.dc || '';
  if (sel.kind === 'builtin') return sel.dn || sel.node?.dn || '';
  return '';
});

// 实时时钟 — status bar 右侧显示 HH:MM:SS. 1Hz tick, 卸载时清 timer.
const currentTime = ref(new Date().toISOString());
let _clockTimer = null;
onMounted(() => {
  _clockTimer = setInterval(() => { currentTime.value = new Date().toISOString(); }, 1000);
});
onBeforeUnmount(() => {
  if (_clockTimer) clearInterval(_clockTimer);
});

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
</script>

<style scoped>
.daily-ops-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
}
.daily-ops-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  gap: 12px;
}
.daily-ops-topbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}
.back-link {
  color: var(--muted);
  font-size: 11px;
  text-decoration: none;
  letter-spacing: 0.02em;
  transition: color 0.12s ease;
}
.back-link:hover { color: var(--accent); }
.daily-ops-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0;
}
.user-chip {
  font-size: 13px;
  color: var(--text);
}
.user-chip small { color: var(--muted); font-size: 11px; }
/* R158.60.13 (2026-10-09) — 操作平台 topbar 加 AD 运维日志入口.
   蓝色 primary 按钮, 跟 theme-toggle / logout 同形. 一键跳
   /admin/ad-management-log 看 ad_command_* 实时结果. */
.ad-mgmt-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  background: var(--accent, #3b82f6);
  color: #fff;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  border: 1px solid transparent;
  transition: filter 0.15s ease;
}
.ad-mgmt-link:hover { filter: brightness(1.12); text-decoration: none; color: #fff; }
.daily-ops-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  /* R158.45.17 (2026-10-05) — flex column 让 grid (flex: 1 1 auto) 和
     status bar (height: 24px + flex-shrink: 0) 各自管高度. 原来 overflow: hidden
     + grid height: 100% 把 status bar 挤出可视区 (0 height). */
  overflow: hidden;
  gap: 8px;
}
/* R158.45.17 (2026-10-05) — operator "中栏需要滚轮": 嵌入子组件 (User/Group/Computer
   ManagementView + OuScopedView) 根 div 需要成为 flex 子项才能继承 min-height: 0
   才能让内部表格区域滚动. 原来 display: contents 样式穿透, 子组件根 div 不参与
   布局, 内容溢出 → 整页滚动. */
.embedded-host {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* R158.36 — 三栏 grid: 320px 树 + 1fr 列表 + 380px 属性。
   ADUC (Active Directory Users & Computers) 风格: 树 / 列表 / 属性。
   窄屏 (≤1400px) 自动折叠右栏, 用 popover 替代 (后续 R 落实)。
   R158.45.17 (2026-10-05) — operator "需要滚轮": flex: 1 1 auto + min-height: 0
   让 grid 在 .daily-ops-content (flex column) 内自适应高度, 不抢 status bar 空间.
   内容溢出时各自内部滚动 (tree-scroll / table-scroll / prop-scroll) 而非整页滚. */
.daily-ops-grid {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr) 380px;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 1400px) {
  .daily-ops-grid {
    grid-template-columns: 320px minmax(0, 1fr);
  }
  .prop-panel { display: none; }
}

/* 左: 树面板 */
.tree-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.tree-toolbar {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.filter-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 13px;
}
.tree-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 4px 12px;
}
.tree-section {
  margin: 4px 8px;
}
.tree-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  cursor: pointer;
  list-style: none;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}
.tree-section-title:hover { color: var(--text); background: rgba(255,255,255,0.03); }
.tree-section-title::-webkit-details-marker { display: none; }
.ts-icon { font-size: 13px; }
.ts-meta {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.7;
}
.tree-list {
  list-style: none;
  padding: 4px 0 4px 14px;
  margin: 0;
  border-left: 1px solid var(--border);
}
.tree-leaf {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  border-radius: 3px;
  border-left: 2px solid transparent;
  margin-left: -1px;
  transition: background 0.12s ease, color 0.12s ease, border-left-color 0.12s ease;
}
.tree-leaf:hover { background: var(--border); color: var(--accent); }
.tree-leaf.active {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border-left-color: #3b82f6;
  font-weight: 600;
}
.leaf-icon { font-size: 12px; opacity: 0.8; }
.leaf-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leaf-meta {
  font-size: 10px;
  color: var(--muted);
  background: var(--input-bg);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 2px;
}
.leaf-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
}
.leaf-badge.locked {
  background: rgba(248, 113, 113, 0.18);
  color: #f87171;
}
.hb-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--muted);
}
.hb-dot.online  { background: var(--green); }
.hb-dot.warn    { background: var(--yellow); }
.hb-dot.offline { background: var(--red); }
.empty-hint { padding: 14px; color: var(--muted); font-size: 12px; }
/* R158.43.1 (2026-10-04) — OU 树"暂未加载"提示, 比普通 empty-hint 更显眼.
   operator 反馈 "在同步完成才加载, 没有同步完成显示暂未加载". */
.ou-not-synced {
  text-align: center;
  padding: 24px 14px;
  border-left: 3px solid var(--accent, #f59e0b);
  background: rgba(245, 158, 11, 0.08);
  border-radius: 4px;
  margin: 6px 4px;
}
.ou-not-synced-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent, #f59e0b);
  margin-bottom: 4px;
}
.ou-not-synced-sub {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}

/* 中: 列表面板 */
.list-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 14px 18px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* R158.45.17 — operator "中栏需要滚轮": flex 子项必须 min-height: 0
     才能缩到 0 让内部 .embedded-host 内部滚动. */
  min-height: 0;
  overflow: hidden;
}
/* R158.45.17 — 中栏默认提示页 (selection.kind='dc') 不需要 flex 行为 */
.list-panel > .detail-default { overflow: auto; }
.detail-default h3 { margin: 0 0 8px; font-size: 16px; }
.detail-default .hint { font-size: 13px; color: var(--muted); margin-bottom: 12px; }

.overview-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.ov-tile {
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.ov-tile:hover { border-color: var(--accent); }
.ov-tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ov-tile-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.locked-chip {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
  padding: 1px 6px;
  border-radius: 2px;
  align-self: flex-start;
}
.muted { color: var(--muted); }

.sync-hint {
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.5;
}
.sync-hint a { color: var(--accent); text-decoration: underline; }
.sync-hint-warn {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.detail-dc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin-bottom: 12px;
}
.detail-dc-header h3 { margin: 0; font-size: 16px; }
/* R158.45.21 — 删 .tabs/.tab/.tab-pane/.qf-form/.qf-actions/.qf-result/.t/.h-row/.h-effects
   9 个 selector (DC 视图 4-tab + quickfix/history 模板全删, 样式孤儿). */
/* R158.45.27 (2026-10-05) — DC 视图引导 hint (替换旧 4 tab). */
.dc-pivot-hint {
  padding: 16px 20px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dc-pivot-hint .hint {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  margin: 0;
}
.dc-pivot-hint em { color: var(--accent); font-style: normal; }

/* R158.41 no-pkg-entry — 移除 .detail-pkg-header / .pkg-version / .pkg-type /
   .pkg-stats / .stat / .stat strong/span / .prop-package h3 / .prop-package .hint
   共 7 个 selector (样式孤儿). */

/* 右: 属性面板 */
.prop-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 14px 18px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* R158.45.17 — operator "右栏需要滚轮": grid 子项 + flex 子项都要 min-height: 0
     才能让 panel 内部滚动 (属性字段多时整个 panel 不撑破 grid 高度). */
  min-height: 0;
  overflow: hidden;
}
/* R158.45.17 — prop-panel 内的具体面板组件 (DcOverviewPanel/UserPropertyPanel 等)
   占满 panel 高度 + 内部滚动. */
.prop-panel > * {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* R158.46b — root OU 选中时右栏上半 ActionPanel + 下半 FilterPanel 垂直堆叠.
   直接子组件 > OuActionPanel, OuFilterPanel 都各自撑满 flex 子项, 中间分隔. */
.root-ou-stack { display: flex; flex-direction: column; gap: 12px; min-height: 0; flex: 1 1 auto; overflow: hidden; }
.root-ou-stack > * { flex: 1 1 auto; min-height: 0; overflow: auto; }
.prop-empty h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.prop-empty .hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
.prop-empty strong { color: var(--text); }

/* R158.45.17 (2026-10-05) — ADUC 风格 status bar. fixed 高度 24px, 跟整体
   配色协调, 显示 selection 摘要 + 实时时钟. */
.daily-ops-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 16px;
  margin-top: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 11px;
  color: var(--text);
  flex-shrink: 0;
}
.status-section { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-section.muted { color: var(--muted); font-variant-numeric: tabular-nums; }
.status-divider { color: var(--muted); opacity: 0.5; }
.status-spacer { flex: 1 1 auto; }
</style>
