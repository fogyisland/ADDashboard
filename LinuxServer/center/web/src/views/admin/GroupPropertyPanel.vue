<!--
  R158.36 (2026-10-03) — GroupPropertyPanel.vue
  右侧属性 + 操作面板. 选中具体组后渲染.

  写动作:
    - 编辑属性 (displayName / description / managedBy)
    - 添加成员 (popover, 多选候选)
    - 移除成员 (popover, 多选现有成员)
    - 删除 (confirm popover)

  读: 优先 snapshot (adminApi.listAdGroups),否则 live
  (adAdminApi.queueCommand 'group_search').

  R158.60.22 (2026-10-09) — 「编辑属性 / 添加成员 / 移除成员」3 个 popover
  全是文本 input sAM, 没候选下拉, 移除成员**完全没显示现有成员**, 只能盲
  输 (operator 反馈 "特别删除成员都不呈现成员, 这是有问题的"). 改成跟
  UserPropertyPanel R158.60.16/17 一样的 candidate-list 模式:
    - attrs.managedBy: 选 1 个 user 候选 (跟 R158.60.16 经理同架构)
    - add: 选 N 个 user 候选, 已在本组的不再列 (避免 AD duplicate member 警告)
    - remove: 选 N 个现有 member (snapshot 直查, R158.60.20 ugm 表)
  跟 R158.60.20 ugm snapshot 表配合: 30min sync 一次写 ad_user_group_memberships
  (R158.46.1 cadence), 直查 DB 返 user_sam 列表. 大组 (Domain Users 8000+)
  不在 ugm (R158.60.20.2 范围), 业务组 (CDASZ 134 / 销售部-SC 76 等) 全有.
-->
<template>
  <div class="group-prop-panel">
    <header class="gp-head">
      <h3>组属性</h3>
      <span v-if="loading" class="hint">加载中…</span>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!group && !loading" class="empty-hint">未找到该组</div>

    <table v-if="group" class="gp-attrs">
      <tbody>
        <tr><th>组名 (sAM)</th><td><code>{{ group.name }}</code></td></tr>
        <tr><th>显示名称</th><td>{{ group.displayName || '—' }}</td></tr>
        <tr><th>DN</th><td class="dn">{{ group.distinguishedName || '—' }}</td></tr>
        <tr><th>OU</th><td>{{ group.ouDn || '—' }}</td></tr>
        <tr><th>作用域</th><td>{{ group.groupScope || '—' }}</td></tr>
        <tr><th>类型</th><td>{{ group.groupCategory || '—' }}</td></tr>
        <tr><th>成员数</th><td>{{ group.memberCount ?? '—' }}</td></tr>
        <tr><th>描述</th><td>{{ group.description || '—' }}</td></tr>
        <tr><th>托管者</th><td>{{ group.managedBy || '—' }}</td></tr>
      </tbody>
    </table>

    <div v-if="group" class="gp-actions">
      <button ref="attrsBtn" data-test="gp-attrs" @click="openPopover('attrs')">编辑属性</button>
      <button ref="addBtn" data-test="gp-add" @click="openPopover('add')">添加成员</button>
      <button ref="removeBtn" data-test="gp-remove" @click="openPopover('remove')">移除成员</button>
      <button ref="deleteBtn" class="danger" data-test="gp-delete" @click="openPopover('delete')">删除</button>
    </div>

    <div v-if="banner" :class="['banner', banner.ok ? 'ok' : 'err']" data-test="gp-banner">
      {{ banner.text }}<small v-if="banner.commandId"> · #{{ banner.commandId }}</small>
    </div>

    <!-- R158.60.22 — attrs popover. displayName/description 还是 input (自由
         文本), managedBy 改成跟 R158.60.16 经理一样的 user 候选下拉. -->
    <Popover v-if="group && activePopover === 'attrs'" :anchor="popoverAnchors.attrs"
             :open="!!activePopover" :title="popoverTitles.attrs"
             @close="activePopover = null">
      <label>显示名称 <input v-model="forms.attrs.displayName" /></label>
      <label>描述 <input v-model="forms.attrs.description" /></label>
      <label>托管者 (managedBy)
        <small class="hint">(搜用户名/显示名, 从列表选)</small>
        <input v-model="managerFilter" placeholder="例如 jdoe 或 张三" data-test="gp-manager-filter" />
      </label>
      <div v-if="loadingManager" class="hint">加载候选账户…</div>
      <div v-else-if="!managerCandidates.length" class="hint">未找到匹配账户</div>
      <ul v-else class="candidate-list" data-test="gp-manager-list">
        <li v-for="u in managerCandidates" :key="`${u.sam}|${u.dn}`"
            :class="['candidate', { selected: forms.attrs.managedBy === u.sam }]"
            :data-test="`gp-manager-cand-${u.sam}`"
            @click="forms.attrs.managedBy = u.sam">
          <span class="sam">{{ u.sam }}</span>
          <span v-if="u.displayName" class="display"> — {{ u.displayName }}</span>
        </li>
      </ul>
      <p class="hint">留空 = 不修改该字段 (displayName/description 自由输入)。托管者点列表 = 设值, 再点一次或选空 = 取消。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!attrsDirty || submitting" @click="submitAttrs">提交</button>
      </template>
    </Popover>

    <!-- R158.60.22 — add member popover. 多选 user 候选, 排除已在组里的
         (避免 AD duplicate member 警告). 跟 R158.60.17 加入组同架构. -->
    <Popover v-if="group && activePopover === 'add'" :anchor="popoverAnchors.add"
             :open="!!activePopover" :title="popoverTitles.add"
             @close="activePopover = null">
      <label>添加成员 <small class="hint">(多选, 已在本组的不列)</small>
        <input v-model="addMemberFilter" placeholder="例如 jdoe 或 张三" data-test="gp-add-filter" />
      </label>
      <div v-if="loadingAddCandidates" class="hint">加载候选账户…</div>
      <div v-else-if="!addMemberCandidates.length" class="hint">未找到可添加的账户</div>
      <ul v-else class="candidate-list" data-test="gp-add-list">
        <li v-for="u in addMemberCandidates" :key="`${u.sam}|${u.dn}`"
            :class="['candidate', { selected: forms.add.sams.includes(u.sam) }]"
            :data-test="`gp-add-cand-${u.sam}`"
            @click="toggleAddMember(u.sam)">
          <span class="sam">
            <input type="checkbox" :checked="forms.add.sams.includes(u.sam)"
                   @click.stop="toggleAddMember(u.sam)" />
            {{ u.sam }}
          </span>
          <span v-if="u.displayName" class="display"> — {{ u.displayName }}</span>
        </li>
      </ul>
      <p class="hint" v-if="forms.add.sams.length">
        已选 <strong>{{ forms.add.sams.length }}</strong> 个: {{ forms.add.sams.slice(0, 5).join(', ') }}{{ forms.add.sams.length > 5 ? '…' : '' }}
      </p>
      <p class="hint" v-else>勾选候选 = 加入组 <code>{{ group.name }}</code>。空选 = 不提交。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!forms.add.sams.length || submitting" @click="submitAdd">提交</button>
      </template>
    </Popover>

    <!-- R158.60.22 — remove member popover. 多选现有 member, 直查 ugm
         snapshot (R158.60.20 后端 /api/admin/ad-groups/:name/members). 之前
         这个 popover 是空白 textarea, 移除成员完全不显示当前成员 = 不可用
         (operator verbatim "特别删除成员都不呈现成员, 这是有问题的"). -->
    <Popover v-if="group && activePopover === 'remove'" :anchor="popoverAnchors.remove"
             :open="!!activePopover" :title="popoverTitles.remove"
             @close="activePopover = null">
      <div v-if="loadingMembers" class="hint">加载现有成员…</div>
      <div v-else-if="!existingMembers.length" class="hint">
        当前组无成员记录
        <small v-if="membersSnapshotAt">({{ membersSnapshotAt }} 同步)</small>
        <small v-else>(30min sync 尚未写入, 大组通常不在 ugm snapshot)</small>
      </div>
      <ul v-else class="candidate-list" data-test="gp-remove-list">
        <li v-for="sam in existingMembers" :key="sam"
            :class="['candidate', { selected: forms.remove.sams.includes(sam) }]"
            :data-test="`gp-remove-cand-${sam}`"
            @click="toggleRemoveMember(sam)">
          <span class="sam">
            <input type="checkbox" :checked="forms.remove.sams.includes(sam)"
                   @click.stop="toggleRemoveMember(sam)" />
            {{ sam }}
          </span>
        </li>
      </ul>
      <p class="hint" v-if="forms.remove.sams.length">
        已选 <strong>{{ forms.remove.sams.length }}</strong> 个待移除: {{ forms.remove.sams.slice(0, 5).join(', ') }}{{ forms.remove.sams.length > 5 ? '…' : '' }}
      </p>
      <p class="hint" v-else>勾选成员 = 移出组 <code>{{ group.name }}</code>。空选 = 不提交。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="primary" :disabled="!forms.remove.sams.length || submitting" @click="submitRemove">提交</button>
      </template>
    </Popover>

    <Popover v-if="group && activePopover === 'delete'" :anchor="popoverAnchors.delete"
             :open="!!activePopover" :title="popoverTitles.delete"
             @close="activePopover = null">
      <p>确定删除组 <code>{{ group.name }}</code> 吗? 此操作不可撤销。</p>
      <template #actions>
        <button @click="activePopover = null">取消</button>
        <button class="danger" :disabled="submitting" @click="submitDelete">确认删除</button>
      </template>
    </Popover>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import Popover from '../../components/Popover.vue';
import { adAdminApi } from '../../api/ad-admin.js';
import { adminApi } from '../../api/admin.js';

const props = defineProps({
  dc: { type: String, required: true },
  // R158.45.33 (2026-10-05) — OU 树按域加载 (R158.45.10) 后, 中栏 OuScopedView
  //   domain 路径走 listAdGroupsByDomain. GroupPropertyPanel 之前只传 dc →
  //   server 400 ('dc or domain required'). 加 domain prop, 跟中栏 fetch 对齐.
  domain: { type: String, default: '' },
  name: { type: String, required: true },
  dataSource: { type: String, default: 'live' }
});

const loading = ref(false);
const error = ref('');
const submitting = ref(false);
const group = ref(null);
const banner = ref(null);
const activePopover = ref(null);

const attrsBtn = ref(null);
const addBtn = ref(null);
const removeBtn = ref(null);
const deleteBtn = ref(null);
const popoverAnchors = { attrs: attrsBtn, add: addBtn, remove: removeBtn, delete: deleteBtn };
const popoverTitles = { attrs: '编辑组属性', add: '添加成员', remove: '移除成员', delete: '删除组' };

const forms = reactive({
  attrs:   { displayName: '', description: '', managedBy: '' },
  add:     { sams: [] },     // R158.60.22 — 改字符串 textarea → sams: string[] 数组
  remove:  { sams: [] }      // R158.60.22 — 同上, 多选现有 member
});

const attrsDirty = computed(() => {
  if (!group.value) return false;
  return forms.attrs.displayName !== ''
      || forms.attrs.description !== ''
      || forms.attrs.managedBy !== '';
});

// ---- R158.60.22 — manager 候选 (跟 R158.60.16 user 经理同架构) ----
const managerFilter = ref('');
const managerCandidates = ref([]);
const loadingManager = ref(false);

// ---- R158.60.22 — add member 候选 user, 排除已在本组的 (避免 AD duplicate
// member 警告; 跟 R158.60.17 user→加入组 一样的排除逻辑) ----
const addMemberFilter = ref('');
const addMemberCandidates = ref([]);
const loadingAddCandidates = ref(false);
// existingMembers 同时给 add popover 排除用 + remove popover 主显示用, 一份
// 数据. 30min sync 写 ugm snapshot (R158.60.20); 大组 (Domain Users 8000+)
// 不在 ugm (R158.60.20.2 范围), 业务组 (CDASZ 134 等) 全有.
const existingMembers = ref([]);
const loadingMembers = ref(false);
const membersSnapshotAt = ref(null);

function toggleAddMember(sam) {
  const i = forms.add.sams.indexOf(sam);
  if (i >= 0) forms.add.sams.splice(i, 1);
  else forms.add.sams.push(sam);
}

function toggleRemoveMember(sam) {
  const i = forms.remove.sams.indexOf(sam);
  if (i >= 0) forms.remove.sams.splice(i, 1);
  else forms.remove.sams.push(sam);
}

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

async function loadAddMemberCandidates() {
  loadingAddCandidates.value = true;
  try {
    const filter = addMemberFilter.value || '';
    const r = props.domain
      ? await adminApi.listAdUsersByDomain({ domain: props.domain, filter, limit: 50 })
      : await adminApi.listAdUsers({ dc: props.dc, filter, limit: 50 });
    const existing = new Set(existingMembers.value);
    addMemberCandidates.value = (r.data?.users || [])
      .filter(u => !existing.has(u.sam))
      .map(u => ({
        sam: u.sam,
        displayName: u.displayName || u.description || '',
        dn: u.dn || ''
      }));
  } catch (e) {
    addMemberCandidates.value = [];
  } finally {
    loadingAddCandidates.value = false;
  }
}

async function loadExistingMembers() {
  if (!props.domain) {
    // R158.60.22 — 走 snapshot 才有 members endpoint (走 domain); live 模式
    // 暂没 group_members 命令 (R75 历史), 提示 operator 切 snapshot.
    existingMembers.value = [];
    membersSnapshotAt.value = null;
    return;
  }
  loadingMembers.value = true;
  try {
    const r = await adminApi.listAdGroupMembersByDomain({ domain: props.domain, name: props.name });
    existingMembers.value = r.data?.members || [];
    membersSnapshotAt.value = r.data?.snapshotAt || null;
  } catch (e) {
    existingMembers.value = [];
    membersSnapshotAt.value = null;
  } finally {
    loadingMembers.value = false;
  }
}

let managerDebounce = null;
let addMemberDebounce = null;
watch(managerFilter, () => {
  if (activePopover.value !== 'attrs') return;
  clearTimeout(managerDebounce);
  managerDebounce = setTimeout(loadManagerCandidates, 250);
});
watch(addMemberFilter, () => {
  if (activePopover.value !== 'add') return;
  clearTimeout(addMemberDebounce);
  addMemberDebounce = setTimeout(loadAddMemberCandidates, 250);
});

function openPopover(name) {
  activePopover.value = name;
  if (name === 'attrs' && group.value) {
    forms.attrs.displayName = '';
    forms.attrs.description = '';
    forms.attrs.managedBy = '';
    managerFilter.value = '';
    managerCandidates.value = [];
  }
  if (name === 'add') {
    forms.add.sams = [];
    addMemberFilter.value = '';
    addMemberCandidates.value = [];
  }
  if (name === 'remove') {
    forms.remove.sams = [];
  }
}

async function fetchGroup() {
  loading.value = true;
  error.value = '';
  try {
    if (props.dataSource === 'snapshot') {
      // R158.45.33 — domain 模式优先 listAdGroupsByDomain (跟中栏 fetch 对齐),
      //   没 domain 才回 listAdGroups({dc}).
      const r = props.domain
        ? await adminApi.listAdGroupsByDomain({ domain: props.domain, filter: props.name, limit: 5 })
        : await adminApi.listAdGroups({ dc: props.dc, filter: props.name, limit: 1, offset: 0 });
      group.value = (r.data?.groups || []).find(g => g.name?.toLowerCase() === props.name.toLowerCase()) || null;
    } else {
      const r = await adAdminApi.queueCommand({
        targetDc: props.dc,
        commandType: 'group_search',
        params: { filter: props.name, limit: 5 }
      });
      const id = r.data?.id;
      if (!id) { group.value = null; return; }
      for (let i = 0; i < 15; i++) {
        await new Promise(rr => setTimeout(rr, 1500));
        const c = await adAdminApi.getCommand(id);
        const d = c.data;
        if (d?.status === 'success') {
          const list = d?.data?.groups || d?.result?.data?.groups || [];
          group.value = list.find(g => g.name?.toLowerCase() === props.name.toLowerCase()) || null;
          return;
        }
        if (d?.status === 'failed' || d?.status === 'timeout') {
          error.value = d?.errorMessage || '查询组失败';
          group.value = null;
          return;
        }
      }
      error.value = '查询组超时';
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message;
    group.value = null;
  } finally {
    loading.value = false;
  }
}

async function queueSimple(commandType, params) {
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType,
      params
    });
    banner.value = { ok: true, text: `${commandType} 已入队`, commandId: r.data?.id };
    setTimeout(fetchGroup, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `${commandType} 入队失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitAttrs() {
  const attributes = {};
  if (forms.attrs.displayName) attributes.displayName = forms.attrs.displayName;
  if (forms.attrs.description) attributes.description = forms.attrs.description;
  if (forms.attrs.managedBy !== '') attributes.managedBy = forms.attrs.managedBy;
  if (Object.keys(attributes).length === 0) {
    activePopover.value = null;
    return;
  }
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'group_set_attributes',
      params: { name: props.name, attributes }
    });
    banner.value = { ok: true, text: `编辑组属性已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchGroup, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `编辑组属性失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitAdd() {
  const sams = [...forms.add.sams];
  if (!sams.length) return;
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'group_add_member',
      params: { name: props.name, members: sams }
    });
    banner.value = { ok: true, text: `添加 ${sams.length} 个成员已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchGroup, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `添加成员失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitRemove() {
  const sams = [...forms.remove.sams];
  if (!sams.length) return;
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'group_remove_member',
      params: { name: props.name, members: sams }
    });
    banner.value = { ok: true, text: `移除 ${sams.length} 个成员已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchGroup, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `移除成员失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

async function submitDelete() {
  submitting.value = true;
  try {
    const r = await adAdminApi.queueCommand({
      targetDc: props.dc,
      commandType: 'group_delete',
      params: { name: props.name }
    });
    banner.value = { ok: true, text: `删除组已入队`, commandId: r.data?.id };
    activePopover.value = null;
    setTimeout(fetchGroup, 2500);
  } catch (e) {
    banner.value = { ok: false, text: `删除失败 — ${e?.response?.data?.error || e?.message}`, commandId: null };
  } finally {
    submitting.value = false;
  }
}

// R158.60.22 — 监听 activePopover 切换, 触发对应 lazy load. attrs 走
// loadManagerCandidates; add 同时 loadExistingMembers (排除用) +
// loadAddMemberCandidates; remove 直接 loadExistingMembers 显示候选. 在
// watch (不是 openPopover) 里 trigger 是因为: openPopover() 内部 set
// activePopover 同步, watch 异步 fire 顺序更可预期, 跟 UserPropertyPanel
// R158.60.16/17 同步触发 load* 的模式不同 (它走 immediate=true).
watch(activePopover, (v) => {
  if (v === 'attrs') loadManagerCandidates();
  if (v === 'add') {
    loadExistingMembers().then(() => loadAddMemberCandidates());
  }
  if (v === 'remove') {
    loadExistingMembers();
  }
});

watch(() => [props.dc, props.name, props.dataSource], fetchGroup);
onMounted(fetchGroup);
</script>

<style scoped>
.group-prop-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
  padding: 4px 2px;
}
.gp-head {
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.gp-head h3 { margin: 0; font-size: 15px; }
.gp-attrs { width: 100%; border-collapse: collapse; font-size: 13px; }
.gp-attrs th, .gp-attrs td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.gp-attrs th { color: var(--text-muted); width: 110px; font-weight: 600; }
.gp-attrs td.dn { word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-muted); }
.gp-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.gp-actions button {
  padding: 4px 10px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); cursor: pointer;
}
.gp-actions button:hover { border-color: var(--accent); }
.gp-actions button.danger { color: #ef4444; border-color: rgba(239,68,68,0.4); }
.gp-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.gp-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.banner { padding: 6px 10px; border-radius: 3px; font-size: 12px; }
.banner.ok { background: rgba(34,197,94,0.10); color: #22c55e; border: 1px solid rgba(34,197,94,0.4); }
.banner.err { background: rgba(239,68,68,0.10); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); }
.error-banner { padding: 6px 10px; border-radius: 3px; background: rgba(239,68,68,0.10); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-size: 12px; }
.empty-hint { color: var(--text-muted); padding: 16px; font-size: 13px; text-align: center; }
.hint { color: var(--text-muted); font-size: 11px; }
.popover label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-bottom: 8px; }
.popover input { padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--text); font-size: 13px; }
.popover textarea { width: 100%; padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--text); font-size: 12px; font-family: ui-monospace, monospace; resize: vertical; box-sizing: border-box; }

/* R158.60.22 — candidate-list 跟 UserPropertyPanel 同款 (R158.60.16/17) */
.candidate-list {
  list-style: none; padding: 0; margin: 8px 0;
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
.candidate-list li.candidate.selected { background: rgba(99,102,241,0.18); }
.candidate-list li.candidate .sam { font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
.candidate-list li.candidate .display { color: var(--text-muted); font-size: 11px; padding-left: 22px; }
.candidate-list li.candidate input[type="checkbox"] { margin: 0; cursor: pointer; }
</style>
