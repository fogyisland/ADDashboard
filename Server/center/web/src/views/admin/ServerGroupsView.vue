<template>
  <AdminLayout>
    <h2>非 AD 服务器组</h2>
    <p class="hint">
      <code>ad_server_groups</code> 是分组成员主表 — 可对整组应用包安装 / 卸载 / 启用 / 禁用
      (后端走单条 SQL 解析,见 server-groups.js)。
    </p>

    <div class="actions">
      <button @click="openCreate">+ 新建组</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <table class="t">
      <thead>
        <tr>
          <th>组名</th>
          <th>说明</th>
          <th>成员数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in groups" :key="g.groupId">
          <td><code>{{ g.groupName }}</code></td>
          <td>{{ g.description || '-' }}</td>
          <td><span class="pill">{{ g.memberCount }}</span></td>
          <td>
            <button @click="selectGroup(g)">Members</button>
            <button @click="openEdit(g)">编辑</button>
            <button @click="onDelete(g)">删除</button>
          </td>
        </tr>
        <tr v-if="!groups.length">
          <td colspan="4" class="empty">暂无组 — 点击"新建组"开始</td>
        </tr>
      </tbody>
    </table>

    <!-- CRUD dialog -->
    <div v-if="editing" class="modal-bg" @click.self="editing = null">
      <div class="modal">
        <h3>{{ editing.id ? '编辑组' : '新建组' }}</h3>
        <div class="row">
          <label>组名 <span class="req">*</span></label>
          <input v-model="editing.groupName" :disabled="!!editing.id" placeholder="edge-east" />
        </div>
        <div class="row">
          <label>说明</label>
          <input v-model="editing.description" placeholder="东向边缘节点" />
        </div>
        <div v-if="editing.error" class="error">{{ editing.error }}</div>
        <div class="actions">
          <button @click="editing = null">取消</button>
          <button class="primary" :disabled="editing.busy" @click="onSave">
            {{ editing.busy ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Members tab: slide-out panel for the selected group -->
    <div v-if="selected" class="modal-bg" @click.self="closeMembers">
      <div class="modal wide">
        <div class="members-head">
          <h3>成员 — {{ selected.groupName }}</h3>
          <button @click="closeMembers">关闭</button>
        </div>
        <p class="hint">
          从下方<b>已纳入监控的服务器</b>清单中勾选成员,点<b>保存成员</b>即覆盖整组。
          已退役 / 暂停管控的机器不在清单里,但若此前已在组内会保留显示并标注,取消勾选保存即可移出。
        </p>
        <!-- R158.X.116.r (2026-10-23) — 原来是纯 textarea 手输 hostname,
             操作员无法浏览现有服务器, 且后端无 FK 校验 → 拼错的名字也能
             存成"成员", 组列表成员数照样 +1, 批量装包对该机器却是空操作
             (静默无效)。改成勾选清单 + 全选/清空/搜索。 -->
        <div class="picker">
          <div class="picker-toolbar">
            <input
              v-model="candidateFilter"
              class="picker-search"
              placeholder="按主机名或站点搜索…"
              data-test="candidate-search"
            />
            <button type="button" @click="selectAllCandidates">全选</button>
            <button type="button" @click="clearAllMembers">清空</button>
            <span class="picker-count" data-test="picker-count">
              已选 {{ selectedMembers.length }} / 共 {{ selectableCandidates.length }} 台
            </span>
          </div>
          <div class="picker-list" data-test="candidate-list">
            <label
              v-for="c in filteredCandidates"
              :key="c.hostname"
              class="picker-item"
              :class="{ 'is-retired': c.statusLabel }"
              :data-test="`candidate-${c.hostname}`"
            >
              <input
                type="checkbox"
                :value="c.hostname"
                v-model="selectedMembers"
              />
              <code class="host">{{ c.hostname }}</code>
              <span class="site">{{ c.siteName || '未分配站点' }}</span>
              <span v-if="c.statusLabel" class="retired-tag">{{ c.statusLabel }}</span>
            </label>
            <p v-if="!filteredCandidates.length" class="picker-empty">
              {{ candidateFilter ? '没有匹配的服务器' : '暂无可加入的服务器 — 请先在「成员服务器」里登记' }}
            </p>
          </div>
        </div>
        <div v-if="membersError" class="error" data-test="members-error">{{ membersError }}</div>
        <div v-if="membersOk" class="ok">{{ membersOk }}</div>

        <div class="actions">
          <button class="primary" :disabled="membersBusy" @click="saveMembers">
            {{ membersBusy ? '保存中...' : '保存成员' }}
          </button>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const groups = ref([]);
const editing = ref(null);  // { id, groupName, description, busy, error }
const selected = ref(null); // group object
// R158.X.116.r — 候选服务器清单 (仅在监控中的 MemberServer) + 当前勾选。
//   selectedMembers 是唯一真源, 保存时直接提交; 不再有 textarea 可手输
//   任意字符串 (后端现在也会拒未登记的 hostname)。
const candidateList = ref([]);
const candidateFilter = ref('');
const selectedMembers = ref([]);
// 上一次**已确认落库**的成员集合 —— 勾选即保存失败时的回滚基线。
//   不能拿 selectedMembers 自己当基线 (它已经是脏值了)。
const persistedMembers = ref([]);
const membersBusy = ref(false);
const membersError = ref('');
const membersOk = ref('');

// 已在组内但不在候选清单里的成员 (退役/暂停管控, 或已从 ad_member_servers
//   注销)。**必须补回列表**: 否则打开面板时它们会凭空消失, 操作员会误以
//   为被系统删了并顺手清理掉 —— 这就是"过滤退役但保留已选组内"的落点。
const groupMembers = ref([]);

const selectableCandidates = computed(() => {
  const candidateHosts = new Set(candidateList.value.map(c => c.hostname));
  const retired = groupMembers.value
    .filter(m => !candidateHosts.has(m.hostname))
    .map(m => ({ hostname: m.hostname, siteName: m.site_name || null, statusLabel: '已退役 / 暂停' }));
  return [...candidateList.value, ...retired];
});

const filteredCandidates = computed(() => {
  const q = candidateFilter.value.trim().toLowerCase();
  if (!q) return selectableCandidates.value;
  return selectableCandidates.value.filter(c =>
    c.hostname.toLowerCase().includes(q) ||
    String(c.siteName || '').toLowerCase().includes(q));
});

function selectAllCandidates() {
  // 全选只作用在「当前过滤后的可见项」—— 否则搜索 "web" 点全选会
  // 悄悄把看不见的几百台也加进去, 用户无从察觉 (lesson: 批量操作的作用域
  // 必须与用户看到的列表一致)。
  const merged = new Set(selectedMembers.value);
  for (const c of filteredCandidates.value) merged.add(c.hostname);
  selectedMembers.value = [...merged];
}

function clearAllMembers() {
  selectedMembers.value = [];
}

// R158.X.116.r — 显式点「保存成员」才落库。
//   ⭐ 失败必须回滚到上一次已确认落库的集合 (persistedMembers), 不能拿
//   selectedMembers 自己当基线 —— 它已经是脏值了。回滚的理由: 后端存在性
//   校验会返 400 + rejected, 若复选框停在勾上而库里根本没存, 用户会以为
//   存进去了 (与 R158.X.99.36b「虚报成功」同一类问题)。
async function saveMembers() {
  if (!selected.value) return;
  const previous = [...persistedMembers.value];
  membersError.value = '';
  membersOk.value = '';
  membersBusy.value = true;
  try {
    const r = await adminApi.replaceServerGroupMembers(
      selected.value.groupId, selectedMembers.value);
    persistedMembers.value = [...selectedMembers.value];
    const added = Number(r.data?.added) || 0;
    const removed = Number(r.data?.removed) || 0;
    membersOk.value = added || removed
      ? `已保存: 新增 ${added}, 移除 ${removed}`
      : '无变化';
    await load();
    // 重读成员: 已退役的若被移出组, 候选项仍含它 → 需刷新 groupMembers
    // 才能让「补回已退役成员」那条逻辑反映真实状态。
    const rr = await adminApi.listServerGroupMembers(selected.value.groupId);
    groupMembers.value = rr.data || [];
  } catch (e) {
    selectedMembers.value = previous;
    const rejected = e.response?.data?.rejected;
    membersError.value = rejected?.length
      ? `${e.response?.data?.error || '保存失败'} — 未纳入监控: ${rejected.join(', ')}`
      : (e.response?.data?.error || e.message || String(e));
  } finally {
    membersBusy.value = false;
  }
}

async function load() {
  const r = await adminApi.listServerGroups();
  groups.value = r.data || [];
}

function openCreate() {
  editing.value = { id: null, groupName: '', description: '', busy: false, error: '' };
}

function openEdit(g) {
  editing.value = { id: g.groupId, groupName: g.groupName, description: g.description || '', busy: false, error: '' };
}

async function onSave() {
  const e = editing.value;
  e.error = '';
  if (!e.groupName?.trim()) { e.error = '组名必填'; return; }
  e.busy = true;
  try {
    if (e.id) {
      await adminApi.updateServerGroup(e.id, { groupName: e.groupName, description: e.description || null });
    } else {
      await adminApi.createServerGroup({ groupName: e.groupName, description: e.description || null });
    }
    editing.value = null;
    await load();
  } catch (err) {
    e.error = err.response?.data?.error || err.message || String(err);
  } finally {
    e.busy = false;
  }
}

async function onDelete(g) {
  if (!confirm(`删除组 ${g.groupName}? FK 级联清掉 group_members; 组上的 package binds 仍保留。`)) return;
  await adminApi.deleteServerGroup(g.groupId);
  await load();
}

async function selectGroup(g) {
  selected.value = g;
  membersError.value = '';
  membersOk.value = '';
  candidateFilter.value = '';
  try {
    // 候选清单只在面板首次打开时拉一次 (它与具体组无关), 失败不阻断
    // 已有成员的展示 —— 清单挂了也要让操作员能看到并清理现有成员。
    if (!candidateList.value.length) {
      try {
        const cr = await adminApi.listServerGroupMemberCandidates();
        candidateList.value = cr.data?.items || [];
      } catch (e) {
        membersError.value = '服务器清单加载失败: ' + (e.response?.data?.error || e.message || String(e));
      }
    }
    const r = await adminApi.listServerGroupMembers(g.groupId);
    groupMembers.value = r.data || [];
    selectedMembers.value = groupMembers.value.map(m => m.hostname);
    persistedMembers.value = [...selectedMembers.value];
  } catch (e) {
    membersError.value = e.response?.data?.error || e.message || String(e);
  }
}

function closeMembers() {
  selected.value = null;
  groupMembers.value = [];
  selectedMembers.value = [];
  persistedMembers.value = [];
  candidateFilter.value = '';
  membersError.value = '';
  membersOk.value = '';
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.refresh { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.pill { background: var(--accent); color: var(--sidebar-bg); padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; }
.modal-bg { position: fixed; inset: 0; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 480px; max-width: 90vw; }
.modal.wide { min-width: 640px; }
.row { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
.row.vert { flex-direction: column; align-items: stretch; }
.row label { width: 100px; color: var(--muted); font-size: 13px; }
.row.vert label { width: auto; }
.row input, .row textarea { flex: 1; background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 6px 8px; border-radius: 3px; font-family: inherit; }
.req { color: var(--red); }
.error { color: var(--red); font-size: 13px; margin: 8px 0; }
.ok { color: var(--accent); font-size: 13px; margin: 8px 0; }
.members-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.members-head h3 { margin: 0; }
/* ---- R158.X.116.r 成员选择器 ----
   替代原来的 textarea 手输。列表 max-height + overflow-y 让 200+ 台机器
   不撑爆模态框; 已退役项用 muted + 标签双重标注, 不只靠颜色 (色觉障碍)。 */
.picker { margin: 8px 0 12px; border: 1px solid var(--border); border-radius: 4px; }
.picker-toolbar {
  display: flex; gap: 8px; align-items: center;
  padding: 8px; border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg); flex-wrap: wrap;
}
.picker-search {
  flex: 1; min-width: 160px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); padding: 5px 8px;
  border-radius: 3px; font-family: inherit; font-size: 13px;
}
.picker-count { color: var(--muted); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
.picker-list { max-height: 300px; overflow-y: auto; }
.picker-item {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.picker-item:last-child { border-bottom: 0; }
.picker-item:hover { background: var(--sidebar-bg); }
.picker-item input { flex-shrink: 0; margin: 0; }
.picker-item .host { font-size: 12px; }
.picker-item .site { color: var(--muted); font-size: 12px; }
.picker-item .retired-tag {
  margin-left: auto;
  color: var(--muted); background: var(--sidebar-bg);
  border: 1px solid var(--border);
  padding: 0 6px; border-radius: 3px;
  font-size: 11px; white-space: nowrap;
}
.picker-item.is-retired .host { color: var(--muted); text-decoration: line-through; }
.picker-empty { color: var(--muted); font-size: 13px; padding: 20px; margin: 0; text-align: center; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.primary { background: var(--accent); color: var(--button-fg); }
code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; }
</style>
