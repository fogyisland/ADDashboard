import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './style.css';
// R158.87 (2026-10-12) — feature flags store 全局启动 1 次.
//   30s 后台 polling 拉 /api/admin/system-settings-v2/feature-flags,
//   让 AppLayout/AdminLayout 的 sidebar v-if gate 实时反映 flag 变化.
//   fail-closed: API 失败 → flags={} → isEnabled 永远 false → sidebar
//   隐藏全部受 gate 控的 group (跟 R158.68 system-alerts 1:1 swallow 模式).
//
// R158.103 (2026-10-14) — boot-time polling 改为登录态 gated.
//   之前未登录访客打开 '/' 即触发 ff.fetchAll() GET feature-flags →
//   后端 userAuth 401 (R158.87 ship 时 src 引入, R158.102 ship 伴随
//   的最后一次 build 让 dist 首次包含 mount-time polling, 操作员昨天
//   用的旧 chunk 没有这段所以未见, 今天第一次出现 401 噪声).
//   fail-closed shape 不变 — store 内部 try/catch(_e) swallow 不动;
//   仅在 main.js 加 isLoggedIn gating + pinia $subscribe 启停.
//   token revoked / invalid → router.beforeEach 仍 push /login, 不破坏。
import { useFeatureFlagsStore } from './stores/featureFlags.js';
import { useLicenseStateStore } from './stores/licenseState.js';
import { useAuthStore } from './stores/auth.js';
// R158.X.99.34.d (2026-10-19) — in-app notification polling. 跟 featureFlags
//   1:1 平行 (isLoggedIn gated, 因为 /api/admin/system-alerts/since 要
//   admin:users perm; 公开不登录就推不了). fail-closed: API 失败 → keep watermark,
//   0 推新 toast. 3 类 transition 推 (新 firing=error / recovered=success /
//   acked=info), 跟 email 节流 (NOTIFY_THROTTLE_MINUTES=120) 完全解耦.
import { useInappNotificationsStore } from './stores/inappNotifications.js';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

const auth = useAuthStore();
const ff = useFeatureFlagsStore();
const ls = useLicenseStateStore();
const inapp = useInappNotificationsStore();

// R158.License-expiry (2026-10-15) — license state 30s polling. 公开端点
//   (NO middleware, R158.103 precedent), 登录前 LoginView 也要查, 0 走
//   isLoggedIn gate. main.js 启 1 次, 跟 featureFlags polling 1:1 平行
//   shape 但无条件启 (featureFlags 受 token 状态 gate 控).
ls.startPolling();

function startFlagsPolling() {
  // duplicate-call safe — store 内部 _timer guard (featureFlags.js:41-43)
  ff.fetchAll().then(() => ff.startPolling(30000));
}

// R158.X.99.34.d (2026-10-19) — in-app notification polling 启停跟 featureFlags
//   1:1 平行 (isLoggedIn gated, 因为 /api/admin/system-alerts/since 要 admin:users
//   perm). store 内部 _timer guard 保证 duplicate-call safe. fetch({force:true})
//   跳过 _fetching 重入 guard (跟 startFlagsPolling 同样 .then(() => startPolling())).
function startInappPolling() {
  inapp.fetch({ force: true }).then(() => inapp.startPolling(30000));
}

if (auth.isLoggedIn) startFlagsPolling();
if (auth.isLoggedIn) startInappPolling();

// 登录态变化:登入起 (token 由 null → string, _timer 还没建) ;
// 登出停 (token 由 string → null, _timer 已建). 同一 callback 双方向
// 覆盖,跟前端 pinia $subscribe 用法一致 (R158.71 AppLayout 1:1 平行).
auth.$subscribe((_mut, state) => {
  if (state.token && !ff._timer) startFlagsPolling();
  if (!state.token && ff._timer) ff.stopPolling();
  // R158.X.99.34.d — in-app 跟 featureFlags 1:1 平行双方向覆盖.
  if (state.token && !inapp._timer) startInappPolling();
  if (!state.token && inapp._timer) inapp.stopPolling();
});