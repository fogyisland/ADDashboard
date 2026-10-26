<!--
  R158.36 (2026-10-03) — UserPropertyPanel.vue
  右侧属性 + 操作面板. 选中具体用户后渲染.

  数据源: 优先用 snapshot (adminApi.listAdUsers 拉单个用户),
  没有再 fallback 到 live (adAdminApi.queueCommand 'user_search').
  写动作全部走 adAdminApi.queueCommand 通用入口.

  操作按钮 (8 个, 替代原 6 个 modal):
    - 重置密码 (popover)
    - 启用 / 禁用 (直接 queueSimple)
    - 解锁 (直接 queueSimple)
    - 编辑属性 (popover, 含 displayName / description / UAC)
    - 设置经理 (popover, 新 command_type user_set_manager)
    - 加入组 (popover, 暂用 group_add_member 后端走不到, 改用 user_list_groups
            只读+提示, R158.36.x followup 落实)
    - 删除 (confirm popover)
-->
<template>
  <div class="user-prop-panel">
    <header class="up-head">
      <h3>用户属性</h3>
      <span v-if="loading" class="hint">加载中…</span>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!user && !loading" class="empty-hint">未找到该用户</div>

    <table v-if="user" class="up-attrs">
      <tbody>
        <tr><th>sAMAccountName</th><td><code>{{ user.sam }}</code></td></tr>
        <tr><th>显示名称</th><td>{{ user.displayName || '—' }}</td></tr>
        <tr><th>DN</th><td class="dn">{{ user.distinguishedName || '—' }}</td></tr>
        <tr><th>OU</th><td>{{ user.ouDn || '—' }}</td></tr>
        <tr><th>启用</th><td>
          <span :class="['status-pill', user.enabled ? 'ok' : 'err']">
            <span class="dot"></span>{{ user.enabled ? '启用' : '禁用' }}
          </span>
        </td></tr>
        <tr><th>锁定</th><td>
          <span :class="['status-pill', user.lockedOut ? 'err' : 'ok']">
            <span class="dot"></span>{{ user.lockedOut ? '是' : '否' }}
          </span>
        </td></tr>
        <tr><th>上次登录</th><td>{{ fmt(user.lastLogon) }}</td></tr>
        <tr><th>创建时间</th><td>{{ fmt(user.whenCreated) }}</td></tr>
        <tr><th>密码最后修改</th><td>{{ fmt(user.passwordLastSet) }}</td></tr>
        <tr><th>UAC</th><td class="mono">{{ user.userAccountControl ?? '—' }}</td></tr>
        <tr><th>描述</th><td>{{ user.description || '—' }}</td></tr>
        <tr><th>经理</th>
          <td>
            <template v-if="user.managerSam">
              {{ user.managerSam }}<small v-if="user.managerDn" class="hint"> ({{ user.managerDn }})</small>
            </template>
            <template v-else-if="user.managerDn">{{ user.managerDn }}</template>
            <template v-else>—</template>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="user" class="up-actions">
      <button ref="resetBtn" data-test="up-reset" @click="openPopover('reset')">重置密码</button>
      <button v-if="user.enabled" data-test="up-disable" @click="queueSimple('user_disable')">禁用</button>
      <button v-else data-test="up-enable" @click="queueSimple('user_enable')">启用</button>
      <button data-test="up-unlock" @click="queueSimple('user_unlock')">解锁</button>
      <button ref="attrsBtn" data-test="up-attrs" @click="openPopover('attrs')">编辑属性</button>
      <button ref="managerBtn" data-test="up-manager" @click="openPopover('manager')">设置经理</button>
      <!-- R158.60.17 (2026-10-09) — operator 反馈 "将查看和加入组分成两个按钮".
           拆成 查看组 (read-only 当前成员) + 加入组 (从候选组选一个加入).
           之前一个 popover 又读又改, 但实际没有 "加入" UI, 注释里写
           "修改组成员请用 OU 树选中目标组" (绕到 GroupPropertyPanel).
           现在直在用户面板就能加. -->
      <button ref="viewGroupsBtn" data-test="up-view-groups" @click="openPopover('viewGroups')">查看组</button>
      <button ref="addGroupBtn" data-test="up-add-group" @click="openPopover('addGroup')">加入组</button>
      <button ref="deleteBtn" class="danger" data-test="up-delete" @click="openPopover('delete')">删除</button>
    </div>

    <div v-if="banner" :class="['banner', banner.ok ? 'ok' : 'err']" data-test="up-banner">
      {{ banner.text }}<small v-if="banner.commandId"> · #{{ banner.commandId }}</small>
    </div>

    <!-- ────── Popovers ────── -->
    <!-- R158.37 — 把每个 popover 拆成独立 Popover 实例 + v-if,避免在单
         Popover 内 v-if/v-else 链内嵌 <template #actions> slot 导致
         compiler codegen 在 genConditionalExpression 处报 undefined.type。
         Vue 3 不允许 slot <template #xxx> 在 v-if 分支内被解析为命名 slot,
         必须直接位于组件子层。 -->

    <Popover v-if="user && activePopover === 'reset'" :anchor="popoverAnchors.reset"
             :open="!!activePopover" :title="popoverTitles.reset"
             @close="activePopover = null">
      <label>新密码
        <input v-model="forms.reset.newPassword" type="password" autocomplete="new-password" />
      </label>
      <label><input type="checkbox" v-model="forms.reset.mustChange" /> 用户下次登录必须修改</label>
      <label><input type="checkbox" v-model="forms.reset.unlock" /> 同时解锁账户</label>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!forms.reset.newPassword || submitting" @click="submitReset">提交</button>
      </template>
    </Popover>

    <Popover v-if="user && activePopover === 'attrs'" :anchor="popoverAnchors.attrs"
             :open="!!activePopover" :title="popoverTitles.attrs"
             @close="activePopover = null">
      <label>显示名称 <input v-model="forms.attrs.displayName" /></label>
      <label>描述 <input v-model="forms.attrs.description" /></label>
      <label>UAC (整数)
        <input v-model="forms.attrs.userAccountControl" type="number" min="0" max="4294967295" />
      </label>
      <p class="hint">留空 = 不修改该字段</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!attrsDirty || submitting" @click="submitAttrs">提交</button>
      </template>
    </Popover>

    <Popover v-if="user && activePopover === 'manager'" :anchor="popoverAnchors.manager"
             :open="!!activePopover" :title="popoverTitles.manager"
             @close="activePopover = null">
      <!-- R158.60.16 (2026-10-09) — operator "经理会默认提取出所有账户,
           支持按照用户名 显示名筛选". 改文本 input → dropdown, 打开 popover
           自动 listAdUsersByDomain 拉候选 (按 sam / displayName 匹配), filter
           实时刷新. 后端 SQL 已 (sam LIKE ? OR display_name LIKE ?) R158.45.30
           联调, 0 改. -->
      <label>经理 <small class="hint">(搜用户名/显示名, 从列表选)</small>
        <input v-model="managerFilter" placeholder="例如 jdoe 或 张三" data-test="up-manager-filter" />
      </label>
      <div v-if="loadingManager" class="hint">加载候选账户…</div>
      <div v-else-if="!managerCandidates.length" class="hint">未找到匹配账户</div>
      <ul v-else class="candidate-list" data-test="up-manager-list">
        <li v-for="u in managerCandidates" :key="`${u.sam}|${u.dn}`"
            :class="['candidate', { selected: forms.manager.sam === u.sam }]"
            :data-test="`up-manager-cand-${u.sam}`"
            @click="forms.manager.sam = u.sam">
          <span class="sam">{{ u.sam }}</span>
          <span v-if="u.displayName" class="display"> — {{ u.displayName }}</span>
        </li>
      </ul>
      <p class="hint">将用户 <code>{{ user.sam }}</code> 的 manager 属性指向该用户。留空 + 点 提交 = 清除经理。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="submitting" @click="submitManager">提交</button>
      </template>
    </Popover>

    <Popover v-if="user && activePopover === 'viewGroups'" :anchor="popoverAnchors.viewGroups"
             :open="!!activePopover" :title="popoverTitles.viewGroups"
             @close="activePopover = null">
      <div v-if="loadingGroups" class="hint">加载中…</div>
      <div v-else-if="!groups.length" class="hint">该用户未加入任何组</div>
      <ul v-else class="group-list" data-test="up-view-groups-list">
        <li v-for="g in groups" :key="g">{{ g }}</li>
      </ul>
      <p class="hint">要从已有组移除, 请到左侧 <strong>OU 树</strong> 选中目标组 (或中栏 <strong>🛡 组</strong> 行) 后操作。</p>
      <template #actions>
        <button @click="activePopover = null">关闭</button>
      </template>
    </Popover>

    <Popover v-if="user && activePopover === 'addGroup'" :anchor="popoverAnchors.addGroup"
             :open="!!activePopover" :title="popoverTitles.addGroup"
             @close="activePopover = null">
      <!-- R158.60.17 (2026-10-09) — 加入组 popover. 默认 listAdGroupsByDomain
           拉当前域所有候选组, filter 实时刷新. 提交 group_add_member
           (params.name=<group>, members=[<samOfCurrentUser>]). group_add_member
           在 ad-admin-groups.ps1:262 走 Add-ADGroupMember, name + members 是
           固定契约 (R158.46 user_/group_ 17 命令). 排除已加入的组, 避免
           operator 选到已加入组触发 AD 重复 member 警告. -->
      <label>选择组 <small class="hint">(搜组名, 排除已加入的组)</small>
        <input v-model="addGroupFilter" placeholder="例如 Domain Admins" data-test="up-add-group-filter" />
      </label>
      <div v-if="loadingAddGroupCandidates" class="hint">加载候选组…</div>
      <div v-else-if="!addGroupCandidates.length" class="hint">未找到可加入的组</div>
      <ul v-else class="candidate-list" data-test="up-add-group-list">
        <li v-for="g in addGroupCandidates" :key="`${g.sam}|${g.dn}`"
            :class="['candidate', { selected: forms.addGroup.name === g.sam }]"
            :data-test="`up-add-group-cand-${g.sam}`"
            @click="forms.addGroup.name = g.sam">
          <span class="sam">{{ g.sam }}</span>
          <span v-if="g.displayName && g.displayName !== g.sam" class="display"> — {{ g.displayName }}</span>
          <span v-if="g.memberCount != null" class="count"> ({{ g.memberCount }} 人)</span>
        </li>
      </ul>
      <p class="hint">把 <code>{{ user.sam }}</code> 加入所选组。已加入的组自动排除。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!forms.addGroup.name || submitting" @click="submitAddGroup">加入</button>
      </template>
    </Popover>

    <Popover v-if="user && activePopover === 'delete'" :anchor="popoverAnchors.delete"
             :open="!!activePopover" :title="popoverTitles.delete"
             @close="activePopover = null">
      <p>确定删除用户 <code>{{ user.sam }}</code> 吗? 此操作不可撤销。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="danger" :disabled="submitting" @click="submitDelete">确认删除</button>
      </template>
    </Popover>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Popover from '../../components/Popover.vue';
import { adAdminApi } from '../../api/ad-admin.js';
import { adminApi } from '../../api/admin.js';

const props = defineProps({
  dc: { type: String, required: true },
  // R158.45.33 (2026-10-05) — OU 树按域加载 (R158.45.10) 后, OuScopedView 走
  //   listAdUsersByDomain 路径时 props.dc=''. UserPropertyPanel 之前只传 dc
  //   → server /api/admin/ad-users 400 ('dc or domain required'). 加 domain,
  //   优先 listAdUsersByDomain (跟中栏 fetch 对齐, 同一份 snapshot 表, 一致性).
  domain: { type: String, default: '' },
  sam: { type: String, required: true },
  dataSource: { type: String, default: 'live' }
});

const loading = ref(false);
const error = ref('');
const submitting = ref(false);
const user = ref(null);
const banner = ref(null);
const activePopover = ref(null);
const groups = ref([]);
const loadingGroups = ref(false);

// R158.60.16 — manager dropdown state
const managerFilter = ref('');
const managerCandidates = ref([]);
const loadingManager = ref(false);
// R158.60.17 — addGroup popover state
const addGroupFilter = ref('');
const addGroupCandidates = ref([]);
const loadingAddGroupCandidates = ref(false);

// Template refs for popover anchors.
const resetBtn = ref(null);
const attrsBtn = ref(null);
const managerBtn = ref(null);
const viewGroupsBtn = ref(null);
const addGroupBtn = ref(null);
const deleteBtn = ref(null);
const popoverAnchors = { reset: resetBtn, attrs: attrsBtn, manager: managerBtn, viewGroups: viewGroupsBtn, addGroup: addGroupBtn, delete: deleteBtn };
const popoverTitles = { reset: '重置密码', attrs: '编辑属性', manager: '设置经理', viewGroups: '查看组', addGroup: '加入组', delete: '删除用户' };

const forms = reactive({
  reset:  { newPassword: '', mustChange: true, unlock: true },
  attrs:  { displayName: '', description: '', userAccountControl: '' },
  manager:{ sam: '' },
  addGroup:{ name: '' }
});

const attrsDirty = computed(() => {
  if (!user.value) return false;
  return forms.attrs.displayName !== ''
      || forms.attrs.description !== ''
      || forms.attrs.userAccountControl !== '';
});

function openPopover(name) {
  activePopover.value = name;
  if (name === 'attrs' && user.value) {
    forms.attrs.displayName = '';
    forms.attrs.description = '';
    forms.attrs.userAccountControl = '';
  }
  if (name === 'manager' && user.value) {
    forms.manager.sam = user.value.managerSam || '';
    managerFilter.value = '';
    loadManagerCandidates();
  }
  if (name === 'viewGroups') {
    loadGroups();
  }
  if (name === 'addGroup') {
    forms.addGroup.name = '';
    addGroupFilter.value = '';
    loadAddGroupCandidates();
  }
}

async function loadGroups() {
  loadingGroups.value = true;
  try {
    // R158.60.20 (2026-10-09) — replaced the R75 ad_user_list_groups agent
    // poll (22.5s timeout) with a direct read of the 5-min sync'd
    // ad_user_group_memberships table. Backend:
    //   GET /api/admin/ad-users/:sam/groups?domain=<fqdn>
    // Response: { groups: [string], snapshotAt, sam, domain }.
    // Staleness: 5-min sync lag is acceptable for the "查看组" view
    // (operator decision R158.60.20). Falls back to R75 if the snapshot
    // table is empty AND props.dc is set (live agent still works).
    if (props.domain) {
      const r = await adminApi.listAdUserGroupsByDomain({ domain: props.domain, sam: props.sam });
      groups.value = Array.isArray(r.data?.groups) ? r.data.groups : [];
      return;
    }
    // Legacy fallback: queue R75 command (used when the parent view passes
    // only dc without domain, e.g. older binding paths). Keeps the
    // popover functional in mixed environments.
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'user_list_groups',
      params: { sam: props.sam }
    });
    const id = r.data?.id;
    if (!id) { groups.value = []; return; }
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const c = await adAdminApi.getCommand(id);
      const d = c.data;
      if (d?.status === 'success') {
        groups.value = (d?.result?.data?.groups || d?.data?.groups || []);
        return;
      }
      if (d?.status === 'failed' || d?.status === 'timeout') {
        error.value = d?.errorMessage || '加载成员组失败';
        groups.value = [];
        return;
      }
    }
    error.value = '加载成员组超时';
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message;
    groups.value = [];
  } finally {
    loadingGroups.value = false;
  }
}

// R158.60.16 — manager dropdown 候选账户. 后端 /api/admin/ad-users 已支持
// (sam LIKE ? OR display_name LIKE ?), filter 任意子串匹配, dc 跟 domain 二选一.
// dc 模式 (dataSource='live') 走 listAdUsers 跟 props.dc; domain 模式
// (dataSource='snapshot') 走 listAdUsersByDomain 跟 props.domain.
async function loadManagerCandidates() {
  loadingManager.value = true;
  try {
    const filter = managerFilter.value || '';
    const r = props.domain
      ? await adminApi.listAdUsersByDomain({ domain: props.domain, filter, limit: 50 })
      : await adminApi.listAdUsers({ dc: props.dc, filter, limit: 50 });
    managerCandidates.value = (r.data?.users || []).map(u => ({
      sam: u.sam,
      displayName: u.displayName || u.description || '',
      dn: u.dn || ''
    }));
  } catch (e) {
    managerCandidates.value = [];
  } finally {
    loadingManager.value = false;
  }
}

// R158.60.17 — 加入组 popover 候选组. 跟 manager 同架构 (snapshot 走
// listAdGroupsByDomain, dc 走 listAdGroups). 已加入的组从列表排除, 避免
// 重复 Add-ADGroupMember 触发 AD 警告. group.sam 是组 sAMAccountName
// (displayName 在 AD 里几乎跟 sam 一样, 例 "Domain Admins" / "Domain Users"),
// 入参用 sam 跟 group_add_member 契约对齐.
async function loadAddGroupCandidates() {
  loadingAddGroupCandidates.value = true;
  try {
    const filter = addGroupFilter.value || '';
    const r = props.domain
      ? await adminApi.listAdGroupsByDomain({ domain: props.domain, filter, limit: 200 })
      : await adminApi.listAdGroups({ dc: props.dc, filter, limit: 200 });
    const all = (r.data?.groups || r.data?.items || []).map(g => ({
      sam: g.sam || g.name,
      displayName: g.displayName || g.description || g.name || '',
      dn: g.dn || '',
      memberCount: g.memberCount
    }));
    const alreadyJoined = new Set(groups.value.map(s => s.toLowerCase()));
    addGroupCandidates.value = all.filter(g => !alreadyJoined.has((g.sam || '').toLowerCase()));
  } catch (e) {
    addGroupCandidates.value = [];
  } finally {
    loadingAddGroupCandidates.value = false;
  }
}

// R158.60.16 — manager filter 实时刷新 (250ms debounce)
let managerDebounce = null;
watch(managerFilter, () => {
  if (activePopover.value !== 'manager') return;
  clearTimeout(managerDebounce);
  managerDebounce = setTimeout(loadManagerCandidates, 250);
});
// R158.60.17 — addGroup filter 实时刷新
let addGroupDebounce = null;
watch(addGroupFilter, () => {
  if (activePopover.value !== 'addGroup') return;
  clearTimeout(addGroupDebounce);
  addGroupDebounce = setTimeout(loadAddGroupCandidates, 250);
});
// R158.60.17 — 候选组依赖 groups (排除已加入的). groups 加载完 (viewGroups popover)
// 后再开 addGroup popover 时, 候选组基于最新 groups 重新过滤. 但 openPopover 已
// 自动 reload, 不需要这里再 watch groups.

async function fetchUser() {
  loading.value = true;
  error.value = '';
  try {
    if (props.dataSource === 'snapshot') {
      // R158.45.33 — domain 模式 (OuScopedView 用 listAdUsersByDomain 拉) 用
      //   listAdUsersByDomain 查单 user; dc 模式走原 listAdUsers. 跟中栏 fetch 对齐.
      const r = props.domain
        ? await adminApi.listAdUsersByDomain({ domain: props.domain, filter: props.sam, limit: 5 })
        : await adminApi.listAdUsers({ dc: props.dc, filter: props.sam, limit: 1, offset: 0 });
      user.value = (r.data?.users || []).find(u => u.sam?.toLowerCase() === props.sam.toLowerCase()) || null;
    } else {
      const r = await adAdminApi.queueCommand({
        targetDc: props.dc,
        commandType: 'user_search',
        params: { filter: props.sam, limit: 5 }
      });
      const id = r.data?.id;
      if (!id) { user.value = null; return; }
      for (let i = 0; i < 15; i++) {
        await new Promise(rr => setTimeout(rr, 1500));
        const c = await adAdminApi.getCommand(id);
        const d = c.data;
        if (d?.status === 'success') {
          const list = d?.data?.users || d?.result?.data?.users || [];
          user.value = list.find(u => u.sam?.toLowerCase() === props.sam.toLowerCase()) || null;
          return;
        }
        if (d?.status === 'failed' || d?.status === 'timeout') {
          error.value = d?.errorMessage || '查询用户失败';
          user.value = null;
          return;
        }
      }
      error.value = '查询用户超时';
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message;
    user.value = null;
  } finally {
    loading.value = false;
  }
}

async function queueSimple(commandType, params = {}) {
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType,
      params: { sam: props.sam, ...params }
    });
    banner.value = {
      ok: true,
      text: `${commandType} (${props.sam}) 已入队`,
      commandId: r.data?.id
    };
    // refresh user properties after a short delay so the result lands
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `${commandType} 入队失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitReset() {
  if (!forms.reset.newPassword) return;
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'user_password_reset',
      params: {
        sam: props.sam,
        newPassword: forms.reset.newPassword,
        mustChangePassword: forms.reset.mustChange,
        unlockAccount: forms.reset.unlock
      }
    });
    banner.value = { ok: true, text: `重置密码已入队 (${props.sam})`, commandId: r.data?.id };
    forms.reset.newPassword = '';
    activePopover.value = null;
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `重置密码失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitAttrs() {
  const attributes = {};
  if (forms.attrs.displayName) attributes.displayName = forms.attrs.displayName;
  if (forms.attrs.description) attributes.description = forms.attrs.description;
  if (forms.attrs.userAccountControl) attributes.userAccountControl = Number(forms.attrs.userAccountControl);
  if (Object.keys(attributes).length === 0) {
    activePopover.value = null;
    return;
  }
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'user_set_attributes',
      params: { sam: props.sam, attributes }
    });
    banner.value = { ok: true, text: `编辑属性已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `编辑属性失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitManager() {
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'user_set_manager',
      params: { sam: props.sam, managerSam: forms.manager.sam || '' }
    });
    banner.value = {
      ok: true,
      text: forms.manager.sam ? `设置经理 (→ ${forms.manager.sam}) 已入队` : `清除经理已入队`,
      commandId: r.data?.id
    };
    activePopover.value = null;
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `设置经理失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitAddGroup() {
  if (!forms.addGroup.name) return;
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'group_add_member',
      params: { name: forms.addGroup.name, members: [props.sam] }
    });
    banner.value = {
      ok: true,
      text: `加入组 (→ ${forms.addGroup.name}) 已入队`,
      commandId: r.data?.id
    };
    activePopover.value = null;
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `加入组失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitDelete() {
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'user_delete',
      params: { sam: props.sam }
    });
    banner.value = { ok: true, text: `删除用户已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchUser, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `删除失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

function fmt(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

watch(() => [props.dc, props.sam, props.dataSource], fetchUser);
onMounted(fetchUser);
onBeforeUnmount(() => { /* no listeners */ });
</script>

<style scoped>
.user-prop-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
  padding: 4px 2px;
}
.up-head {
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.up-head h3 { margin: 0; font-size: 15px; }
.up-attrs {
  width: 100%; border-collapse: collapse; font-size: 13px;
}
.up-attrs th, .up-attrs td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.up-attrs th { color: var(--text-muted); width: 110px; font-weight: 600; }
.up-attrs td.dn { word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-muted); }
.up-attrs td.mono { font-family: ui-monospace, monospace; font-size: 12px; }
.status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.status-pill.ok { background: rgba(34,197,94,0.14); color: #22c55e; }
.status-pill.err { background: rgba(239,68,68,0.14); color: #ef4444; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.up-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.up-actions button {
  padding: 4px 10px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); cursor: pointer;
}
.up-actions button:hover { border-color: var(--accent); }
.up-actions button.danger { color: #ef4444; border-color: rgba(239,68,68,0.4); }
.up-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.up-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.banner { padding: 6px 10px; border-radius: 3px; font-size: 12px; }
.banner.ok { background: rgba(34,197,94,0.10); color: #22c55e; border: 1px solid rgba(34,197,94,0.4); }
.banner.err { background: rgba(239,68,68,0.10); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); }
.error-banner { padding: 6px 10px; border-radius: 3px; background: rgba(239,68,68,0.10); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-size: 12px; }
.empty-hint { color: var(--text-muted); padding: 16px; font-size: 13px; text-align: center; }
.hint { color: var(--text-muted); font-size: 11px; }
.popover label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-bottom: 8px; }
.popover label > span:first-child { color: var(--text-muted); }
.popover input[type="text"], .popover input[type="password"], .popover input:not([type]) {
  padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); font-size: 13px;
}
.popover label:has(input[type="checkbox"]) { flex-direction: row; align-items: center; gap: 6px; }
.group-list { list-style: none; padding: 0; margin: 0; max-height: 220px; overflow: auto; }
.group-list li { padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
.candidate-list {
  list-style: none; padding: 0; margin: 0;
  max-height: 220px; overflow: auto;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg);
}
.candidate-list li.candidate {
  padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 12px;
  cursor: pointer; display: flex; flex-direction: column; gap: 2px;
}
.candidate-list li.candidate:last-child { border-bottom: none; }
.candidate-list li.candidate:hover { background: rgba(99,102,241,0.10); }
.candidate-list li.candidate .sam { font-weight: 600; color: var(--text); }
.candidate-list li.candidate .display { color: var(--text-muted); font-size: 11px; }
.candidate-list li.candidate .picked { color: var(--accent); }
.candidate-list .empty { padding: 8px; color: var(--text-muted); font-size: 12px; text-align: center; }
.candidate-list .loading { padding: 8px; color: var(--text-muted); font-size: 12px; text-align: center; }
.popover-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }
</style>
