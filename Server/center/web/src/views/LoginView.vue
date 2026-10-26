<template>
  <div class="login-bg">
    <form class="login-card" @submit.prevent="onSubmit">
      <!-- R158.License-expiry (2026-10-15) — login 页黄底⚠️ banner. 公开端点 (NO middleware)
           LoginView onMounted 调 1 次, status='expired'/'expiring_soon' 显示. 不阻断
           login form (操作员 D-1 决策: 普通 user 不强制 redirect, 0 锁死 form). 复用
           AdminEmailView .ae-banner-empty 范式 1:1 平行 (黄底⚠️). -->
      <div v-if="licenseBanner" class="lic-banner-login" :class="licenseBanner.status === 'expired' ? 'lic-banner-login-expired' : ''" data-test="lic-banner-login">
        <span class="lic-banner-icon">⚠️</span>
        <span class="lic-banner-text">
          <strong v-if="licenseBanner.status === 'expired'">许可证已到期</strong>
          <strong v-else>许可证即将到期 (还剩 {{ licenseBanner.days_remaining }} 天)</strong>
          . 请联系管理员申请续期后再登录.
        </span>
      </div>
      <!-- R158.X.99-trial (2026-10-21) — 蓝底🕒 30 天临时授权 banner.
           真源 = center appsettings.json.installedAt (boot lazy 写死, patchConfigAtomic
           tmp+rename 会重置 mtime → 0 能信 mtime, lesson 140). 授权成功 (permanent 或
           timed license 落库) 后 trial.active=false → 本 banner 永久不再显示 (用户诉求).
           2 档配色: 进行中=蓝 (.lic-banner-login-trial), 已过期=橙
           (.lic-banner-login-trial-expired). 3 档可用性: 查询失败=灰
           (.lic-banner-login-unavailable, lesson 141 fail-closed 0 静默).
           不阻断 form (跟上方黄底 banner 同 precedent, 操作员 D-1 决策). -->
      <div v-if="trialBanner" class="lic-banner-login lic-banner-login-trial" :class="trialBanner.urgentClass" data-test="lic-banner-trial">
        <span class="lic-banner-icon">{{ trialBanner.expired ? '🔴' : (trialBanner.urgentClass ? '⚠️' : '🕒') }}</span>
        <span class="lic-banner-text">
          <!-- R158.Trial-anchor (2026-10-22) — 验签异常档, 优先级最高.
               安装日期能解析出具体哪天, 但签名对不上 (被改过/换机搬来的),
               直接告诉操作员"哪天装的 + 需激活", 而不是含糊显示"还剩 N 天"。 -->
          <strong v-if="trialBanner.anchorTampered">安装记录异常, 需激活</strong>
          <strong v-else-if="trialBanner.expired">临时授权已过期</strong>
          <strong v-else-if="trialBanner.imminent">临时授权 {{ trialBanner.days_remaining }} 天后到期</strong>
          <strong v-else-if="trialBanner.urgentClass">临时授权即将到期</strong>
          <strong v-else>当前为临时 {{ trialBanner.days_total }} 天授权</strong>
          . {{ trialBanner.copy }}
        </span>
      </div>
      <!-- lesson 141 — fail-closed 可观测: 公开端点挂掉时不静默吞掉, 中性灰 strip
           告诉操作员"授权状态查不到" (0 阻断登录, 0 假装一切正常). -->
      <div v-if="licenseStateUnavailable" class="lic-banner-login lic-banner-login-unavailable" data-test="lic-banner-unavailable">
        <span class="lic-banner-icon">ℹ️</span>
        <span class="lic-banner-text">无法获取授权状态, 临时授权提示可能不准确. 请联系管理员确认.</span>
      </div>
      <h2>AD Replication Dashboard</h2>
      <label>用户名 <input v-model="username" autocomplete="username" required /></label>
      <label>密码 <input v-model="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit" :disabled="loading">{{ loading ? '登录中...' : '登录' }}</button>
      <p v-if="error" class="err">{{ error }}</p>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import api from '../api/client.js';
import { adminApi } from '../api/admin.js';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
// R158.License-expiry (2026-10-15) — 公开端点 (NO middleware) 登录前能查, onMounted
//   调 1 次. 失败 swallow 不报错 (跟公开端点 fail-closed 1:1 平行). 0 阻断 form.
const licenseBanner = ref(null);
// R158.X.99-trial (2026-10-21) — trial envelope 派生出的 banner 数据 (null = 不显示).
//   服务端已经把优先级排好 (permanent/timed license → active:false), 前端 0 复算日期,
//   只做 文案装配 + 2 档配色切换. 保持"派生逻辑单一真源"在服务端.
const trialBanner = ref(null);
//   lesson 141 — 公开端点异常时置 true, 渲染中性灰 strip. 0 阻断 form.
const licenseStateUnavailable = ref(false);

onMounted(async () => {
  try {
    const s = await adminApi.getLicenseState();
    if (s.status === 'expired' || s.status === 'expiring_soon') {
      licenseBanner.value = s;
    }
    // R158.X.99-trial — 客户端再用 has_license 兜一道: 服务端已保证 has_license → active:false,
    //   这里 0 引入新逻辑, 只是防御"端点被换掉/旧版返回"时误显示 banner.
    const t = s && s.trial;
    // R158.Trial-anchor (2026-10-22) — 锚点验签异常档.
    //   服务端 date_source 出现 db_anchor_tampered / db_anchor_no_local_sig 时,
    //   DB 里的安装日期可信度存疑 (行被改过, 或本机签名缺失无法验签)。
    //   此时**不**显示"还剩 N 天"—— 那等于默认了一个可能伪造的日期。
    //   改成如实告知: 安装日期是哪天 + 需要激活。
    if (t && !s.has_license && typeof t.date_source === 'string'
        && (t.date_source.includes('db_anchor_tampered') || t.date_source.includes('db_anchor_no_local_sig'))) {
      // 优先显示 DB 行里声称的日期 (claimed_at) —— 那才是"安装记录"的内容,
      // 与实际不符时操作员一眼能看出被改过。缺失才回落 started_at。
      const at = (typeof t.claimed_at === 'string' && t.claimed_at)
        || (typeof t.started_at === 'string' && t.started_at)
        || '—';
      trialBanner.value = {
        anchorTampered: true,
        expired: true,
        imminent: true,
        urgentClass: 'lic-banner-login-trial-expired',
        days_total: Number(t.days_total) || 30,
        days_remaining: Number(t.days_remaining) || 0,
        copy: `安装日期 ${at}, 但安装记录签名校验未通过, 无法确认试用是否有效. `
          + `请联系管理员完成激活后再继续使用.`
      };
    } else if (t && !s.has_license && typeof t.active === 'boolean') {
      const n = Number(t.days_remaining);
      const days = Number.isFinite(n) ? n : 0;
      if (t.active) {
        // R158.X.99-trial.2 (2026-10-21) — 显眼度 3 档分级 (操作员要求"剩 10 天更显眼,
        //   过期前一天更显眼"). 分界线: >10 天=普通蓝, 1~10 天=urgent 红字加粗,
        //   0~1 天=imminent 红底 + 脉动. 阈值写成具名常量, 0 埋数字.
        const TRIAL_URGENT_DAYS = 10;
        const TRIAL_IMMINENT_DAYS = 1;
        const urgent = days <= TRIAL_URGENT_DAYS;
        const imminent = days <= TRIAL_IMMINENT_DAYS;
        trialBanner.value = {
          expired: false,
          imminent,
          urgentClass: urgent ? (imminent ? 'lic-banner-login-trial-imminent' : 'lic-banner-login-trial-urgent') : '',
          days_total: Number(t.days_total) || 30,
          days_remaining: days,
          copy: imminent
            ? `仅剩 ${days} 天 (到期日 ${t.expires_at || '—'}), 即将停止使用. 请立即联系管理员申请正式授权.`
            : `还剩 ${days} 天, 到期日 ${t.expires_at || '—'}. 请尽快联系管理员申请正式授权.`
        };
      } else if (Number.isFinite(n) && n < 0) {
        // active=false 但 days_remaining<0 = trial 已过期 (不是"被 license 覆盖"那种 active=false,
        //   那种情况 started_at=null / days_remaining=null, 会被 isFinite 挡住).
        trialBanner.value = {
          expired: true,
          imminent: true,
          urgentClass: 'lic-banner-login-trial-expired',
          days_total: Number(t.days_total) || 30,
          days_remaining: days,
          copy: `已过期 ${Math.abs(days)} 天 (到期日 ${t.expires_at || '—'}), 当前为未授权状态. 登录后仅可访问授权管理页面, 请联系管理员申请正式授权.`
        };
      }
    }
  } catch (_e) {
    // lesson 141 — 原来这里是静默 swallow, 现在至少给操作员一个可见 strip.
    licenseStateUnavailable.value = true;
  }
});

async function onSubmit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login({ username: username.value, password: password.value }, async (creds) => {
      const r = await api.post('/api/auth/login', creds);
      return { data: r.data };
    });
    router.push(route.query.redirect || '/');
  } catch (e) {
    error.value = e.response?.data?.error || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-bg { display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, var(--sidebar-bg), var(--border)); }
.login-card { background: var(--panel); padding: 32px; border-radius: 8px; min-width: 320px; display: flex; flex-direction: column; gap: 14px; border: 1px solid var(--border); }
.login-card h2 { margin: 0 0 8px; font-size: 18px; color: var(--accent); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.err { color: var(--red); font-size: 13px; margin: 0; }
/* R158.License-expiry (2026-10-15) — login banner. 复用 AdminEmailView
   .ae-banner-empty 范式 1:1 平行 (黄底⚠️ padding 10/14 + border-radius 4 +
   border 1px rgba(234,179,8,0.4)). expired 时切红底 (新加, 跟 AppLayout
   .lic-banner-expired 配色对齐). 0 改 login-card 既有 padding/gap. */
.lic-banner-login {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(234, 179, 8, 0.10);
  color: #b45309;
  border: 1px solid rgba(234, 179, 8, 0.4);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
}
.lic-banner-login-expired {
  background: rgba(239, 68, 68, 0.10);
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.4);
}
/* R158.X.99-trial (2026-10-21) — trial banner 3 档配色. 加进第 1 个 <style scoped>
   (line 69 起), 不是下面那个重复块 —— 那个块漏了全部 .lic-banner-login* 类,
   Vue SFC compiler 合并两份但不报错 (lesson 142), 漏写不报错是 pre-existing bug, flag 不修. */
.lic-banner-login-trial {
  background: rgba(59, 130, 246, 0.10);
  color: #1d4ed8;
  border-color: rgba(59, 130, 246, 0.4);
}
.lic-banner-login-trial-expired {
  background: rgba(249, 115, 22, 0.12);
  color: #c2410c;
  border-color: rgba(249, 115, 22, 0.45);
}
/* 剩 ≤10 天 — 红字加粗, 加深边框. 不换底色 (蓝→红跳变太生硬), 用 weight + color 提显著性. */
.lic-banner-login-trial-urgent {
  background: rgba(239, 68, 68, 0.10);
  color: #b91c1c;
  border-color: rgba(239, 68, 68, 0.5);
  font-weight: 600;
}
/* 剩 ≤1 天 (含今天到期) — 红底白字 + 2s 脉动, 最高显著性. prefers-reduced-motion 下停脉动
   只保留静态红底 (无障碍: 动画不是唯一信息载体, 底色已足够). */
.lic-banner-login-trial-imminent {
  background: rgba(220, 38, 38, 0.92);
  color: #fff;
  border-color: rgba(153, 27, 27, 0.9);
  font-weight: 700;
  animation: lic-banner-pulse 2s ease-in-out infinite;
}
@keyframes lic-banner-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .lic-banner-login-trial-imminent { animation: none; }
}
.lic-banner-login-unavailable {
  background: rgba(107, 114, 128, 0.12);
  color: var(--muted);
  border-color: rgba(107, 114, 128, 0.35);
}
.lic-banner-icon { font-size: 14px; flex: 0 0 auto; }
.lic-banner-text { flex: 1 1 auto; }
/* Light theme: swap the gradient for a soft cool wash so the card stands
   out without inheriting dark-mode chrome. */
:root[data-theme="light"] .login-bg { background: linear-gradient(135deg, #e0e7ef, var(--bg)); }
</style>

<style scoped>
.login-bg { display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, var(--sidebar-bg), var(--border)); }
.login-card { background: var(--panel); padding: 32px; border-radius: 8px; min-width: 320px; display: flex; flex-direction: column; gap: 14px; border: 1px solid var(--border); }
.login-card h2 { margin: 0 0 8px; font-size: 18px; color: var(--accent); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.err { color: var(--red); font-size: 13px; margin: 0; }
/* Light theme: swap the gradient for a soft cool wash so the card stands
   out without inheriting dark-mode chrome. */
:root[data-theme="light"] .login-bg { background: linear-gradient(135deg, #e0e7ef, var(--bg)); }
</style>
