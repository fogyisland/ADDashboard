// R158.87 (2026-10-12) — feature flags Pinia store + 30s polling.
//
// 跟 R158.68 system-alerts polling 模式同 precedent (SystemAlertsView.vue:376-395),
// 区别: 全局 store (main.js 启动 1 次), 不是 view-local (unmount 停).
// 这是中心端永久后台轮询, 不随用户切页面停.
//
// R161.6 (2026-10-26) — 判定语义改成 **fail-open**, 且只走公共实现。
//   旧实现 (fail-closed): API 失败 / key 没 seed ⇒ isEnabled(key) 返 false
//   ⇒ 前端 sidebar gate 把对应入口整个隐藏, 但后端 API 照常放行 ⇒ 两层口径
//   分裂。现场症状: 操作员在功能开关页打开「日常管理」, 首页入口不出现。
//   新语义 (与 src/utils/featureFlag.js 逐字对齐):
//     缺 key / undefined / null → 放行 (未配置 ≠ 关闭)
//     '1' | 1 | true           → 放行
//     其它一切 ('0'/0/false/脏值) → 拦截
//   ★ 判定只有**一处**定义 (web/src/lib/featureFlag.js), 这里不内联表达式,
//     否则改了一处忘了另一处, 两层口径又会分裂。
//     回归网: center/tests/feature-flag-semantics.test.js。

import { defineStore } from 'pinia';
import { adminApi } from '../api/admin.js';
import { isFlagEnabled } from '../lib/featureFlag.js';

export const useFeatureFlagsStore = defineStore('featureFlags', {
  state: () => ({
    flags: {},     // { [key]: '1' | '0' | ... }
    loadedAt: 0,
    _timer: null
  }),
  getters: {
    isEnabled: (state) => (key) => isFlagEnabled(state.flags, key),
    isLoaded: (state) => Object.keys(state.flags).length > 0
  },
  actions: {
    async fetchAll() {
      try {
        const r = await adminApi.getFeatureFlags();
        const map = {};
        for (const item of (r.items || [])) map[item.key] = item.value;
        this.flags = map;
        this.loadedAt = Date.now();
      } catch (_e) {
        // 拉失败**不更新** flags (保持上次的 state, 不用空 map 覆盖已拿到的值).
        // 判定的 fail-open 语义由 lib/featureFlag.js 负责: map 为空 ⇒ 未配置
        // ⇒ 放行。**不**在 catch 里把 flags 清空 —— 那会把"拉不到"变成
        // "开关全关", 跟后端 readFeatureFlag 的 fail-open 口径分裂。
        // 跟 R158.68 system-alert polling 同 swallow 模式 (let UI 走 error boundary).
      }
    },
    startPolling(intervalMs = 30000) {
      if (this._timer) return;
      this._timer = setInterval(() => this.fetchAll(), intervalMs);
    },
    stopPolling() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }
  }
});
