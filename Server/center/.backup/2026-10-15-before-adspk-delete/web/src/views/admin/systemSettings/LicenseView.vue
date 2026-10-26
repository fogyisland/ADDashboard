<!--
  R158.87 (2026-10-12) — LicenseView (License 管理 child).
  当前 license 状态卡片 + 录入 form + deactivate 按钮.
  无 30s polling (operator 自己 reload, 跟 R158.69.7 email-history 同 precedent).

  R158.License-config (2026-10-15) — 加 1 个新卡片 "License 申请单生成" + 状态卡片
  加 signature + installedAt 字段. 0 改既有 2 卡片 (R158.86.6 #5 wire shape preserve).
-->
<template>
  <div class="lic-view">
    <!-- R158.LA-UI (2026-10-15) — 3 tab nav. 跟 SystemSettingsView.ss-tabs 范式 1:1 平行. -->
    <!-- 0 引入 el-tabs (项目没装 Element Plus, 跟 EmailConfigView 同 precedent). -->
    <nav class="lic-tabs" role="tablist">
      <button
        :class="['lic-tab', { 'is-active': activeTab === 'status' }]"
        @click="activeTab = 'status'"
        type="button"
        role="tab"
        data-test="lic-tab-status"
      >
        当前 License
        <span :class="['lic-tab-badge', license?.has_license ? 'active' : 'inactive']">
          {{ license?.has_license ? '已激活' : '未激活' }}
        </span>
      </button>
      <button
        :class="['lic-tab', { 'is-active': activeTab === 'apply' }]"
        @click="activeTab = 'apply'"
        type="button"
        role="tab"
        data-test="lic-tab-apply"
      >
        License 申请
      </button>
      <button
        :class="['lic-tab', { 'is-active': activeTab === 'activate' }]"
        @click="activeTab = 'activate'"
        type="button"
        role="tab"
        data-test="lic-tab-activate"
      >
        录入激活
        <span v-if="base32Requests.length" class="lic-tab-count">{{ base32Requests.length }}</span>
      </button>
    </nav>

    <!-- Tab 1: 当前 License (状态只读 + ADSPK 录入) — 走 v-show 不重 mount -->
    <div v-show="activeTab === 'status'" class="lic-tab-panel" data-test="lic-panel-status">
      <!-- 状态卡片 -->
      <div class="lic-card" :class="{ active: license?.has_license }">
        <div class="lic-card-header">
          <h2 class="lic-card-title">当前 License 状态</h2>
          <span :class="['lic-badge', license?.has_license ? 'active' : 'inactive']">
            {{ license?.has_license ? '已激活' : '未激活' }}
          </span>
        </div>
        <div v-if="loading" class="lic-loading">加载中...</div>
        <div v-else class="lic-card-body">
          <div class="lic-row">
            <span class="lic-k">License Key:</span>
            <span class="lic-v">
              <code>{{ license?.license_key_masked || '—' }}</code>
            </span>
          </div>
          <div class="lic-row">
            <span class="lic-k">激活时间:</span>
            <span class="lic-v">{{ formatTime(license?.activated_at) }}</span>
          </div>
          <div class="lic-row">
            <span class="lic-k">到期时间:</span>
            <span class="lic-v">{{ formatTime(license?.expires_at) || '永久' }}</span>
          </div>
          <div class="lic-row">
            <span class="lic-k">实例 ID:</span>
            <span class="lic-v"><code>{{ license?.instance_id || '—' }}</code></span>
          </div>
          <div class="lic-row" v-if="license?.notes">
            <span class="lic-k">备注:</span>
            <span class="lic-v">{{ license.notes }}</span>
          </div>
          <div v-if="license?.has_license" class="lic-actions">
            <button @click="confirmDeactivate" :disabled="deactivating" class="lic-btn-danger">
              {{ deactivating ? '撤销中...' : '撤销 License' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ADSPK 老格式录入 form -->
      <div class="lic-card">
        <div class="lic-card-header">
          <h2 class="lic-card-title">{{ license?.has_license ? '替换 License (v1 ADSPK 老格式)' : '录入新 License (v1 ADSPK 老格式)' }}</h2>
        </div>
        <div class="lic-form">
          <div class="lic-form-row">
            <label class="lic-form-label">License Key <span class="lic-form-hint">(格式: ADSPK-XXXX-XXXX-XXXX-XXXX)</span></label>
            <input
              v-model="form.licenseKey"
              type="text"
              placeholder="ADSPK-AAAA-BBBB-CCCC-DDDD"
              class="lic-input"
              data-test="lic-input"
            />
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">备注 <span class="lic-form-hint">(可选, ≤500 字符)</span></label>
            <input
              v-model="form.notes"
              type="text"
              placeholder="激活来源/操作员"
              class="lic-input"
              maxlength="500"
            />
          </div>
          <div class="lic-form-actions">
            <button @click="submit" :disabled="submitting || !form.licenseKey" class="lic-btn-primary">
              {{ submitting ? '激活中...' : (license?.has_license ? '替换' : '激活') }}
            </button>
            <button @click="reset" class="lic-btn-secondary">清空</button>
          </div>
          <div v-if="errorMsg" class="lic-error">{{ errorMsg }}</div>
          <div v-if="successMsg" class="lic-success">{{ successMsg }}</div>
        </div>
      </div>
    </div>

    <!-- Tab 2: License 申请 (原卡片 3) -->
    <div v-show="activeTab === 'apply'" class="lic-tab-panel" data-test="lic-panel-apply">
      <!-- R158.License-config (2026-10-15) — License 申请单生成卡片 -->
      <div class="lic-card">
        <div class="lic-card-header">
          <h2 class="lic-card-title">🆕 License 申请单生成 (v2 base32 新格式)</h2>
        </div>
        <div class="lic-form">
          <p class="lic-hint">
            填写 5 字段, 生成注册文件并发送邮件到 <code class="lic-mail">fogyisland_x@hotmail.com</code> 进行激活或购买节点。
          </p>
          <div class="lic-form-row">
            <label class="lic-form-label">公司名称 <span class="lic-form-hint">(必填, 1-100 字符)</span></label>
            <input
              v-model="applyForm.company"
              type="text"
              placeholder="ABC Corp"
              class="lic-input"
              maxlength="100"
              data-test="lic-apply-company"
            />
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">Mac 地址 <span class="lic-form-hint">(自动获取本机, 可手改)</span></label>
            <input
              v-model="applyForm.mac"
              type="text"
              placeholder="00:1A:2B:3C:4D:5E"
              class="lic-input"
              data-test="lic-apply-mac"
            />
            <span v-if="serverMacs.length > 1" class="lic-form-subhint">
              检测到多个网卡: {{ serverMacs.map(m => `${m.name}=${m.mac}`).join(' / ') }}
            </span>
          </div>
          <div class="lic-form-row lic-form-row-2col">
            <div>
              <label class="lic-form-label">申请使用时间 — 月数 <span class="lic-form-hint">(1-120)</span></label>
              <input
                v-model.number="applyForm.months"
                type="number"
                min="1"
                max="120"
                class="lic-input"
                data-test="lic-apply-months"
              />
            </div>
            <div>
              <label class="lic-form-label">节点数 <span class="lic-form-hint">(1-10000)</span></label>
              <input
                v-model.number="applyForm.maxNodes"
                type="number"
                min="1"
                max="10000"
                class="lic-input"
                data-test="lic-apply-max-nodes"
              />
            </div>
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">安装时间 <span class="lic-form-hint">(只读, 本机系统首次启动时间)</span></label>
            <input
              :value="applyForm.installedAt || '—'"
              type="text"
              class="lic-input"
              readonly
              data-test="lic-apply-installed-at"
            />
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">Signature <span class="lic-form-hint">(只读, 32 hex, 本机身份指纹)</span></label>
            <input
              :value="applyForm.signature || '—'"
              type="text"
              class="lic-input"
              readonly
              data-test="lic-apply-signature"
            />
          </div>
          <div class="lic-form-actions">
            <button @click="generateRequest" :disabled="generating || !applyForm.company || !applyForm.mac" class="lic-btn-primary" data-test="lic-apply-generate">
              {{ generating ? '生成中...' : '生成申请单' }}
            </button>
            <button @click="copyRequest" :disabled="!request" class="lic-btn-secondary" data-test="lic-apply-copy">复制到剪贴板</button>
            <button @click="downloadRequest" :disabled="!request" class="lic-btn-secondary" data-test="lic-apply-download">下载 .json</button>
          </div>
          <div v-if="request" class="lic-request-block">
            <div class="lic-request-banner">
              📧 请把以下注册文件发送到 <code class="lic-mail">fogyisland_x@hotmail.com</code> 进行激活或购买节点
            </div>
            <pre class="lic-request-pre" data-test="lic-apply-output">{{ requestText }}</pre>
          </div>
          <div v-if="applyErrorMsg" class="lic-error">{{ applyErrorMsg }}</div>
          <div v-if="applySuccessMsg" class="lic-success">{{ applySuccessMsg }}</div>
        </div>
      </div>
    </div>

    <!-- Tab 3: 录入激活 (原卡片 4 + 黄底空状态引导) -->
    <div v-show="activeTab === 'activate'" class="lic-tab-panel" data-test="lic-panel-activate">
      <!-- 空状态引导 banner (复用 AdminEmailView.ae-banner-empty 黄底⚠️范式) -->
      <div v-if="!base32Requests.length" class="lic-empty-hint" data-test="lic-empty-hint">
        ⚠️ 还没有可用的申请单. 请先到
        <a @click.prevent="activeTab = 'apply'">License 申请</a>
        tab 生成.
      </div>

      <!-- 5 段 base32 License 录入卡片 -->
      <div class="lic-card">
        <div class="lic-card-header">
          <h2 class="lic-card-title">🆕 5 段 base32 License 录入 (v2 新格式)</h2>
          <span class="lic-form-hint">粘贴 .NET LicenseGen.exe 生成的 5 段注册码 + 选择对应申请单</span>
        </div>
        <div class="lic-form">
          <p class="lic-hint">
            选申请单 + 粘 5 段注册码 → 点「验证」 → 点「激活」完成闭环. 申请单列表自动从 [License 申请] tab 同步.
          </p>
          <div class="lic-form-row">
            <label class="lic-form-label">选择申请单 <span class="lic-form-hint">(必选)</span></label>
            <select v-model="base32Form.requestId" class="lic-input" data-test="lic-base32-request-id">
              <option value="">— 请选择 —</option>
              <option v-for="r in base32Requests" :key="r.requestId" :value="r.requestId">
                {{ r.requestId }} · {{ r.company }} · {{ r.months }}月/{{ r.maxNodes }}节点
              </option>
            </select>
            <button @click="loadBase32Requests" :disabled="loadingRequests" class="lic-btn-secondary" data-test="lic-base32-refresh" type="button">
              {{ loadingRequests ? '刷新中...' : '刷新列表' }}
            </button>
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">License Code <span class="lic-form-hint">(格式: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX)</span></label>
            <input
              v-model="base32Form.licenseCode"
              type="text"
              placeholder="ABCDE-FGHIJ-KLMNO-PQRST-UVWXY"
              class="lic-input"
              data-test="lic-base32-code"
            />
          </div>
          <div class="lic-form-row">
            <label class="lic-form-label">备注 <span class="lic-form-hint">(可选, ≤500 字符)</span></label>
            <input
              v-model="base32Form.notes"
              type="text"
              placeholder="激活来源/操作员"
              class="lic-input"
              maxlength="500"
              data-test="lic-base32-notes"
            />
          </div>
          <div class="lic-form-actions">
            <button @click="verifyBase32" :disabled="base32Busy || !base32Form.licenseCode || !base32Form.requestId" class="lic-btn-secondary" data-test="lic-base32-verify">
              {{ base32Verifying ? '验证中...' : '验证（不激活）' }}
            </button>
            <button @click="activateBase32" :disabled="base32Busy || !base32Form.licenseCode || !base32Form.requestId" class="lic-btn-primary" data-test="lic-base32-activate">
              {{ base32Activating ? '激活中...' : '激活' }}
            </button>
            <button @click="resetBase32" class="lic-btn-secondary" data-test="lic-base32-reset">清空</button>
          </div>
          <div v-if="base32VerifyResult" class="lic-success" data-test="lic-base32-verify-result">
            ✓ 验证通过 · 公司: {{ base32VerifyResult.company }} · 月数: {{ base32VerifyResult.months }} · 节点: {{ base32VerifyResult.max_nodes }} · 到期: {{ formatTime(base32VerifyResult.expires_at) }} · Code: <code>{{ base32VerifyResult.license_code_masked }}</code>
          </div>
          <div v-if="base32ActivateResult" class="lic-success" data-test="lic-base32-activate-result">
            ✓ 激活成功 · License ID: {{ base32ActivateResult.license_id }} · {{ base32ActivateResult.license_key_masked }} · 到期: {{ formatTime(base32ActivateResult.expires_at) }}
          </div>
          <div v-if="base32ErrorMsg" class="lic-error">{{ base32ErrorMsg }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue';
import { adminApi } from '../../../api/admin.js';

const license = ref(null);
const loading = ref(false);
const submitting = ref(false);
const deactivating = ref(false);
const form = ref({ licenseKey: '', notes: '' });
const errorMsg = ref('');
const successMsg = ref('');

// R158.LA-UI (2026-10-15) — 3 tab active state. 走 v-show 切 panel, 0 重 mount.
// 默认 status (操作员打开页面第一眼看到 "当前 License 状态").
const activeTab = ref('status');

// R158.License-config (2026-10-15) — 申请单生成 state
const applyForm = ref({
  company: '',
  mac: '',
  months: 12,
  maxNodes: 10,
  installedAt: '',
  signature: ''
});
const serverMacs = ref([]);
const generating = ref(false);
const request = ref(null);
const applyErrorMsg = ref('');
const applySuccessMsg = ref('');
const requestText = computed(() => request.value ? JSON.stringify(request.value, null, 2) : '');

async function loadLicense() {
  loading.value = true;
  try {
    const r = await adminApi.getLicense();
    license.value = r;
  } catch (e) {
    errorMsg.value = `加载失败: ${e?.response?.data?.error || e.message}`;
  } finally {
    loading.value = false;
  }
}

// R158.License-config — 申请单初始化: auto-fetch serverMac + signature + installedAt
async function loadApplyForm() {
  applyErrorMsg.value = '';
  try {
    const [sigR, macR] = await Promise.all([
      adminApi.getLicenseSignature().catch(() => ({ signature: null, installedAt: null })),
      adminApi.getServerMac().catch(() => ({ mac: null, allMacs: [] }))
    ]);
    applyForm.value.signature = sigR?.signature || '';
    applyForm.value.installedAt = sigR?.installedAt || '';
    applyForm.value.mac = macR?.mac || '';
    serverMacs.value = macR?.allMacs || [];
  } catch (e) {
    applyErrorMsg.value = `申请单初始化失败: ${e?.response?.data?.error || e.message}`;
  }
}

async function submit() {
  errorMsg.value = '';
  successMsg.value = '';
  submitting.value = true;
  try {
    const r = await adminApi.activateLicense(form.value.licenseKey, form.value.notes);
    successMsg.value = `激活成功 · ${r.license_key_masked} · ${r.activated_at}`;
    form.value.licenseKey = '';
    form.value.notes = '';
    await loadLicense();
  } catch (e) {
    const d = e?.response?.data;
    if (d?.error === 'invalid_license_format') {
      errorMsg.value = `格式错误: ${d.detail}`;
    } else if (d?.error === 'license_already_activated') {
      errorMsg.value = `License 已激活过 (existing_id=${d.existing_id})`;
    } else {
      errorMsg.value = `激活失败: ${d?.error || e.message}`;
    }
  } finally {
    submitting.value = false;
  }
}

async function confirmDeactivate() {
  if (!confirm(`确认撤销 License?\n当前 License: ${license.value?.license_key_masked}\n撤销后所有受 License 管控的功能将停用。`)) return;
  deactivating.value = true;
  errorMsg.value = '';
  try {
    const r = await adminApi.deactivateLicense();
    successMsg.value = `已撤销 (revoked_count=${r.revoked_count})`;
    await loadLicense();
  } catch (e) {
    errorMsg.value = `撤销失败: ${e?.response?.data?.error || e.message}`;
  } finally {
    deactivating.value = false;
  }
}

function reset() {
  form.value.licenseKey = '';
  form.value.notes = '';
  errorMsg.value = '';
  successMsg.value = '';
}

// R158.License-config — 申请单生成: 调后端 export-request 拿 JSON
async function generateRequest() {
  applyErrorMsg.value = '';
  applySuccessMsg.value = '';
  generating.value = true;
  try {
    const r = await adminApi.exportLicenseRequest({
      company: applyForm.value.company,
      mac: applyForm.value.mac,
      months: applyForm.value.months,
      maxNodes: applyForm.value.maxNodes
    });
    if (r?.ok && r?.request) {
      request.value = r.request;
      applySuccessMsg.value = '申请单生成成功, 请复制 / 下载并发送邮件';
    } else {
      applyErrorMsg.value = `生成失败: ${r?.error || r?.detail || 'unknown'}`;
    }
  } catch (e) {
    const d = e?.response?.data;
    applyErrorMsg.value = `生成失败: ${d?.detail || d?.error || e.message}`;
  } finally {
    generating.value = false;
  }
}

// R158.License-config — 复制到剪贴板
async function copyRequest() {
  if (!requestText.value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(requestText.value);
      applySuccessMsg.value = '已复制到剪贴板';
    } else {
      // fallback: textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = requestText.value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      applySuccessMsg.value = '已复制到剪贴板 (fallback)';
    }
  } catch (e) {
    applyErrorMsg.value = `复制失败: ${e.message}`;
  }
}

// R158.License-config — 下载 .json
function downloadRequest() {
  if (!request.value) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `license-request-${ts}.json`;
  const blob = new Blob([requestText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  applySuccessMsg.value = `已下载: ${filename}`;
}

// R158.LA (2026-10-15) — 5 段 base32 License 录入 state + 操作函数.
//   申请单列表走"卡片 3 已生成的 request 缓存" (Vue sessionStorage 跨刷新保留),
//   不新开 /license/requests 端点 (R158.LA plan D6 守). 验证 / 激活都走 request_id
//   反查落盘 JSON, 0 暴露 license 内容给前端.
const base32Form = ref({ requestId: '', licenseCode: '', notes: '' });
const base32Requests = ref([]);
const base32VerifyResult = ref(null);
const base32ActivateResult = ref(null);
const base32ErrorMsg = ref('');
const base32Verifying = ref(false);
const base32Activating = ref(false);
const base32Busy = computed(() => base32Verifying.value || base32Activating.value);
const loadingRequests = ref(false);
const BASE32_REQUESTS_KEY = 'license_base32_requests_v1';

function _loadBase32RequestsFromStorage() {
  try {
    const raw = sessionStorage.getItem(BASE32_REQUESTS_KEY);
    if (raw) base32Requests.value = JSON.parse(raw);
  } catch (_) { /* ignore parse error */ }
}

function _saveBase32RequestsToStorage() {
  try {
    sessionStorage.setItem(BASE32_REQUESTS_KEY, JSON.stringify(base32Requests.value));
  } catch (_) { /* sessionStorage 满 / 禁用, 0 阻塞 UI */ }
}

// 申请单卡片 3 生成的 request 自动入列表 (onMounted / watch request 双触发保险)
function _maybeCaptureRequest() {
  if (!request.value) return;
  const reqId = request.value?.request_id;
  if (!reqId) return;
  if (base32Requests.value.find(r => r.requestId === reqId)) return;
  base32Requests.value.unshift({
    requestId: reqId,
    company: request.value.company || '',
    months: request.value.months || 0,
    maxNodes: request.value.max_nodes || 0,
    capturedAt: new Date().toISOString()
  });
  _saveBase32RequestsToStorage();
}

// 手动刷新: 操作员可重调 export-request 拿服务端真源 (走 query 跟卡片 3 1:1 平行)
async function loadBase32Requests() {
  loadingRequests.value = true;
  base32ErrorMsg.value = '';
  try {
    // 走卡片 3 同样的 export-request 拿 (本机 instanceId 不变 → 同申请单). 卡片 3
    // 填了什么这里用同样值, 没填就用上次的或留空.
    const last = base32Requests.value[0] || {};
    const r = await adminApi.exportLicenseRequest({
      company: last.company || applyForm.value.company || '',
      mac: applyForm.value.mac || '',
      months: last.months || applyForm.value.months || 12,
      maxNodes: last.maxNodes || applyForm.value.maxNodes || 10
    });
    if (r?.ok && r?.request_id) {
      // 新生成的 request 走自捕获, 0 改 wire shape
      request.value = r.request;
      _maybeCaptureRequest();
    }
  } catch (e) {
    base32ErrorMsg.value = `刷新失败: ${e?.response?.data?.error || e.message}`;
  } finally {
    loadingRequests.value = false;
  }
}

async function verifyBase32() {
  base32ErrorMsg.value = '';
  base32VerifyResult.value = null;
  base32ActivateResult.value = null;
  base32Verifying.value = true;
  try {
    const r = await adminApi.verifyBase32License({
      licenseCode: base32Form.value.licenseCode,
      requestId: base32Form.value.requestId
    });
    if (r?.valid) {
      base32VerifyResult.value = r;
    } else {
      base32ErrorMsg.value = `验证失败: ${r?.error || 'invalid'}`;
    }
  } catch (e) {
    const d = e?.response?.data;
    if (d?.error === 'invalid_license_format') base32ErrorMsg.value = 'License 格式错误 (需 5 段 base32)';
    else if (d?.error === 'invalid_request_id') base32ErrorMsg.value = '申请单 ID 无效或已过期';
    else if (d?.error === 'license_verify_failed') base32ErrorMsg.value = 'License 验证失败 (HMAC 不匹配)';
    else base32ErrorMsg.value = `验证失败: ${d?.error || e.message}`;
  } finally {
    base32Verifying.value = false;
  }
}

async function activateBase32() {
  base32ErrorMsg.value = '';
  base32VerifyResult.value = null;
  base32ActivateResult.value = null;
  base32Activating.value = true;
  try {
    const r = await adminApi.activateBase32License({
      licenseCode: base32Form.value.licenseCode,
      requestId: base32Form.value.requestId,
      notes: base32Form.value.notes
    });
    if (r?.ok) {
      base32ActivateResult.value = r;
      // 激活成功后 reload 卡片 1 (status / kind 变 base32 / expires_at 更新)
      await loadLicense();
    } else {
      base32ErrorMsg.value = `激活失败: ${r?.error || 'unknown'}`;
    }
  } catch (e) {
    const d = e?.response?.data;
    if (d?.error === 'invalid_license_format') base32ErrorMsg.value = 'License 格式错误';
    else if (d?.error === 'invalid_request_id') base32ErrorMsg.value = '申请单 ID 无效或已过期';
    else if (d?.error === 'license_verify_failed') base32ErrorMsg.value = 'License 验证失败 (HMAC 不匹配)';
    else if (d?.error === 'license_already_activated') base32ErrorMsg.value = `License 已激活过 (existing_id=${d.existing_id})`;
    else base32ErrorMsg.value = `激活失败: ${d?.error || e.message}`;
  } finally {
    base32Activating.value = false;
  }
}

function resetBase32() {
  base32Form.value = { requestId: '', licenseCode: '', notes: '' };
  base32VerifyResult.value = null;
  base32ActivateResult.value = null;
  base32ErrorMsg.value = '';
}

function formatTime(s) {
  if (!s) return null;
  try {
    return new Date(s).toLocaleString('zh-CN', { hour12: false });
  } catch { return s; }
}

onMounted(() => {
  loadLicense();
  loadApplyForm();
  // R158.LA (2026-10-15) — 从 sessionStorage 恢复 base32 申请单列表 (跨刷新保留).
  _loadBase32RequestsFromStorage();
});

// R158.LA (2026-10-15) — 申请单卡片 3 生成后, 自动入 base32 卡片 4 列表.
//   监听 request 变化, 操作员生成后无需手动刷卡片 4.
//   R158.LA-UI (2026-10-15) — 升级: 申请单生成成功 → 自动切到 "录入激活" tab
//   + pre-select 最新 request. 操作员不用手动切 tab + 选 request.
//   0 拆 _maybeCaptureRequest 触发 (原 watch 已调, 这里叠加 UI 行为).
watch(request, (val) => {
  _maybeCaptureRequest();
  if (val && activeTab.value !== 'activate') {
    activeTab.value = 'activate';
    // pre-select 最新 request (base32Requests[0] 是新 push 进去的)
    base32Form.value.requestId = base32Requests.value[0]?.requestId || '';
  }
});

// R158.LA-UI (2026-10-15) — base32 激活成功 → 自动切回 "当前 License" tab.
//   原本激活成功只 await loadLicense() 但停留在 tab 3, 操作员得手动滑回去看新 status.
//   走 watch(base32ActivateResult) 在新值出现时切回 status tab, 看到新 badge.
watch(base32ActivateResult, (val) => {
  if (val && activeTab.value === 'activate') {
    activeTab.value = 'status';
  }
});
</script>

<style scoped>
.lic-view { display: flex; flex-direction: column; gap: 16px; }

/* R158.LA-UI (2026-10-15) — 顶部 3 tab nav. */
/* 跟 SystemSettingsView.ss-tabs 范式 1:1 平行 (手写 nav + 自定义 class). */
.lic-tabs {
  display: flex; gap: 4px;
  border-bottom: 1px solid var(--border);
  padding: 0; margin: 0;
}
.lic-tab {
  padding: 8px 16px;
  border: none; background: transparent;
  color: var(--muted); font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px; /* 让 active border 跟 nav border 重合 */
  display: flex; align-items: center; gap: 8px;
  transition: color 0.15s, border-color 0.15s;
}
.lic-tab:hover { color: var(--text); }
.lic-tab.is-active {
  color: var(--text);
  border-bottom-color: var(--accent, #3b82f6);
  font-weight: 600;
}
.lic-tab-badge {
  padding: 1px 8px; border-radius: 10px; font-size: 11px;
}
.lic-tab-badge.active { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.lic-tab-badge.inactive { background: rgba(156, 163, 175, 0.15); color: #6b7280; }
.lic-tab-count {
  padding: 1px 6px; border-radius: 8px; font-size: 11px;
  background: rgba(59, 130, 246, 0.15); color: var(--accent, #3b82f6);
  font-weight: 500;
}

/* tab panel — 16px gap 跟原 .lic-view 1:1 平行, 加 16px 上 padding 跟 nav 隔开 */
.lic-tab-panel {
  display: flex; flex-direction: column; gap: 16px;
  padding-top: 16px;
}

/* tab 3 空状态黄底引导 — 复用 AdminEmailView.ae-banner-empty 范式 */
.lic-empty-hint {
  padding: 12px 16px;
  background: rgba(245, 158, 11, 0.12);
  border-left: 3px solid #f59e0b;
  color: #92400e;
  font-size: 13px;
  border-radius: 4px;
}
.lic-empty-hint a {
  color: var(--accent, #3b82f6);
  text-decoration: underline;
  cursor: pointer;
  font-weight: 600;
}
.lic-card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
.lic-card.active { border-left: 3px solid #16a34a; }
.lic-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.lic-card-title { font-size: 14px; font-weight: 600; margin: 0; }
.lic-badge { padding: 2px 10px; border-radius: 12px; font-size: 12px; }
.lic-badge.active { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.lic-badge.inactive { background: rgba(156, 163, 175, 0.15); color: #6b7280; }
.lic-loading { color: var(--muted); font-size: 13px; }
.lic-card-body { display: flex; flex-direction: column; gap: 8px; }
.lic-row { display: flex; gap: 12px; font-size: 13px; }
.lic-k { color: var(--muted); width: 100px; }
.lic-v { color: var(--text); }
.lic-v code { font-family: monospace; font-size: 12px; color: var(--accent, #3b82f6); }
.lic-actions { margin-top: 8px; }
.lic-btn-danger { padding: 6px 14px; border: 1px solid rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.1); color: #dc2626; border-radius: 4px; cursor: pointer; font-size: 12px; }
.lic-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
.lic-form { display: flex; flex-direction: column; gap: 12px; }
.lic-form-row { display: flex; flex-direction: column; gap: 4px; }
.lic-form-label { font-size: 12px; color: var(--muted); }
.lic-form-hint { color: var(--muted); font-size: 11px; margin-left: 4px; }
.lic-input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--input-bg); color: var(--text); font-size: 13px; font-family: monospace; }
.lic-form-actions { display: flex; gap: 8px; }
.lic-btn-primary { padding: 6px 16px; border: none; background: var(--accent, #3b82f6); color: #fff; border-radius: 4px; cursor: pointer; font-size: 13px; }
.lic-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.lic-btn-secondary { padding: 6px 16px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 4px; cursor: pointer; font-size: 13px; }
.lic-error { color: #dc2626; font-size: 12px; padding: 8px; background: rgba(239, 68, 68, 0.1); border-radius: 4px; }
.lic-success { color: #16a34a; font-size: 12px; padding: 8px; background: rgba(34, 197, 94, 0.1); border-radius: 4px; }
/* R158.License-config (2026-10-15) — 申请单生成卡片样式 */
.lic-hint { font-size: 12px; color: var(--muted); margin: 0 0 4px 0; }
.lic-mail { color: #2563eb; font-family: monospace; font-size: 12px; background: rgba(37, 99, 235, 0.08); padding: 1px 4px; border-radius: 3px; }
.lic-form-row-2col { display: flex; gap: 12px; }
.lic-form-row-2col > div { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.lic-form-subhint { color: var(--muted); font-size: 11px; margin-top: 2px; }
.lic-request-block { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.lic-request-banner { padding: 10px 12px; background: rgba(245, 158, 11, 0.12); border-left: 3px solid #f59e0b; color: #92400e; font-size: 12px; border-radius: 4px; }
.lic-request-pre { background: #1e293b; color: #e2e8f0; padding: 12px; border-radius: 4px; font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; max-height: 360px; white-space: pre-wrap; word-break: break-all; }
</style>
