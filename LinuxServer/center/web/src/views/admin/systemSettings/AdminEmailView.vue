<!--
  R158.AdminEmail (2026-10-15) — AdminEmailView (管理员邮件 child).

  SystemSettings 第 3 子 tab (排在 license 之后). 1 email input + 保存/清空按钮 +
  "管理员邮件为空时 license 通知将不会发送" 横幅.

  跟 FeatureFlagsView / LicenseView 平级, 复用 system-settings 父路由 (admin:config perm).
  跟 LicenseView 边界 1:1 互斥: AdminEmailView = 配置系统收件人 (read+write),
  LicenseView = 配置 license 状态 (read+activate/deactivate). 0 混淆.

  wire shape (跟 R158.License-config 1:1 平行):
    GET  /api/admin/system-settings-v2/admin-email      → { value: string }
    PUT  /api/admin/system-settings-v2/admin-email      → { ok: true, value: string }  body: { email: string }

  后端 regex 校验 /^[^@\s]+@[^@\s]+\.[^@\s]+$/ (空字符串放行), setConfig 入口走 sys_config_audit 留痕.

  0 触碰: agent / R158.69 / R158.88 中心端编排 / license 激活算法 / deactivation 发邮件
-->
<template>
  <div class="ae-view" data-test="ae-view">
    <!-- 空邮件提示横幅: license 通知将不会发送, 操作员引导显式填写 -->
    <div
      v-if="!loading && !value"
      class="ae-banner-empty"
      data-test="ae-banner-empty"
    >
      <span class="ae-banner-icon">⚠️</span>
      <span class="ae-banner-text">
        管理员邮件为空, 许可证申请单生成后 + 许可证激活成功后 <strong>将不会发送通知邮件</strong>.
        请填写后再触发许可证流程.
      </span>
    </div>

    <div class="ae-card">
      <div class="ae-card-header">
        <h2 class="ae-card-title">通知收件人</h2>
        <p class="ae-card-hint">许可证申请单 / 激活通知邮件将发到此地址</p>
      </div>

      <div class="ae-form">
        <label class="ae-label" for="ae-email-input">邮箱地址</label>
        <div class="ae-input-row">
          <input
            id="ae-email-input"
            v-model.trim="formEmail"
            type="email"
            class="ae-input"
            :class="{ 'ae-input-error': saveError }"
            placeholder="例如: fogyisland_x@hotmail.com"
            :disabled="saving"
            data-test="ae-email-input"
            @keyup.enter="save"
          />
          <button
            class="ae-btn ae-btn-primary"
            :disabled="saving || formEmail === value"
            data-test="ae-save-btn"
            @click="save"
          >
            {{ saving ? '保存中...' : '保存' }}
          </button>
          <button
            class="ae-btn ae-btn-secondary"
            :disabled="saving || !value"
            data-test="ae-clear-btn"
            @click="clear"
          >
            清空
          </button>
        </div>

        <div v-if="saveError" class="ae-error" data-test="ae-error">
          {{ saveError }}
        </div>
        <div v-else-if="savedAt" class="ae-success" data-test="ae-success">
          ✓ 已保存 (当前值: <code>{{ value || '(空)' }}</code>)
        </div>
        <div v-else-if="value" class="ae-current" data-test="ae-current">
          当前值: <code>{{ value }}</code>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adminApi } from '../../../api/admin.js';

const value = ref('');           // 后端返的当前值
const formEmail = ref('');       // 表单 input (跟 value 解耦, 让用户编辑后未保存时 input 自由)
const loading = ref(false);
const saving = ref(false);
const saveError = ref(null);
const savedAt = ref(0);          // 最近一次成功保存的 ts (成功 flash 显示)

async function reload() {
  loading.value = true;
  saveError.value = null;
  try {
    const r = await adminApi.getAdminEmail();
    value.value = (r && typeof r.value === 'string') ? r.value : '';
    // 仅在用户没在编辑时同步 form (避免覆盖用户未保存的输入)
    if (!formEmail.value || formEmail.value === value.value) {
      formEmail.value = value.value;
    }
  } catch (e) {
    saveError.value = `读取失败: ${e?.response?.data?.error || e?.message || e}`;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saveError.value = null;
  // 客户端前置校验 (跟后端 regex 1:1 平行, 早失败免 round-trip)
  const email = formEmail.value;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    saveError.value = '邮箱格式不正确';
    return;
  }
  saving.value = true;
  try {
    const r = await adminApi.updateAdminEmail(email);
    value.value = (r && typeof r.value === 'string') ? r.value : email;
    formEmail.value = value.value;
    savedAt.value = Date.now();
    setTimeout(() => { savedAt.value = 0; }, 4000);
  } catch (e) {
    saveError.value = `保存失败: ${e?.response?.data?.detail || e?.response?.data?.error || e?.message || e}`;
  } finally {
    saving.value = false;
  }
}

async function clear() {
  formEmail.value = '';
  await save();
}

onMounted(reload);
</script>

<style scoped>
.ae-view { width: 100%; }

/* 空邮件横幅 (跟 R158.86.6 模板: 大字+色+边框) */
.ae-banner-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 16px;
  border: 1px solid rgba(234, 179, 8, 0.4);
  background: rgba(234, 179, 8, 0.08);
  border-radius: 4px;
  color: #b45309;
  font-size: 13px;
}
.ae-banner-icon { font-size: 18px; }
.ae-banner-text strong { color: #92400e; }

/* 配置卡片 (跟 FeatureFlagsView ff-table 1:1 平行, panel 风格) */
.ae-card { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 20px; }
.ae-card-header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.ae-card-title { font-size: 15px; font-weight: 600; margin: 0 0 4px 0; color: var(--text); }
.ae-card-hint { color: var(--muted); font-size: 12px; margin: 0; }

/* form */
.ae-form { display: flex; flex-direction: column; gap: 10px; }
.ae-label { font-size: 12px; color: var(--muted); font-weight: 500; }
.ae-input-row { display: flex; gap: 8px; align-items: center; }
.ae-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg, #fff);
  color: var(--text);
  font-size: 13px;
  font-family: monospace;
}
.ae-input:focus { outline: none; border-color: var(--accent, #3b82f6); }
.ae-input-error { border-color: #dc2626; }
.ae-input:disabled { opacity: 0.5; }

.ae-btn {
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  background: var(--panel);
  color: var(--text);
}
.ae-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ae-btn-primary { background: var(--accent, #3b82f6); color: #fff; border-color: var(--accent, #3b82f6); }
.ae-btn-primary:hover:not(:disabled) { opacity: 0.9; }
.ae-btn-secondary:hover:not(:disabled) { background: var(--bg, #f9fafb); }

/* 反馈消息 */
.ae-error { color: #dc2626; font-size: 12px; padding: 6px 0; }
.ae-success { color: #16a34a; font-size: 12px; padding: 6px 0; }
.ae-current { color: var(--muted); font-size: 12px; padding: 6px 0; }
.ae-current code, .ae-success code { font-family: monospace; color: var(--text); }
</style>
