// R158.X.99.34.d (2026-10-19) — In-app notification Pinia store + 30s polling.
//
// 跟 stores/featureFlags.js (R158.87) + stores/licenseState.js (R158.License-expiry)
// 1:1 平行: 全局 store (main.js 启动 1 次), 30s 后台 polling, login state gated.
//
// 操作员 directive (verbatim): "但是可以在窗口期不停告警,也提供恢复告警。另外
//   我们是否可以存在各种设置的消息记录和推送功能?"  澄清后: 操作员登录 dashboard
//   后,在 dashboard 内部推送/显示告警消息给管理员 (=in-app bell/drawer/toast,
//   NOT webhook/Slack/IM/邮件).
//
// 3 锁 (操作员 directive 锁):
//   (1) 窗口期内多次告警: 同一告警源在 2h 节流窗内重复触发, 持续推
//       ("有消息就推送" = 0 节流). firing 持续期每 tick 检测 → seenKeys 去重,
//       新 (kind, scope_ref, id) 仍可见即推.
//   (2) 恢复告警: firing → recovered transition → 推 "已恢复" success toast.
//   (3) in-app 推送: dashboard 内部 bell + drawer + toast, 0 外部 webhook / Slack
//       / IM / 邮件. 完全跟 email 节流 (NOTIFY_THROTTLE_MINUTES=120) 解耦.
//
// 派生规则 (前端纯客户端逻辑, 0 后端 dep):
//   lastSeenAt 持久化 localStorage 'inapp_last_seen_at' (ISO string)
//   seenKey = `${kind}|${scope_ref ?? ''}|${id}`  // 同一行已 seen 不重复推
//   lastStateByKey = { [seenKey]: state }  // 跨 polling tick 检测 transition
//   newKey = 首次出现 OR state 变化 (firing ↔ recovered/acked)
//   3 类 transition 各调不同 notify kind:
//     新 firing → notifyError (red toast, attention)
//     firing → recovered → notifySuccess (green toast, recovery)
//     firing → acked → notifyInfo (gray toast, acknowledged)
//
// fail-closed: API 失败 → keep lastSeenAt, 0 推新 toast, badge 不动
//   (跟 featureFlags / licenseState 同 swallow 模式, R158.103 precedent).

import { defineStore } from 'pinia';
import { adminApi } from '../api/admin.js';
import { notifyError, notifySuccess, notifyInfo } from '../lib/notify.js';

const STORAGE_KEY = 'inapp_last_seen_at';

const KIND_LABEL = {
  heartbeat_offline: '心跳离线',
  replication_failed: '复制失败',
  port_latency_high: '端口延迟',
  disk_low: '磁盘低',
  failed_logon_spike: '失败登录激增'
};

function loadLastSeenAt() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = new Date(raw);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
  } catch { /* swallow */ }
  return new Date(Date.now() - 3600 * 1000).toISOString();
}

function saveLastSeenAt(iso) {
  try { localStorage.setItem(STORAGE_KEY, iso); } catch { /* swallow */ }
}

export const useInappNotificationsStore = defineStore('inappNotifications', {
  state: () => ({
    lastSeenAt: loadLastSeenAt(),
    seenKeys: {},          // { [seenKey]: state } 跨 polling tick 派生 transition
    unreadCount: 0,         // BellIcon badge 计数
    drawerOpen: false,      // drawer 开关
    _timer: null,           // setInterval handle (跟 featureFlags 1:1 平行)
    _fetching: false        // 重入 guard (跟 featureFlags 1:1 平行)
  }),
  getters: {
    hasUnread: (s) => s.unreadCount > 0
  },
  actions: {
    async fetch({ force = false } = {}) {
      // 跟 featureFlags.js fetchAll 1:1 平行: _fetching 重入 guard, 但 force=true
      // 跳过 guard (resetWatermark 触发时用).
      if (this._fetching && !force) return;
      this._fetching = true;
      try {
        const data = await adminApi.listSystemAlertsSince({ since: this.lastSeenAt, limit: 50 });
        const items = Array.isArray(data?.items) ? data.items : [];
        let newCount = 0;
        let newestFiredAt = this.lastSeenAt;
        for (const it of items) {
          const key = `${it.kind}|${it.scope_ref ?? ''}|${it.id}`;
          const prevState = this.seenKeys[key];
          const curState = it.state;
          const isFirstSeen = prevState === undefined;
          const isTransition = prevState && prevState !== curState;
          if (isFirstSeen && curState === 'firing') {
            // 操作员 directive "有消息就推送" — 新 firing 出现 → 推 error toast.
            notifyError(`${KIND_LABEL[it.kind] || it.kind}: ${it.scope_ref || '全局'}`);
            newCount++;
          } else if (isTransition && curState === 'recovered' && prevState === 'firing') {
            // 操作员 directive (2) 恢复告警 — firing → recovered → 推 success toast.
            notifySuccess(`${KIND_LABEL[it.kind] || it.kind}: ${it.scope_ref || '全局'} 已恢复`);
            newCount++;
          } else if (isTransition && curState === 'acked' && prevState === 'firing') {
            // (3) 操作员手动 ack → 推 info toast, bell drawer 立即反映状态.
            notifyInfo(`${KIND_LABEL[it.kind] || it.kind}: ${it.scope_ref || '全局'} 已确认`);
            newCount++;
          }
          this.seenKeys[key] = curState;
          // watermark 推进 = max(lastSeenAt, fired_at) — 0 必用 server now
          // (防 polling 期间 fired_at 倒序 race).
          if (it.fired_at && it.fired_at > newestFiredAt) newestFiredAt = it.fired_at;
        }
        this.lastSeenAt = newestFiredAt;
        saveLastSeenAt(this.lastSeenAt);
        if (newCount > 0) this.unreadCount += newCount;
      } catch (_e) {
        // fail-closed: 0 推新 toast, badge 不动, watermark 不推进.
        // 跟 featureFlags.js fetchAll / licenseState.js fetch 1:1 平行 swallow.
      } finally {
        this._fetching = false;
      }
    },
    startPolling(intervalMs = 30000) {
      if (this._timer) return;
      this.fetch().then(() => {
        this._timer = setInterval(() => this.fetch(), intervalMs);
      });
    },
    stopPolling() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    },
    openDrawer() {
      this.drawerOpen = true;
      this.unreadCount = 0;  // 打开 drawer 清零 (跟 R158.100 email-history drawer 1:1 平行)
    },
    closeDrawer() {
      this.drawerOpen = false;
    },
    markAllRead() {
      this.unreadCount = 0;
    },
    resetWatermark() {
      // 提供给 InAppDrawer "刷新" 按钮: 重置 watermark → 拉最近 1h 全部 → 派生
      // transition 重新推 toast. force=true 跳过 _fetching guard.
      this.lastSeenAt = new Date(Date.now() - 3600 * 1000).toISOString();
      saveLastSeenAt(this.lastSeenAt);
      this.seenKeys = {};
      this.unreadCount = 0;
      return this.fetch({ force: true });
    }
  }
});
