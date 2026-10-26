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
        当前许可证
        <span :class="['lic-tab-badge', licenseView.badge.cls]" data-test="lic-tab-badge">
          {{ licenseView.badge.text }}
        </span>
      </button>
      <button
        :class="['lic-tab', { 'is-active': activeTab === 'apply' }]"
        @click="activeTab = 'apply'"
        type="button"
        role="tab"
        data-test="lic-tab-apply"
      >
        许可证申请
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

    <!-- Tab 1: 当前 License (状态只读, base32 激活后展示) — 走 v-show 不重 mount -->
    <!-- R158.LA-V1-delete (2026-10-15) — 删 ADSPK V1 录入 form + 撤销按钮, V2 base32 是唯一路径. -->
    <div v-show="activeTab === 'status'" class="lic-tab-panel" data-test="lic-panel-status">
      <!-- R161.7 (2026-10-26) — status 卡片改读**服务端** license-state 真源.
           旧的 localStorage 判据是"本浏览器曾成功录入过 base32 激活" ⇒ 换浏览器 /
           清缓存 ⇒ 明明激活过也显示「未激活」; 且默认安装的 30 天试用压根不显示。 -->
      <div
        v-if="!loading && licenseView.serverKnown && !licenseView.hasLicense && !licenseView.trialKnown"
        class="lic-empty-hint"
        data-test="lic-empty-hint-status"
      >
        ⚠️ 既没有正式授权, 也没有可用的本地试用. 请到
        <a @click.prevent="activeTab = 'activate'">录入激活</a>
        tab 完成首次激活.
      </div>
      <!-- 状态卡片 -->
      <div class="lic-card" :class="{ active: licenseView.hasLicense }">
        <div class="lic-card-header">
          <h2 class="lic-card-title">当前许可证状态</h2>
          <span :class="['lic-badge', licenseView.badge.cls]" data-test="lic-badge">
            {{ licenseView.badge.text }}
          </span>
        </div>
        <div v-if="loading" class="lic-loading">加载中...</div>
        <div v-else class="lic-card-body">
          <!-- R161.7 — 正式授权 (服务端真源: has_license / expires_at / status) -->
          <div class="lic-row" data-test="lic-license-row">
            <span class="lic-k">正式授权:</span>
            <span class="lic-v">
              <template v-if="licenseView.hasLicense">
                已激活
                <template v-if="licenseView.detail?.expires_at">
                  (到期 {{ formatTime(licenseView.detail.expires_at) }}
                  <template v-if="licenseView.daysRemaining !== null">
                    , 还剩 {{ licenseView.daysRemaining }} 天
                  </template>)
                </template>
                <template v-else>(永久)</template>
              </template>
              <template v-else-if="licenseView.serverKnown">未激活</template>
              <template v-else>未知 (服务端状态不可用: DB 异常或端点未达)</template>
            </span>
          </div>
          <!-- R161.7 — 本地试用 (默认安装自动授予 30 天, installed_at 锚点).
               试用不依赖 DB, 所以即使 license-state 端点抖动也能显示。 -->
          <div class="lic-row" data-test="lic-trial-row">
            <span class="lic-k">本地试用:</span>
            <span class="lic-v">
              <template v-if="licenseView.trialKnown && licenseView.daysRemaining >= 0">
                试用中, 还剩 {{ licenseView.daysRemaining }} 天
                <template v-if="licenseView.trial?.expires_at">
                  (到期 {{ licenseView.trial.expires_at }})
                </template>
              </template>
              <template v-else-if="licenseView.trialKnown">
                试用已过期 {{ Math.abs(licenseView.daysRemaining) }} 天
              </template>
              <template v-else-if="licenseView.hasLicense">不适用 (已有正式授权)</template>
              <template v-else>—</template>
            </span>
          </div>
          <template v-if="licenseView.hasLicense">
          <div class="lic-row">
            <span class="lic-k">许可证密钥:</span>
            <span class="lic-v">
              <code>{{ licenseView.detail?.license_key_masked || '—' }}</code>
            </span>
          </div>
          <div class="lic-row" v-if="licenseView.detail?.license_kind">
            <span class="lic-k">格式:</span>
            <span class="lic-v"><code>{{ licenseView.detail.license_kind }}</code> (5 段 base32)</span>
          </div>
          <div class="lic-row">
            <span class="lic-k">激活时间:</span>
            <span class="lic-v">{{ formatTime(licenseView.detail?.activated_at) }}</span>
          </div>
          <div class="lic-row">
            <span class="lic-k">到期时间:</span>
            <span class="lic-v">{{ formatTime(licenseView.detail?.expires_at) || '永久' }}</span>
          </div>
          <div class="lic-row">
            <span class="lic-k">实例 ID:</span>
            <span class="lic-v"><code>{{ licenseView.detail?.instance_id || '—' }}</code></span>
          </div>
          <div class="lic-row" v-if="licenseView.detail?.request_id">
            <span class="lic-k">申请单 ID:</span>
            <span class="lic-v"><code>{{ licenseView.detail.request_id }}</code></span>
          </div>
          </template>
          <p v-else class="lic-hint">
            还没有正式授权. 试用期内功能可用; 需要正式授权请到「录入激活」tab.
          </p>
          <!-- R158.X.99-quota (2026-10-21) — 节点配额 (申请数 + 20% 宽限 + 实际用量).
               3 种状态分别渲染, 刻意区分「不限额」与「限额但统计不到」—— 后者是降级,
               操作员必须能看出数据不全而不是以为没超额 (lesson 71/72). -->
          <div class="lic-row lic-row-quota" data-test="lic-quota">
            <span class="lic-k">节点配额:</span>
            <span class="lic-v">
              <template v-if="quota && quota.allowed_nodes == null">
                <span class="lic-quota-none">未设配额 (不限节点数)</span>
              </template>
              <template v-else-if="quota">
                <span class="lic-quota-nums">
                  已用 <strong>{{ quota.used_nodes ?? '未知' }}</strong>
                  / 上限 <strong>{{ quota.allowed_nodes }}</strong>
                </span>
                <span class="lic-quota-detail">
                  (申请 {{ quota.max_nodes }} 个, 含 {{ quota.headroom_ratio }}× 宽限)
                </span>
                <span v-if="quota.over_quota" class="lic-quota-over" data-test="lic-quota-over">
                  ⚠️ 已超过限额 {{ Math.abs(quota.remaining_nodes) }} 台, 超出部分的数据服务端不再接收
                </span>
                <span v-else-if="quota.used_nodes == null" class="lic-quota-unknown">
                  (用量统计暂不可用, 未做超额判定)
                </span>
                <span v-else class="lic-quota-remaining">
                  剩余可接入 <strong>{{ quota.remaining_nodes }}</strong> 台
                </span>
              </template>
              <span v-else class="lic-quota-none">—</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 2: License 申请 (原卡片 3) -->
    <div v-show="activeTab === 'apply'" class="lic-tab-panel" data-test="lic-panel-apply">
      <!-- R158.License-config (2026-10-15) — License 申请单生成卡片 -->
      <div class="lic-card">
        <div class="lic-card-header">
          <h2 class="lic-card-title">🆕 许可证申请单生成</h2>
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
              required
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
              <!-- R158.X.99.30 (2026-10-19) — 周期单位月→年, range 1-5 (默认 1) -->
              <label class="lic-form-label">申请使用时间 — 年数 <span class="lic-form-hint">(1-5)</span></label>
              <input
                v-model.number="applyForm.months"
                type="number"
                min="1"
                max="5"
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
            <!-- R158.X.99.30.c (2026-10-19) — 操作员 directive 进一步修正: 申请时间本地 YYYY-MM-DD 纯日期 (0 时分秒, 0 UTC), caption 简化为 "申请时间" -->
            <label class="lic-form-label">申请时间</label>
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
        <a @click.prevent="activeTab = 'apply'">许可证申请</a>
        tab 生成.
      </div>

      <!-- 5 段 base32 License 录入卡片 -->
      <div class="lic-card">
        <div class="lic-card-header">
          <h2 class="lic-card-title">🆕 5 段注册码录入</h2>
          <span class="lic-form-hint">粘贴 .NET LicenseGen.exe 生成的 5 段注册码 + 选择对应申请单</span>
        </div>
        <div class="lic-form">
          <p class="lic-hint">
            选申请单 + 粘 5 段注册码 → 点「验证」 → 点「激活」完成闭环. 申请单列表自动从 [许可证申请] tab 同步.
          </p>
          <div class="lic-form-row">
            <label class="lic-form-label">选择申请单 <span class="lic-form-hint">(必选)</span></label>
            <select v-model="base32Form.requestId" class="lic-input" data-test="lic-base32-request-id">
              <option value="">— 请选择 —</option>
              <option v-for="r in base32Requests" :key="r.requestId" :value="r.requestId">
                {{ r.requestId }} · {{ r.company }} · {{ r.months }}年/{{ r.maxNodes }}节点
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
            ✓ 验证通过 · 公司: {{ base32VerifyResult.company }} · 年数: {{ base32VerifyResult.months }} · 节点: {{ base32VerifyResult.max_nodes }} · 到期: {{ formatTime(base32VerifyResult.expires_at) }} · Code: <code>{{ base32VerifyResult.license_code_masked }}</code>
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
// R161.7 — 许可证状态判定的唯一实现 (前端侧). 语义与后端
//   src/services/license-state.js 的 envelope 形状 1:1 对齐.
import { resolveLicenseView } from '../../../lib/licenseStatus.js';
import { formatDateTime } from '../../../lib/timezone.js';

// R158.LA-V1-delete (2026-10-15) — license ref 改 base32Status (读 localStorage cache, 0 调后端).
//   V1 ADSPK 录入 (form/submit/submitting) + 撤销 (confirmDeactivate/deactivating) + 状态
//   (errorMsg/successMsg 跟它们绑) 全删. status 卡片在 base32 activate 成功时写 localStorage,
//   onMounted 时读, reload 后仍能显示激活状态. 跨浏览器 / 清缓存 → fallback "未激活" + 黄底 banner.
//
// R161.7 (2026-10-26) — 上面这段 localStorage 判据**降级成"本地回显"**, 不再是激活事实.
//
// ★ 触发这次改的现场 (operator 2026-10-26 原话):
//   「当前默认安装后的本地送 30 的激活状态没有显示, 是不需要还是没有激活呢?」
//   "本地送 30" = 默认安装自动授予的 **30 天试用** (TRIAL_DAYS=30, installed_at 锚点,
//   服务端 license-state 的 trial envelope)。答案是: **试用是有的**, 不是"不需要";
//   没显示是因为这张卡片**只读 localStorage** 的 base32 激活缓存, 完全没读服务端 envelope:
//     ① 「未激活」徽标讲的是"base32 正式授权没录入过" —— 默认安装下这是事实;
//     ② 但"本地送 30 天"这件事**在许可证页上根本没有呈现** (只在登录页 banner 里);
//     ③ 更糟: 真正激活过也会显示「未激活」 (换浏览器 / 清缓存 ⇒ localStorage 空),
//        因为 localStorage 从来不是激活事实的真源。
//   ⇒ 改法: 卡片以**服务端 license-state** 为真源 (has_license / status / expires_at /
//     instance_id / license_kind / trial), localStorage 只补服务端**给不出**的字段
//     (许可证密钥掩码 —— 服务端只存 hash, 存不了明文), 且服务端不可用时整体回落
//     (0 回归 R158.LA-V1-delete 的既有行为).
const base32Status = ref(null);
const loading = ref(false);
const BASE32_STATUS_KEY = 'base32_license_status_v1';

async function loadBase32Status() {
  loading.value = true;
  try {
    const raw = localStorage.getItem(BASE32_STATUS_KEY);
    if (raw) {
      try {
        base32Status.value = JSON.parse(raw);
      } catch (_) {
        // parse 失败 (corrupt data), fallback 删 key + null
        localStorage.removeItem(BASE32_STATUS_KEY);
        base32Status.value = null;
      }
    } else {
      base32Status.value = null;
    }
  } finally {
    loading.value = false;
  }
}

// R158.X.99-quota (2026-10-21) — 节点配额. **刻意不存 localStorage**:
//   base32Status 是"激活过没有"的历史事实, 缓存合理; 而配额里的 used_nodes
//   是**实时接入数**, 缓存会让操作员看到过期数字并据此误判是否超额.
//   所以每次打开页面现拉 license-state 端点.
//   端点本身在 router.js 有 30s 模块级 cache, 这里重复拉代价可忽略.
const quota = ref(null);
const quotaLoadError = ref(false);
const licenseState = ref(null);

async function loadLicenseState() {
  try {
    const s = await adminApi.getLicenseState();
    licenseState.value = s ?? null;
    quota.value = s?.quota ?? null;
    quotaLoadError.value = false;
  } catch (_e) {
    // fail-open: 拿不到配额就显示 "—", 0 假装限额充足. enforced 状态未知时
    // **0** 在界面断言"还有名额" —— 那是误导 (lesson 71/72).
    // 同样: 服务端 envelope 拿不到 ⇒ licenseState=null ⇒ 状态徽标回落 localStorage,
    // 试用行显示 "—" (不假装还有试用).
    licenseState.value = null;
    quota.value = null;
    quotaLoadError.value = true;
  }
}

// R161.7 — 状态卡片的**单一真源**视图. 判定逻辑全在 web/src/lib/licenseStatus.js
//   (纯函数, 0 在模板里现算优先级 —— 分散判定 = 又一处"改了一处忘了另一处")。
//   回归网: center/tests/license-status-view.test.js
const licenseView = computed(() => resolveLicenseView({
  serverState: licenseState.value,
  localStatus: base32Status.value
}));

// R158.LA-UI (2026-10-15) — 3 tab active state. 走 v-show 切 panel, 0 重 mount.
// 默认 status (操作员打开页面第一眼看到 "当前 License 状态").
const activeTab = ref('status');

// R158.License-config (2026-10-15) — 申请单生成 state
// R158.X.99.30 (2026-10-19) — 默认 1 年 (操作员 directive, 原 12 月)
const applyForm = ref({
  company: '',
  mac: '',
  months: 1,
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

// R158.X.99.30.c (2026-10-19) — 本地时区 YYYY-MM-DD 纯日期 (0 必 toISOString UTC).
//   1:1 平行前端既有 formatDate 范式 (PackageEditView.vue:233 / RegistryView.vue:123),
//   0 复用既有 formatDate 因为 = toLocaleString('zh-CN', { hour12: false }) = "2026/10/19 13:13:08"
//   (带时分秒 + 中文斜杠), 跟操作员 directive "YYYY-MM-DD" 0 一致, 必新写.
//   跟后端 toLocalYmd() (system-settings-v2.js) 1:1 平行: 浏览器 Date 跟 Node Date 都用
//   系统本地时区 (getFullYear/getMonth/getDate), 0 受 UTC 偏移影响. 操作员明确 "0 是 UTC, 是本地时间".
//
// R161.11 — ★ **有意不走 lib/timezone.js**, 理由必须写清楚, 免得后人当漏改的 bug 又改一遍:
//   这个值是一个**日历日期 (业务日期)**, 不是"某一瞬间" —— 它是 DATE 列
//   `installed_at` 的取值, 也是申请单里的"今天", 语义上属于许可证业务的
//   自然日, 不是"存储的 UTC 时间戳"。
//   ⇒ 全站其它时间戳都按显示时区渲染 (lib/timezone.js), 但这一处**故意**留在
//     本地日历日, 因为后端 license-state.js 的**试用期天数**就是按服务端的
//     "今天"算的 (server-local toLocalYmd), 两边必须同一个框架, 否则
//     申请日期跟试用天数可能差一天。
//   ⇒ 显示时区 (系统设置 → 时区) 管的是**时刻怎么显示**; 日历日本身由
//     许可证业务规则定, 两者不混。
function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// R158.License-config — 申请单初始化: auto-fetch serverMac + signature + installedAt
// R158.X.99.30.b (2026-10-19) — installedAt 0 必从 getLicenseSignature 读 (boot 时戳, R158.License-config
//   precedent ensureSignatureAndInstalledAt 写一次), 必 = 当前申请时间 (前端当下时戳).
// R158.X.99.30.c (2026-10-19) — 操作员 directive 进一步修正: 0 必 ISO 8601 UTC ("2026-10-19T05:13:08.711Z"),
//   必本地时区 YYYY-MM-DD 纯日期 (例 "2026-10-19", 0 时分秒). 1:1 平行后端 toLocalYmd() helper
//   (system-settings-v2.js). 0 复用既有 formatDate (走 toLocaleString='zh-CN'="2026/10/19 13:13:08",
//   带时分秒, 跟 0 一致, 必新写). 0 必 toISOString (返 UTC). 0 必改 installed_at 列名 (D1 锁).
async function loadApplyForm() {
  applyErrorMsg.value = '';
  try {
    const [sigR, macR] = await Promise.all([
      adminApi.getLicenseSignature().catch(() => ({ signature: null, installedAt: null })),
      adminApi.getServerMac().catch(() => ({ mac: null, allMacs: [] }))
    ]);
    applyForm.value.signature = sigR?.signature || '';
    applyForm.value.installedAt = formatYmd(new Date());  // R158.X.99.30.c — 本地 YYYY-MM-DD 纯日期 (0 必 toISOString UTC)
    applyForm.value.mac = macR?.mac || '';
    serverMacs.value = macR?.allMacs || [];
  } catch (e) {
    applyErrorMsg.value = `申请单初始化失败: ${e?.response?.data?.error || e.message}`;
  }
}

// R158.License-config — 申请单生成: 调后端 export-request 拿 JSON
async function generateRequest() {
  applyErrorMsg.value = '';
  applySuccessMsg.value = '';
  // R158.X.99.30.fix-empty (2026-10-19) — 前端兜底校验必填字段, 空 company / 空 mac
  //   不发请求, 友好提示操作员填好再点. 后端 license-validator.js 校验仍保留
  //   (D-1 业务规则), 1:1 平行 R158.X.99.30.b/c 兜底范式: 前端校验是 UX, 后端校验是真值.
  //   真因 = 操作员第一次打开 License 页直接点 "生成申请单" → 后端 license-validator
  //   拒空 company → 400 + machine error `company_length_out_of_range:1-100` 操作员看不懂.
  //   lesson 19 precedent (R158.Y.12) "操作员观察 ≠ 实际 bug, 是 UX 缺".
  const companyTrim = (applyForm.value.company || '').trim();
  const macTrim = (applyForm.value.mac || '').trim();
  if (!companyTrim) {
    applyErrorMsg.value = '请先填写公司名称 (1-100 字符)';
    return;
  }
  if (!macTrim) {
    applyErrorMsg.value = '请先填写 Mac 地址 (1-64 字符)';
    return;
  }
  if (!Number.isInteger(applyForm.value.months) || applyForm.value.months < 1 || applyForm.value.months > 5) {
    applyErrorMsg.value = '申请使用年数必须 1-5 之间';
    return;
  }
  if (!Number.isInteger(applyForm.value.maxNodes) || applyForm.value.maxNodes < 1 || applyForm.value.maxNodes > 10000) {
    applyErrorMsg.value = '节点数必须 1-10000 之间';
    return;
  }
  generating.value = true;
  try {
    const r = await adminApi.exportLicenseRequest({
      company: applyForm.value.company,
      mac: applyForm.value.mac,
      months: applyForm.value.months,
      maxNodes: applyForm.value.maxNodes,
      // R158.X.99.30.b (2026-10-19) — 必发 appliedAt 走完整链路, 0 走后端兜底.
      appliedAt: applyForm.value.installedAt
    });
    if (r?.ok && r?.request) {
      request.value = r.request;
      applySuccessMsg.value = '申请单生成成功, 请复制 / 下载并发送邮件';
    } else {
      applyErrorMsg.value = `生成失败: ${translateLicenseError(r?.detail || r?.error)}`;
    }
  } catch (e) {
    const d = e?.response?.data;
    applyErrorMsg.value = `生成失败: ${translateLicenseError(d?.detail || d?.error || e.message)}`;
  } finally {
    generating.value = false;
  }
}

// R158.X.99.30.fix-empty (2026-10-19) — 后端 license-validator.js 返的 error code
//   翻成中文. 走 switch 1:1 平行后端 error string (license-validator.js:100-117),
//   0 必走 i18n / vue-i18n (项目 0 装, 0 改 import, 跟 EmailConfigView 同 precedent).
//   默认 fallback 返 err 原字, 0 一律兜字避免回显英文机器错误.
function translateLicenseError(err) {
  switch (err) {
    case 'company_must_be_string':
    case 'company_length_out_of_range:1-100':
      return '公司名称必须是 1-100 字符';
    case 'mac_must_be_string':
    case 'mac_length_out_of_range:1-64':
      return 'Mac 地址必须是 1-64 字符';
    case 'months_out_of_range:1-5':
      return '申请使用年数必须 1-5 之间';
    case 'max_nodes_out_of_range:1-10000':
      return '节点数必须 1-10000 之间';
    default:
      return err || 'unknown';
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
// R158.LA-hide-activated (2026-10-23) — 申请单列表真源**改为后端**
//   GET /license/requests (读 ad_license_request, activated_at IS NULL 才返回).
//   原先走 sessionStorage 缓存且刻意不开列表端点 (R158.LA plan D6 守), 但那个决定
//   在「已激活的不显示」这个新需求下失效了: 本地缓存无从知道 activated_at。
//   验证 / 激活仍走 request_id 反查落盘 JSON, 0 暴露 license 内容给前端.
const base32Form = ref({ requestId: '', licenseCode: '', notes: '' });
const base32Requests = ref([]);
const base32VerifyResult = ref(null);
const base32ActivateResult = ref(null);
const base32ErrorMsg = ref('');
const base32Verifying = ref(false);
const base32Activating = ref(false);
const base32Busy = computed(() => base32Verifying.value || base32Activating.value);
const loadingRequests = ref(false);

// R158.LA-hide-activated (2026-10-23) — 删 _loadBase32RequestsFromStorage /
//   _saveBase32RequestsToStorage / BASE32_REQUESTS_KEY: 列表真源改成后端
//   ad_license_request 之后, sessionStorage 缓存既帮不上忙又会撒谎 ——
//   浏览器本地那份永远不知道 activated_at, 清缓存还会把操作员的申请单记忆抹掉。
//   前端 localStorage 缓存一律只留 status 卡片那个 (base32Status), 那是纯展示用。
//
// 申请单卡片 3 刚生成的 request: 改成**重新拉后端列表**而不是本地 push。
//   为什么不再本地 unshift: 新单此刻可能还没落 DB (insert 失败时后端只吞成一条
//   warn), 本地塞一份会造成"界面上有、库里没有"的幽灵条目 —— 而这正是本次
//   ad_license_request 长期 0 行的教训。后端返什么就显示什么, 单一口径。
function _maybeCaptureRequest() {
  if (!request.value?.request_id) return;
  void loadBase32Requests();
}

// 刷新列表: 读后端 ad_license_request, **已激活的不返回**。
// R158.LA-hide-activated (2026-10-23) — 语义整个换了, 3 个原因:
//   1. 旧的【刷新列表】调的是 export-request, 也就是**每次点都生成一份新申请单**,
//      0 读 DB。所以 activated_at 填得再准, 前端也看不见 → 「已激活不显示」根本无从谈起。
//   2. 旧列表是 sessionStorage, 清缓存 / 换浏览器 / 无痕窗口全丢, 操作员看不到历史。
//   3. 已激活的单还会卡在下拉里, 选了必然 409 (护栏本来就拦得住), 是纯误导。
//
// ⚠ 字段名映射: 后端返 snake_case (request_id / max_nodes), 模板消费的是
//   requestId / maxNodes —— 这里显式改写, 0 改模板 (R158.lesson 13: 改 shape 必 sync 消费点)。
async function loadBase32Requests() {
  loadingRequests.value = true;
  base32ErrorMsg.value = '';
  try {
    const r = await adminApi.listLicenseRequests();
    base32Requests.value = (r?.requests || []).map(x => ({
      requestId: x.request_id,
      company: x.company || '',
      months: x.months || 0,
      maxNodes: x.max_nodes || 0
    }));
    // 刷新后如果选中的那份已经不在列表里 (比如刚被激活掉了), 清掉选择,
    // 避免 v-model 指向一个下拉里没有的 option —— 那会让「激活」按钮一直可点却必然 409。
    if (base32Form.value.requestId
        && !base32Requests.value.some(x => x.requestId === base32Form.value.requestId)) {
      base32Form.value.requestId = '';
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
      // R158.LA-V1-delete (2026-10-15) — 写 localStorage cache, reload 后 status 卡片仍能显示.
      //   shape 跟 read 时 parse 1:1 平行 (has_license + license_kind + masked + activated_at +
      //   expires_at + instance_id + license_id + request_id). 0 改后端, 0 改 base32 闭环.
      const cache = {
        has_license: true,
        license_kind: r.license_kind || 'base32',
        license_key_masked: r.license_key_masked,
        activated_at: r.activated_at,
        expires_at: r.expires_at,
        instance_id: r.instance_id,
        license_id: r.license_id,
        request_id: r.request_id
      };
      try { localStorage.setItem(BASE32_STATUS_KEY, JSON.stringify(cache)); } catch (_) { /* localStorage 满 / 禁用, 0 阻塞 UI */ }
      await loadBase32Status();
      // R158.X.99-quota — 新激活的 license 才刚写入 max_nodes / max_nodes_allowed,
      //   配额视图必须现拉才能显示正确的"申请 N 个 / 上限 M 台". 不刷新的话操作员
      //   激活完还看到激活前的空配额, 会以为配额功能坏了.
      // R161.7 — 同一个请求同时刷**激活状态真源** (服务端 license-state) 与配额:
      //   激活成功后本浏览器的 localStorage 回显有了, 但服务端 envelope 才说了算.
      await loadLicenseState();
      // R158.LA-hide-activated (2026-10-23) — 刚激活的那份已经 activated_at 非空,
      //   后端列表端点不会再返它。不刷新的话它会继续留在下拉里, 操作员会再选一次
      //   然后撞 409 「已激活过」—— 纯属自己制造的误导。
      //   loadBase32Requests 里同时清了 base32Form.requestId (该单已不在列表里)。
      await loadBase32Requests();
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
    return formatDateTime(s);
  } catch { return s; }
}

onMounted(() => {
  // R158.LA-V1-delete (2026-10-15) — loadBase32Status 读 localStorage cache, 0 调后端.
  loadBase32Status();
  loadApplyForm();
  // R158.X.99-quota (2026-10-21) — 配额走端点现拉 (实时用量, 不缓存).
  // R161.7 — 同一请求顺带取回激活状态真源 (has_license / status / trial).
  loadLicenseState();
  // R158.LA-hide-activated (2026-10-23) — 申请单列表改读后端 ad_license_request.
  //   不再从 sessionStorage 恢复: 那是纯浏览器本地状态, 清缓存/换浏览器就全丢,
  //   而且它不知道 activated_at → 根本没法过滤已激活的单。
  //   已激活的申请单后端不返回 (activated_at IS NULL), 0 前端过滤。
  loadBase32Requests();
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
/* R161.7 — 试用中 (蓝) / 试用已过期 (橙). 刻意跟 已激活(绿)/未激活(灰) 区分:
   操作员一眼能分清"还在试用"跟"正式授权已激活" —— 两者是**并行**状态, 不是同一个. */
.lic-tab-badge.trial { background: rgba(59, 130, 246, 0.15); color: #2563eb; }
.lic-tab-badge.expired { background: rgba(249, 115, 22, 0.15); color: #ea580c; }
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
/* R161.7 — 同 tab-badge: 试用中(蓝) / 试用已过期(橙) */
.lic-badge.trial { background: rgba(59, 130, 246, 0.15); color: #2563eb; }
.lic-badge.expired { background: rgba(249, 115, 22, 0.15); color: #ea580c; }
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
/* R158.X.99-quota (2026-10-21) — 节点配额显示. 超额用红底警示 (操作员 2026-10-21
   明确要求"在 License 直接告警超过限额"), 正常态保持跟其余 lic-row 一致的低干扰灰.
   lic-quota-unknown (限额已知但用量查不到) 用琥珀色 —— 刻意区别于绿色的"还有名额",
   免得操作员把"统计失败"误读成"没超额". */
.lic-row-quota { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.lic-quota-nums { font-size: 13px; }
.lic-quota-detail { color: var(--muted); font-size: 11px; margin-left: 6px; }
.lic-quota-none { color: var(--muted); font-size: 12px; }
.lic-quota-remaining { color: #16a34a; font-size: 12px; margin-left: 6px; }
.lic-quota-unknown { color: #b45309; font-size: 11px; margin-left: 6px; }
.lic-quota-over {
  display: block;
  margin-top: 6px;
  padding: 6px 10px;
  background: rgba(239, 68, 68, 0.10);
  color: #dc2626;
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}
.lic-request-block { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.lic-request-banner { padding: 10px 12px; background: rgba(245, 158, 11, 0.12); border-left: 3px solid #f59e0b; color: #92400e; font-size: 12px; border-radius: 4px; }
.lic-request-pre { background: #1e293b; color: #e2e8f0; padding: 12px; border-radius: 4px; font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; max-height: 360px; white-space: pre-wrap; word-break: break-all; }
</style>
