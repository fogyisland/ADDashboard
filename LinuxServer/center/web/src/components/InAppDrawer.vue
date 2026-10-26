<!--
  R158.X.99.34.d (2026-10-19) — In-app notification drawer panel.

  操作员 directive "操作员登录 dashboard 后, 在 dashboard 内部推送/显示告警
  消息给管理员". InAppDrawer 是 bell 后端 panel, 显示 inappNotifications store
  最新 items + 3 个操作 (刷新 / 标记已读 / 查看完整告警).

  Teleport to body, slide-in from right (跟 R158.100 email-history drawer 1:1
  平行 UX). click outside 或 ESC 关闭.

  数据源: store.fetch() 已 polling — drawer mount 时 0 必再 fetch, 直接消费
  store. 但 drawer 内可加 "刷新" 按钮 → store.resetWatermark() 立即拉最近 1h.

  渲染: 复用 SystemAlertsView.vue renderDetail 系统 (kind-specific 字段映射)
  在 InAppDrawer 内部 inline 实现 (1:1 平行 renderDetail 思路, 0 引入外部 dep).
  5 detector kinds 各自的 detail JSON 字段:
    - heartbeat_offline: { offline_min, scope_ref, ts }
    - replication_failed: { dest_dc, partner_dc, accumulated_count }
    - disk_low: { agent_id, c_used_pct, threshold_percent, ts }
    - failed_logon_spike: { count_24h, threshold }
    - port_latency_high (deprecated since R158.X.99.34.b cleanup): 仍保留
-->
<template>
  <Teleport to="body">
    <Transition name="inapp-drawer">
      <div
        v-if="store.drawerOpen"
        class="inapp-drawer"
        data-test="inapp-drawer"
        @keydown.esc="store.closeDrawer"
        tabindex="-1"
      >
        <header class="inapp-head">
          <strong>通知</strong>
          <button class="x" @click="store.closeDrawer" aria-label="关闭">×</button>
        </header>
        <div class="inapp-body">
          <div v-if="loading && items.length === 0" class="muted">加载中...</div>
          <div v-else-if="items.length === 0" class="muted">暂无通知</div>
          <ul v-else class="inapp-list">
            <li
              v-for="a in items"
              :key="`${a.kind}-${a.scope_ref}-${a.id}`"
              :class="['row', `state-${a.state}`]"
            >
              <div class="row-head">
                <span class="pill" :class="stateBadge(a.state)">{{ stateLabel(a.state) }}</span>
                <span class="kind">{{ kindLabel(a.kind) }}</span>
                <span class="when">{{ fmt(a.fired_at) }}</span>
              </div>
              <div class="row-body">
                <code>{{ a.scope_ref || (a.scope_type === 'global' ? '全局' : '-') }}</code>
                <small>{{ renderDetail(a) }}</small>
              </div>
            </li>
          </ul>
        </div>
        <footer class="inapp-foot">
          <button @click="onRefresh" :disabled="loading">刷新</button>
          <button @click="store.markAllRead">标记已读</button>
          <button class="primary" @click="goFullView">查看完整告警</button>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useInappNotificationsStore } from '../stores/inappNotifications.js';
import { adminApi } from '../api/admin.js';
import { formatDateTime } from '../lib/timezone.js';

const store = useInappNotificationsStore();
const router = useRouter();
const items = ref([]);
const loading = ref(false);

// 5 detector kind 中文 label — 跟 stores/inappNotifications.js KIND_LABEL 同款.
//   0 复用 store KIND_LABEL (store 不导出, 避免循环 import); 改时双端同步.
const KIND_LABEL = {
  heartbeat_offline: '心跳离线',
  replication_failed: '复制失败',
  port_latency_high: '端口延迟',
  disk_low: '磁盘低',
  failed_logon_spike: '失败登录激增'
};
const STATE_LABEL = { firing: 'firing', recovered: 'recovered', acked: 'acked' };

function kindLabel(k) { return KIND_LABEL[k] || k || '-'; }
function stateLabel(s) { return STATE_LABEL[s] || s || '-'; }
function stateBadge(s) {
  if (s === 'firing') return 'on';
  if (s === 'acked') return 'off';
  return 'warn';
}

// 复用 SystemAlertsView.vue 行级渲染逻辑, 内联简化版. 用 ISO → localeString
// 避免再 fmtTsCstMs dep; drawer 内时间显示可粗 (HH:MM:SS) 操作员 mental model.
function fmt(s) {
  if (!s) return '-';
  try {
    return formatDateTime(s, { fallback: s });
  } catch { return s; }
}

function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}
function renderDetail(a) {
  const d = parseJson(a.detail);
  if (!d) return '-';
  if (a.kind === 'heartbeat_offline') return `离线 ${d.offline_min ?? '?'} 分钟`;
  if (a.kind === 'replication_failed') {
    const dest = d.dest_dc || d.partner_dc || '?';
    const accum = Number.isFinite(d.accumulated_count) ? d.accumulated_count : '?';
    return `目标 DC: ${dest} · 累计 ${accum} 次`;
  }
  if (a.kind === 'disk_low') return `${d.agent_id || '?'}: ${d.c_used_pct ?? '?'}%`;
  if (a.kind === 'failed_logon_spike') return `24h 累计 ${d.count_24h ?? '?'} 次`;
  return JSON.stringify(d).slice(0, 80);
}

async function loadLatest() {
  loading.value = true;
  try {
    // 重置 watermark → 拉最近 1h 全部 (触发 polling 派生 transition 推 toast)
    await store.resetWatermark();
    // 直接拉一次作为 drawer 渲染源 (跟 store polling 解耦; 0 走 store.fetch)
    const r = await adminApi.listSystemAlertsSince({
      since: new Date(Date.now() - 3600 * 1000).toISOString(),
      limit: 50
    });
    items.value = r?.items || [];
  } catch { /* swallow */ }
  finally { loading.value = false; }
}

async function onRefresh() {
  await loadLatest();
}

function goFullView() {
  store.closeDrawer();
  // R158.X.116.l (2026-10-23) — 真因修复: 旧目标 `/admin/system-alerts`
  //   **从来不是一条真路由**。R158.78 已把 SystemAlertsView 并进
  //   /admin/email-config 的「告警配置与收件箱」 tab (router.js:351 +
  //   EmailConfigView.vue:172-181),
  //   但本行的注释仍称它为"既有 3-tab 页",链接没跟着迁移 → 404。
  //   修法: 指向真实路径, 并带 ?tab=alerts —— EmailConfigView 的 topTab
  //   默认是 'mail' (EmailConfigView.vue:704), 不带参数会落在邮件配置页,
  //   那样"查看全部"点了还是看不到告警 = 换一种方式坏。
  router.push({ path: '/admin/email-config', query: { tab: 'alerts' } });
}

// drawer 打开/关闭 focus 管理 (可访问性)
function onKeydown(e) {
  if (e.key === 'Escape' && store.drawerOpen) store.closeDrawer();
}

watch(() => store.drawerOpen, (v) => {
  if (v) {
    loadLatest();
    document.addEventListener('keydown', onKeydown);
  } else {
    document.removeEventListener('keydown', onKeydown);
  }
});

onMounted(() => {
  if (store.drawerOpen) loadLatest();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.inapp-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 90vw;
  background: var(--panel);
  border-left: 2px solid var(--text);
  box-shadow: -16px 0 48px rgba(0, 0, 0, 0.55);
  z-index: 250;
  display: flex;
  flex-direction: column;
}
.inapp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 2px solid var(--text);
  background: var(--input-bg);
  font-size: 14px;
}
.inapp-head .x {
  background: transparent;
  border: 0;
  cursor: pointer;
  font-size: 18px;
  color: var(--text-muted);
  padding: 0 6px;
}
.inapp-head .x:hover { color: var(--text); }
.inapp-body { flex: 1 1 auto; overflow: auto; padding: 12px; }
.inapp-foot {
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  background: var(--input-bg);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.inapp-foot button {
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}
.inapp-foot button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.inapp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.row {
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--input-bg);
  border: 1px solid var(--border);
}
.row.state-firing { border-left: 3px solid var(--danger, #e44); }
.row.state-recovered { border-left: 3px solid #16a34a; }
.row.state-acked { border-left: 3px solid var(--muted); opacity: 0.7; }
.row-head { display: flex; gap: 8px; align-items: center; font-size: 12px; margin-bottom: 4px; }
.row-head .kind { font-weight: 600; color: var(--text); }
.row-head .when { margin-left: auto; color: var(--muted); font-size: 11px; }
.row-body code { font-size: 12px; }
.row-body small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
.pill { display: inline-block; padding: 1px 6px; border-radius: 9999px; font-size: 10px; font-weight: 600; }
.pill.on { background: rgba(228, 68, 68, 0.15); color: var(--danger, #e44); }
.pill.off { background: rgba(120, 120, 120, 0.18); color: var(--muted); }
.pill.warn { background: rgba(255, 170, 0, 0.18); color: #da6; }
.muted { color: var(--muted); padding: 20px; text-align: center; }

.inapp-drawer-enter-active, .inapp-drawer-leave-active { transition: transform 0.2s; }
.inapp-drawer-enter-from, .inapp-drawer-leave-to { transform: translateX(100%); }
</style>
