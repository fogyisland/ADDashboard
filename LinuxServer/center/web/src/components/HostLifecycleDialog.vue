<template>
  <!--
    R158.X.115 (2026-10-20) — 主机生命周期弹窗 (退役下线 / 暂停管控 / 恢复管控)。

    3 个动作共用一个弹窗, 因为它们共用同一份上下文: 当前状态、将保留哪些
    历史数据、退役前必须先做什么。拆成 3 个弹窗会让操作员在"我点了退役然后
    呢"的地方迷路。

    设计上的两个要点:
      1. 退役 (decommission) 前置步骤是**硬提示**: 后端 lifecycle-preview 返回
         preflightSteps[], 弹窗渲染成有序清单, 并且必须勾选"已完成前置步骤"
         才能点确认。这个勾选不是后端强制的 (那是操作流程, 不是数据一致性),
         但 UI 层强制能有效防止误操作 —— 这正是用户要求"点击下线之前提示用户
         做完哪些操作"的落地。
      2. 退役是终态, 弹窗用措辞明确说出来 ("不可恢复"), 并且按钮要求二次点击
         (先点"我了解这是不可逆操作"再出现真正的确认按钮), 不让误触造成
         不可逆后果。

    暂停 (pause) 与恢复 (resume) 是可逆的, 不需要二次确认, 一个按钮直接走。
  -->
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <header>
        <h3>{{ title }}</h3>
        <button class="x" @click="emit('close')" title="关闭">×</button>
      </header>

      <div class="body">
        <p class="host-line">
          主机 <code>{{ hostname }}</code>
          <span class="pill" :class="statusClass">{{ statusLabel }}</span>
        </p>

        <!-- 退役: 前置操作步骤 (硬提示, 后端提供) -->
        <div v-if="action === 'decommission'" class="preflight">
          <h4>下线前请先完成以下操作</h4>
          <p class="preflight-note">
            这些操作在主机本地完成, 中心端无法代劳。未完成就下线, 会留下
            一台仍在域内 / 仍在上报的"幽灵"主机。
          </p>
          <ol v-if="preflight.length">
            <li v-for="(step, i) in preflight" :key="i">{{ step }}</li>
          </ol>
          <p v-else class="muted">正在加载前置步骤…</p>
        </div>

        <!-- 退役: 将保留的历史数据 (纯信息, 告诉操作员"不会删数据") -->
        <div v-if="action === 'decommission'" class="retained">
          <h4>下线后保留的数据</h4>
          <p class="preflight-note">下线只是打标记, <strong>不删除任何历史记录</strong>。</p>
          <ul v-if="retainedEntries.length" class="retained-list">
            <li v-for="[label, n] in retainedEntries" :key="label">
              <span>{{ label }}</span>
              <span class="n">{{ n === null ? '—' : `${n} 条` }}</span>
            </li>
          </ul>
        </div>

        <!-- 暂停: 说明语义 (临时态 / 手动恢复 / 无自动到期) -->
        <div v-if="action === 'pause'" class="explain">
          <h4>暂停管控的含义</h4>
          <ul>
            <li>该机器停止一切告警, 也从在线视图 / 关键指标 / 包执行目标中移除。</li>
            <li>历史数据全部保留, 随时可以恢复。</li>
            <li><strong>不会自动到期</strong> —— 需要时由你在本页面手动恢复。</li>
          </ul>
        </div>

        <!-- 恢复: 说明会重新纳管 -->
        <div v-if="action === 'resume'" class="explain">
          <h4>恢复管控的含义</h4>
          <ul>
            <li>该机器重新回到在线视图 / 关键指标 / 包执行目标。</li>
            <li>告警会重新开始评估 (按现有阈值与节流规则)。</li>
          </ul>
        </div>

        <label class="reason-field">
          备注 <span class="muted">(可选, 写入审计日志)</span>
          <input v-model="reason" type="text" maxlength="255"
                 :placeholder="action === 'decommission' ? '例: 机房拆迁 / 硬件报废' : '例: 送修中'" />
        </label>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="busy" class="muted">处理中…</p>
      </div>

      <footer>
        <template v-if="action === 'decommission'">
          <!-- 两段式确认: 第一次点击只是解锁真正的按钮 -->
          <template v-if="!armed">
            <label class="confirm-preflight">
              <input type="checkbox" v-model="preflightAck" />
              我已完成上述前置操作, 确认下线
            </label>
            <button class="danger-ghost" :disabled="!preflightAck || busy" @click="armed = true">
              下线 <code>{{ hostname }}</code>
            </button>
          </template>
          <template v-else>
            <span class="armed-warn">此操作<b>不可恢复</b>。历史数据保留, 但该主机将永久退出管控。</span>
            <button class="danger" :disabled="busy" @click="submit">
              确认下线 (不可撤销)
            </button>
          </template>
          <button @click="emit('close')">取消</button>
        </template>
        <template v-else>
          <button class="primary" :disabled="busy" @click="submit">{{ confirmLabel }}</button>
          <button :disabled="busy" @click="emit('close')">取消</button>
        </template>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { adminApi } from '../api/admin.js';

// action: 'decommission' | 'pause' | 'resume'
// kind:   'member' (默认) | 'dc'。DC 与 member 各有独立 wrapper (previewDcLifecycle
//         / decommissionDc / pauseDcMonitoring / resumeDcMonitoring), 弹窗按 kind
//         选对应 API。不在 dialog 里硬编码 member = 让 DcsCatalogView 也复用。
const props = defineProps({
  hostname: { type: String, required: true },
  action: { type: String, required: true },
  kind: { type: String, default: 'member' },
  // 服务器对象 (admin 列表行)。用于显示当前状态, 避免弹窗再拉一次详情。
  server: { type: Object, default: null }
});
const emit = defineEmits(['close', 'done']);

const reason = ref('');
const error = ref('');
const busy = ref(false);
const armed = ref(false);
const preflightAck = ref(false);
const preview = ref(null);

// lifecycle-preview 只在退役时需要 (前置步骤 + 保留数据清单)。
// 暂停/恢复不需要预览, 不拉。
watch(() => props.action, async (a) => {
  if (a === 'decommission') await loadPreview();
}, { immediate: true });

async function loadPreview() {
  try {
    const fn = props.kind === 'dc'
      ? adminApi.previewDcLifecycle
      : adminApi.previewMemberServerLifecycle;
    const r = await fn(props.hostname);
    preview.value = r.data || null;
  } catch (e) {
    // 预览失败**不阻断**退役 —— 退役本身是服务端强制的, 前端拿不到预览只是
    // 少了提示信息, 不该让操作员卡在这里。但仍要显示, 因为它通常意味着
    // 主机不存在或权限问题。
    preview.value = null;
    error.value = '无法加载下线预览 (主机可能不存在或无权限)。仍可继续下线。';
  }
}

const preflight = computed(() => preview.value?.preflightSteps || []);

// 历史数据条数 → 中文标签。null = 该表在当前部署不存在, 显示 "—"。
const RETAINED_LABELS = {
  packageRuns: '包执行记录',
  memberHeartbeat: '心跳记录',
  eventlogEvents: '事件日志',
  osBaseline: 'OS 基线快照',
  adminGroups: '本地管理员组',
  ports: '业务端口配置',
  packageBinds: '包绑定',
  groupMemberships: '服务器组归属',
  firingAlerts: '当前告警 (将标记为已恢复)',
  replicationLinks: '复制关系',
  dcOverview: 'DC 概览快照',
  agentHeartbeat: 'Agent 心跳'
};
const retainedEntries = computed(() => {
  const src = preview.value?.historicalDataRetained;
  if (!src) return [];
  return Object.entries(RETAINED_LABELS)
    .filter(([k]) => k in src)
    .map(([k, label]) => [label, src[k]]);
});

const statusLabel = computed(() => {
  // 兼容两种 shape: snake_case (member-servers 列表行) 与 camelCase
  // (server-lifecycle 总览行)。dialog 不知道上游在哪一端。
  if (props.server?.decommissioned_at || props.server?.decommissionedAt) return '已退役';
  if (props.server?.monitoring_paused_at || props.server?.monitoringPausedAt) return '已暂停管控';
  return '在线';
});
const statusClass = computed(() => {
  if (props.server?.decommissioned_at || props.server?.decommissionedAt) return 'off';
  if (props.server?.monitoring_paused_at || props.server?.monitoringPausedAt) return 'paused';
  return 'on';
});

const TITLES = {
  decommission: '主机下线 (退役)',
  pause: '暂停管控',
  resume: '恢复管控'
};
const title = computed(() => TITLES[props.action] || '主机生命周期');
const confirmLabel = computed(() =>
  props.action === 'pause' ? '确认暂停' : '确认恢复'
);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const body = reason.value.trim() ? { reason: reason.value.trim() } : {};
    const isDc = props.kind === 'dc';
    if (props.action === 'decommission') {
      if (isDc) await adminApi.decommissionDc(props.hostname, body);
      else await adminApi.decommissionMemberServer(props.hostname, body);
    } else if (props.action === 'pause') {
      if (isDc) await adminApi.pauseDcMonitoring(props.hostname, body);
      else await adminApi.pauseMemberServerMonitoring(props.hostname, body);
    } else {
      if (isDc) await adminApi.resumeDcMonitoring(props.hostname, body);
      else await adminApi.resumeMemberServerMonitoring(props.hostname, body);
    }
    emit('done', { action: props.action, hostname: props.hostname });
    emit('close');
  } catch (e) {
    // 后端返回 { error: code, message: 中文说明 }。message 是给操作员看的,
    // 直接展示 (比如"已退役, 退役是终态不可逆"), 比裸 HTTP 状态有用得多。
    error.value = e?.response?.data?.message
      || e?.response?.data?.error
      || '操作失败';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--panel, #fff);
  color: var(--fg, #222);
  border-radius: 8px;
  width: min(680px, 92vw);
  max-height: 88vh;
  display: flex; flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border, #e3e3e3);
}
header h3 { margin: 0; font-size: 15px; }
.x { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--muted); }
.body { padding: 16px 18px; overflow-y: auto; }
footer {
  display: flex; gap: 10px; align-items: center; justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid var(--border, #e3e3e3);
  flex-wrap: wrap;
}
.host-line { margin: 0 0 14px; display: flex; gap: 10px; align-items: center; }
preflight, .explain, .retained {
  background: var(--bg-soft, #f6f7f9);
  border-radius: 6px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
preflight h4, .explain h4, .retained h4 { margin: 0 0 6px; font-size: 13px; }
.preflight-note { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.preflight ol { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; }
.explain ul { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.7; }
.retained-list { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.retained-list li {
  display: flex; justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px dashed var(--border, #e3e3e3);
}
.retained-list li:last-child { border-bottom: none; }
.retained-list .n { color: var(--muted); font-variant-numeric: tabular-nums; }
.reason-field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.reason-field input {
  padding: 7px 9px;
  border: 1px solid var(--border, #d5d5d5);
  border-radius: 4px;
  font-size: 13px;
}
.confirm-preflight {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; margin-right: auto; cursor: pointer;
}
.armed-warn {
  margin-right: auto; font-size: 13px; color: #b45309;
  max-width: 100%;
}
.error { color: #b91c1c; font-size: 13px; margin: 10px 0 0; }
.muted { color: var(--muted); font-size: 12px; }
.pill {
  font-size: 11px; padding: 2px 8px; border-radius: 10px;
  border: 1px solid;
}
.pill.on { color: #15803d; border-color: #15803d; }
.pill.off { color: #6b7280; border-color: #6b7280; background: #f3f4f6; }
.pill.paused { color: #b45309; border-color: #b45309; background: #fffbeb; }
button.danger { background: #b91c1c; color: #fff; border: none; }
button.danger-ghost { border: 1px solid #b91c1c; color: #b91c1c; background: none; }
button.primary { background: var(--accent, #2563eb); color: #fff; border: none; }
</style>