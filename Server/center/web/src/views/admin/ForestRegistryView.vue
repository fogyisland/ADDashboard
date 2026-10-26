<!--
  R158.37 (2026-10-03) - 域和森林注册页 (ForestRegistryView.vue)
  3 tab 页 — 森林 / 域 / 域设置。
    1. 森林 — ad_forest CRUD (forest_name / root_dn / ad_url / bind_dn /
       bind_password 加密, 显示时一律 mask)。is_default 全局唯一。
    2. 域 — ad_forest_domain (子域 / 信任域) +
       ad_forest_dc_assignment (DC 绑定)。顶部森林下拉切换上下文。
    3. 域设置 — ad_forest_setting KV 表 (pwd_min_length /
       sync_interval 等), 按森林划分。

  R158.38.2 (2026-10-03) — 中心端不维护 binding. 这里注册 (forest + domain)
  给后续 DC 注册时引用 (R158.39 把 DC↔domain 绑定移到 AD 域控清单).
  中心 LDAP sync tick 改读 ad_forest.is_default=1 森林 + 遍历其下 domain.

  bind_password wire 一律 mask 为 '********'; 编辑 modal 用占位符
  "留空 = 保留原密码"。service 端用 R158.32 dict.<method>[db.dialect]
  模式 (不要 spread), 避免 SQL 函数引用塌成 {}。

  R158.37.2 rename: operator "运维中的 forest registry 应该是域和森林
  注册" + "功能用中文, 注释用英文" — 页面标题 / tab / 按钮 / modal /
  placeholder 全部中文化, 代码注释保持英文。
-->
<template>
  <AdminLayout>
  <div class="forest-registry-view">
    <header class="fr-head">
      <h2>域和森林注册</h2>
      <p class="hint">AD 森林根域、子域 / 信任域、DC 绑定、域设置的注册表。中心端 LDAP 信息同步默认读 is_default=1 森林 + 遍历其下域 — 注册在这里给后续 DC 引用 (DC 与域的绑定在「AD 域控清单」页设置)。</p>
    </header>

    <nav class="fr-tabs">
      <button v-for="t in tabs" :key="t.key"
              :class="['fr-tab', { active: activeTab === t.key }]"
              @click="activeTab = t.key">
        {{ t.icon }} {{ t.label }}
      </button>
    </nav>

    <!-- Tab 1: 森林 -->
    <section v-show="activeTab === 'forest'" class="fr-panel">
      <div class="fr-actions">
        <button class="primary" @click="openForestCreate">+ 新建森林</button>
        <button @click="loadForests">刷新</button>
      </div>
      <table class="fr-table">
        <thead>
          <tr>
            <th>森林名</th><th>根 DN</th><th>AD 地址</th><th>绑定 DN</th>
            <th>密码</th><th>默认</th><th>描述</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="forests.length === 0"><td colspan="8" class="muted">暂无森林 — 点「新建森林」开始</td></tr>
          <tr v-for="f in forests" :key="f.id">
            <td>{{ f.forestName }}</td>
            <td class="mono">{{ f.rootDn }}</td>
            <td class="mono">{{ f.adUrl }}</td>
            <td class="mono">{{ f.bindDn }}</td>
            <td class="muted">{{ f.bindPassword }}</td>
            <td>
              <span v-if="f.isDefault" class="pill ok">✓ 默认</span>
              <button v-else class="link" @click="onSetDefault(f)">设为默认</button>
            </td>
            <td>{{ f.description || '—' }}</td>
            <td>
              <button class="link" @click="openForestEdit(f)">编辑</button>
              <button class="link danger" @click="onDeleteForest(f)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Tab 2: 域 -->
    <section v-show="activeTab === 'domain'" class="fr-panel">
      <div class="fr-toolbar">
        <label>森林:
          <select v-model="selectedForestId" @change="loadDomains">
            <option v-for="f in forests" :key="f.id" :value="f.id">{{ f.forestName }} ({{ f.rootDn }})</option>
          </select>
        </label>
        <button class="primary" :disabled="!selectedForestId" @click="openDomainCreate">+ 新建子域</button>
        <button :disabled="!selectedForestId" @click="loadDomains">刷新</button>
      </div>
      <table class="fr-table">
        <thead>
          <tr>
            <th>域名</th><th>DN</th><th>角色</th><th>信任方向</th><th>首选 DC</th><th>PDC</th><th>自动同步</th><th>Base DN 覆盖</th><th>同步方式</th><th>密码</th><th>同步账户 (DN)</th><th>LDAP URL 覆盖</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!selectedForestId"><td colspan="13" class="muted">请先选择森林</td></tr>
          <tr v-else-if="domains.length === 0"><td colspan="13" class="muted">该森林暂无域 — 点「新建子域」开始</td></tr>
          <tr v-for="d in domains" :key="d.id">
            <td>{{ d.domainName }} <span v-if="d.role === 'root'" class="pill ok small">森林根域</span></td>
            <td class="mono">{{ d.domainDn }}</td>
            <td>{{ d.roleLabel || d.role }}</td>
            <td>{{ d.trustDirection || '—' }}</td>
            <td>{{ d.dcHostname || '—' }}</td>
            <td>
              <span v-if="d.isPdc" class="pill ok">✓</span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <!-- R158.39 (2026-10-03) — 每域自动同步开关. sync_enabled=0 时
                   cron tick 跳过该域 (但手动触发 DirectorySyncView 多选仍可选). -->
              <label class="toggle">
                <input type="checkbox"
                       :checked="d.syncEnabled"
                       @change="onToggleSyncEnabled(d, $event.target.checked)" />
                <span class="muted small">{{ d.syncEnabled ? '启用' : '禁用' }}</span>
              </label>
            </td>
            <!-- R158.5.4 (2026-10-04) — domain 级 baseDn / syncMode / bindPassword 三件套.
                 存 ad_forest_domain_setting KV, 同步路径 priority: domain > forest. -->
            <td>
              <input class="mono baseline-input"
                     :value="d._baseDnOverride || ''"
                     :placeholder="d.domainDn"
                     :title="d._baseDnOverride ? `覆盖 Base DN: ${d._baseDnOverride}` : `继承 domain_dn: ${d.domainDn}`"
                     :data-test="`base-dn-input-${d.id}`"
                     @change="onSaveBaseDn(d, $event.target.value)" />
            </td>
            <td>
              <select :value="d._syncMode || 'inherit'"
                      :data-test="`sync-mode-select-${d.id}`"
                      @change="onSaveSyncMode(d, $event.target.value)">
                <option value="inherit">继承森林</option>
                <option value="override">覆盖 (同密码+自 baseDn)</option>
                <option value="independent">独立 (自密码+自 baseDn)</option>
              </select>
            </td>
            <td>
              <span :class="['pwd-flag', d._hasDomainPassword ? 'pwd-set' : 'pwd-unset']"
                    :title="d._hasDomainPassword ? '已设置独立密码' : '使用森林密码'"
                    :data-test="`pwd-flag-${d.id}`">
                {{ d._hasDomainPassword ? '🔑 已设' : '森林' }}
              </span>
              <button class="link" :data-test="`pwd-set-btn-${d.id}`" @click="openPwdModal(d)">设置</button>
            </td>
            <!-- R158.44.3 (2026-10-04) — 同步账户 (DN) 列. operator 反馈 "在域注册的
                 界面中没有设置同步的账户, 只有密码". 与 forest.bindDn 对应, 整森林
                 共用一个 bind 账号限制 → 加 domain 级 bind_dn 覆盖 KV.
                 空 = 继承 forest.bindDn. 注意: bindDn 与 bindPassword 必须配对
                 (一个账号对应一个密码), 如果只设 DN 不设密码会用 forest 密码 — 可能
                 登录失败 (不同 DN 用同一密码). UI title 提示这一点. -->
            <td>
              <input class="mono bind-dn-input"
                     :value="d._bindDnOverride || ''"
                     :placeholder="forestBindDn || 'cn=svc,dc=...' "
                     :title="d._bindDnOverride ? `覆盖 bind DN: ${d._bindDnOverride}` : `继承 forest.bindDn: ${forestBindDn || '(空)'}`"
                     :data-test="`bind-dn-input-${d.id}`"
                     @change="onSaveBindDn(d, $event.target.value)" />
              <span v-if="d._bindDnOverride" class="pill ok small" :data-test="`bind-dn-flag-${d.id}`" title="已覆盖">⚙</span>
            </td>
            <!-- R158.44.2 (2026-10-04) — LDAP URL 覆盖列. operator 反馈
                 「绑 DC 但同步依然遵循森林根域 ad_url, 绑的机器没生效」.
                 空 = 继承 forest.ad_url; 留空写回森林值. -->
            <td>
              <input class="mono ldap-url-input"
                     :value="d._ldapUrlOverride || ''"
                     :placeholder="forestAdUrl || 'ldap://host:389'"
                     :title="d._ldapUrlOverride ? `覆盖 LDAP URL: ${d._ldapUrlOverride}` : `继承 forest.adUrl: ${forestAdUrl}`"
                     :data-test="`ldap-url-input-${d.id}`"
                     @change="onSaveLdapUrl(d, $event.target.value)" />
              <span v-if="d._ldapUrlOverride" class="pill ok small" :data-test="`ldap-url-flag-${d.id}`" title="已覆盖">⚙</span>
            </td>
            <td>
              <button class="link" @click="openAssignDc(d)">绑定 DC</button>
              <button class="link" @click="openDomainSettingModal(d)">KV</button>
              <button v-if="d.role !== 'root'" class="link danger" @click="onDeleteDomain(d)">删除</button>
              <span v-else class="muted small">由森林管理</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- ============== 域密码 modal (R158.5.4) ============== -->
      <div v-if="pwdModal.open" class="modal-mask" @click.self="closePwdModal"
           data-test="pwd-modal-mask">
        <div class="modal-box">
          <h3>{{ pwdModal.hasPassword ? '修改本域密码' : '设置本域密码' }}</h3>
          <p class="modal-desc">
            域 <strong>{{ pwdModal.domainName }}</strong> ({{ pwdModal.domainDn }})
          </p>
          <p class="modal-hint muted small">
            留空提交 = 删除本域密码 (恢复读森林). 同步方式若不是「独立」, 改密码不影响同步凭据优先级.
          </p>
          <div class="pwd-form">
            <label class="pwd-label">
              <input v-model="pwdModal.password"
                     type="password"
                     placeholder="新密码 (留空 = 删除)"
                     autocomplete="new-password"
                     data-test="pwd-modal-input" />
            </label>
            <label class="pwd-label">
              <input v-model="pwdModal.confirm"
                     type="password"
                     placeholder="再次输入新密码"
                     autocomplete="new-password" />
            </label>
            <div v-if="pwdModal.error" class="msg-err small">{{ pwdModal.error }}</div>
            <div class="pwd-actions">
              <button @click="closePwdModal" :disabled="pwdModal.saving">取消</button>
              <button class="primary"
                      :disabled="pwdModal.saving || !pwdModal.passwordValid"
                      @click="submitPwdModal"
                      data-test="pwd-modal-submit">
                {{ pwdModal.saving ? '保存中…' : (pwdModal.hasPassword ? '更新密码' : '保存密码') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Tab 3: 域设置 -->
    <section v-show="activeTab === 'setting'" class="fr-panel">
      <div class="fr-toolbar">
        <label>森林:
          <select v-model="selectedForestId" @change="loadSettings">
            <option v-for="f in forests" :key="f.id" :value="f.id">{{ f.forestName }} ({{ f.rootDn }})</option>
          </select>
        </label>
        <button class="primary" :disabled="!selectedForestId" @click="openSettingCreate">+ 新建设置</button>
        <button :disabled="!selectedForestId" @click="loadSettings">刷新</button>
      </div>
      <table class="fr-table">
        <thead>
          <tr><th>键名</th><th>值</th><th>更新时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="!selectedForestId"><td colspan="4" class="muted">请先选择森林</td></tr>
          <tr v-else-if="settings.length === 0"><td colspan="4" class="muted">该森林暂无设置项</td></tr>
          <tr v-for="s in settings" :key="s.id">
            <td class="mono">{{ s.settingKey }}</td>
            <td class="mono">{{ s.settingValue ?? '—' }}</td>
            <td>{{ fmtTs(s.updatedAt) }}</td>
            <td>
              <button class="link" @click="openSettingEdit(s)">编辑</button>
              <button class="link danger" @click="onDeleteSetting(s)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 森林编辑 modal -->
    <div v-if="forestModal.open" class="modal-bg" @click.self="forestModal.open = false">
      <div class="modal">
        <h3>{{ forestModal.mode === 'create' ? '新建森林' : '编辑森林' }}</h3>
        <div class="field"><label>森林名 *</label>
          <input v-model="forestModal.form.forestName" :disabled="forestModal.mode === 'edit'" placeholder="corp.local" />
        </div>
        <div class="field"><label>根 DN *</label>
          <input v-model="forestModal.form.rootDn" placeholder="DC=corp,DC=local" />
        </div>
        <div class="field"><label>AD 地址 *</label>
          <input v-model="forestModal.form.adUrl" placeholder="ldap://corp-dc01.corp.local:389" />
        </div>
        <div class="field"><label>绑定 DN *</label>
          <input v-model="forestModal.form.bindDn" placeholder="CN=svc-dash,OU=Service,DC=corp,DC=local" />
        </div>
        <div class="field"><label>绑定密码 {{ forestModal.mode === 'edit' ? '(留空 = 保留原密码)' : '*' }}</label>
          <input v-model="forestModal.form.bindPassword" type="password" :placeholder="forestModal.mode === 'edit' ? '********' : '明文密码'" autocomplete="new-password" />
        </div>
        <div class="field"><label>描述</label>
          <input v-model="forestModal.form.description" placeholder="主森林 / 测试环境" />
        </div>
        <div class="field"><label>
          <input type="checkbox" v-model="forestModal.form.isDefault" /> 设为默认森林
        </label></div>
        <div class="modal-actions">
          <button @click="forestModal.open = false">取消</button>
          <button class="primary" @click="saveForest">保存</button>
        </div>
      </div>
    </div>

    <!-- 域创建 modal -->
    <div v-if="domainModal.open" class="modal-bg" @click.self="domainModal.open = false">
      <div class="modal">
        <h3>新建子域 / 信任域</h3>
        <div class="field"><label>域名 *</label>
          <input v-model="domainModal.form.domainName" placeholder="eu.corp.local" />
        </div>
        <div class="field"><label>DN *</label>
          <input v-model="domainModal.form.domainDn" placeholder="DC=eu,DC=corp,DC=local" />
        </div>
        <div class="field"><label>角色 *</label>
          <select v-model="domainModal.form.role">
            <option value="child">子域</option>
            <option value="external_trust">外部信任域</option>
          </select>
          <p class="hint small">根域由森林自动产生, 不可新建</p>
        </div>
        <div class="field"><label>信任方向</label>
          <select v-model="domainModal.form.trustDirection">
            <option value="">— 不指定 —</option>
            <option value="bidirectional">双向</option>
            <option value="inbound">单向入站</option>
            <option value="outbound">单向出站</option>
          </select>
        </div>
        <div class="field"><label>首选 DC</label>
          <input v-model="domainModal.form.dcHostname" placeholder="CORPDC01 (可选)" />
        </div>
        <div class="field"><label>
          <input type="checkbox" v-model="domainModal.form.isPdc" /> 是 PDC
        </label></div>
        <div class="modal-actions">
          <button @click="domainModal.open = false">取消</button>
          <button class="primary" @click="saveDomain">保存</button>
        </div>
      </div>
    </div>

    <!-- DC 绑定 modal — R158.37.1 operator 「AD 服务器与域绑定」 -->
    <div v-if="dcModal.open" class="modal-bg" @click.self="dcModal.open = false">
      <div class="modal">
        <h3>绑定 DC 到 {{ dcModal.domainName }}</h3>
        <p class="hint">从 ad_dcs 目录中选择一台 DC 绑定到该域。已分配到其他域的 DC 会标灰禁止选择。</p>
        <div class="field"><label>DC *</label>
          <select v-model="dcModal.dcHostname" :disabled="availableDcs.length === 0">
            <option value="" disabled>— 请选择 DC —</option>
            <option v-for="d in availableDcs" :key="d.hostname" :value="d.hostname"
                    :disabled="d.isAssigned && d.assignedDomainId !== dcModal.domainId">
              {{ formatDcOption(d, dcModal.domainId) }}
            </option>
          </select>
        </div>
        <div class="modal-actions">
          <button @click="dcModal.open = false">取消</button>
          <button class="primary" :disabled="!dcModal.dcHostname" @click="saveDcAssignment">绑定</button>
        </div>
      </div>
    </div>

    <!-- R158.38.3 (2026-10-03) — 域设置 modal. mirror forest setting modal,
         独立 ad_forest_domain_setting 表. 列出当前域的设置项 + 新建/编辑/删除. -->
    <div v-if="domainSettingModal.open" class="modal-bg" @click.self="domainSettingModal.open = false">
      <div class="modal large">
        <h3>域设置 — {{ domainSettingModal.domainName }}</h3>
        <p class="hint">本域的同步设置 (密码最小长度、同步间隔等). 独立表 ad_forest_domain_setting, 与森林设置平行。</p>
        <div class="modal-actions modal-actions-top">
          <button class="primary" @click="openDomainSettingEdit(null)">+ 新建设置项</button>
          <button @click="loadDomainSettings">刷新</button>
          <button @click="domainSettingModal.open = false">关闭</button>
        </div>
        <table class="fr-table compact">
          <thead><tr><th>键名</th><th>值</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-if="domainSettingModal.settings.length === 0"><td colspan="4" class="muted">该域暂无设置项</td></tr>
            <tr v-for="s in domainSettingModal.settings" :key="s.id">
              <td class="mono">{{ s.settingKey }}</td>
              <td class="mono">{{ s.settingValue ?? '—' }}</td>
              <td>{{ fmtTs(s.updatedAt) }}</td>
              <td>
                <button class="link" @click="openDomainSettingEdit(s)">编辑</button>
                <button class="link danger" @click="onDeleteDomainSetting(s)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- 单项编辑子 modal -->
        <div v-if="domainSettingEdit.open" class="modal-bg" @click.self="domainSettingEdit.open = false">
          <div class="modal">
            <h3>{{ domainSettingEdit.mode === 'create' ? '新建设置项' : '编辑设置项' }}</h3>
            <div class="field"><label>键名 *</label>
              <input v-model="domainSettingEdit.form.key" :disabled="domainSettingEdit.mode === 'edit'" placeholder="sync_interval_min" />
            </div>
            <div class="field"><label>值</label>
              <input v-model="domainSettingEdit.form.value" placeholder="60" />
            </div>
            <div class="modal-actions">
              <button @click="domainSettingEdit.open = false">取消</button>
              <button class="primary" @click="saveDomainSetting">保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 设置编辑 modal -->
    <div v-if="settingModal.open" class="modal-bg" @click.self="settingModal.open = false">
      <div class="modal">
        <h3>{{ settingModal.mode === 'create' ? '新建设置' : '编辑设置' }}</h3>
        <div class="field"><label>键名 *</label>
          <input v-model="settingModal.form.key" :disabled="settingModal.mode === 'edit'" placeholder="pwd_min_length" />
        </div>
        <div class="field"><label>值</label>
          <input v-model="settingModal.form.value" placeholder="12" />
        </div>
        <div class="modal-actions">
          <button @click="settingModal.open = false">取消</button>
          <button class="primary" @click="saveSetting">保存</button>
        </div>
      </div>
    </div>

    <!-- R158.38.2 (2026-10-03) — 中心端 binding modal 删除. 不维护 binding 单行表.
         中心 LDAP sync 由 ad_forest.is_default=1 森林驱动, R158.39 把 DC↔domain
         绑定移到 AD 域控清单页. -->

    <div v-if="errorMsg" class="fr-error">{{ errorMsg }}</div>
    <div v-if="infoMsg" class="fr-info">{{ infoMsg }}</div>
  </div>
  </AdminLayout>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { forestRegistryApi } from '../../api/admin.js';

const activeTab = ref('forest');
const tabs = [
  { key: 'forest', icon: '🌲', label: '森林' },
  { key: 'domain', icon: '🏢', label: '域' },
  { key: 'setting', icon: '⚙️', label: '域设置' }
];

const forests = ref([]);
const domains = ref([]);
const settings = ref([]);
const selectedForestId = ref(null);
const availableDcs = ref([]);   // R158.37.1 — ad_dcs 目录 + 是否已分配
const errorMsg = ref('');

// R158.38.2 — centreBinding 删掉. 中心端不维护 binding 单行表. LDAP sync
// 走 is_default=1 森林 (forestRegistry.listForests().find(f => f.isDefault)).

const forestModal = reactive({ open: false, mode: 'create', form: emptyForest() });
const domainModal = reactive({ open: false, form: emptyDomain() });
const dcModal = reactive({ open: false, domainId: null, domainName: '', dcHostname: '' });
const settingModal = reactive({ open: false, mode: 'create', form: { key: '', value: '' } });
// R158.38.3 (2026-10-03) — 域级设置 modal (mirror settingModal).
// domainSettingModal = 当前打开的域 + 其 settings 列表.
// domainSettingEdit = 域 modal 内嵌的子 modal (单条新建/编辑).
const domainSettingModal = reactive({
  open: false, domainId: null, domainName: '', settings: []
});
const domainSettingEdit = reactive({
  open: false, mode: 'create', form: { key: '', value: '' }
});

function emptyForest() {
  return { forestName: '', rootDn: '', adUrl: '', bindDn: '', bindPassword: '', description: '', isDefault: false };
}
function emptyDomain() {
  return { domainName: '', domainDn: '', role: 'child', trustDirection: '', dcHostname: '', isPdc: false };
}

function fmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// R158.37.1 — DC dropdown 行渲染。Vue <option> 不允许嵌套 <span>/<template>,
// 必须拼成单个字符串。已分配到他域 → 灰显禁用 + (已分配到 X / Y) 提示;
// 分配到当前域 → ✓ 当前域; 未分配 → hostname · siteName。
function formatDcOption(d, currentDomainId) {
  const head = d.siteName ? `${d.hostname} · ${d.siteName}` : d.hostname;
  if (d.isAssigned && d.assignedDomainId !== currentDomainId) {
    return `${head} (已分配到 ${d.assignedDomainName} / ${d.assignedForestName})`;
  }
  if (d.isAssigned) return `${head} ✓ 当前域`;
  return head;
}

function setError(e) {
  if (e?.response?.data?.error) errorMsg.value = e.response.data.error;
  else if (e?.message) errorMsg.value = e.message;
  else errorMsg.value = String(e);
}

// R158.5.4 — 轻量操作成功提示 (复用 errorMsg slot 但用 ok 风格, 5s 自动清).
const infoMsg = ref('');
let infoTimer = null;
function setInfo(msg) {
  infoMsg.value = msg;
  if (infoTimer) clearTimeout(infoTimer);
  infoTimer = setTimeout(() => { infoMsg.value = ''; }, 5000);
}

async function loadForests() {
  errorMsg.value = '';
  try {
    const r = await forestRegistryApi.listForests();
    forests.value = r.data.forests || [];
    if (forests.value.length > 0 && !selectedForestId.value) {
      const def = forests.value.find(f => f.isDefault);
      selectedForestId.value = def ? def.id : forests.value[0].id;
    }
  } catch (e) { setError(e); }
}

async function loadDomains() {
  if (!selectedForestId.value) { domains.value = []; return; }
  try {
    const r = await forestRegistryApi.listDomains(selectedForestId.value);
    const list = r.data.domains || [];
    // R158.5.4 — 每个 domain 并发拉它的 setting KV (base_dn / sync_mode /
    // bind_password). 失败默认留空. attach 到 d._baseDnOverride / d._syncMode /
    // d._hasDomainPassword, UI 读取这些 _ 前缀派生字段.
    const enriched = await Promise.all(list.map(async (d) => {
      const out = {
        ...d, _baseDnOverride: '', _syncMode: 'inherit',
        _hasDomainPassword: false, _ldapUrlOverride: '',
        _bindDnOverride: ''
      };
      try {
        const s = await forestRegistryApi.listDomainSettings(d.id);
        const settings = s.data.settings || [];
        for (const kv of settings) {
          if (kv.settingKey === 'base_dn') out._baseDnOverride = kv.settingValue || '';
          else if (kv.settingKey === 'sync_mode') out._syncMode = kv.settingValue || 'inherit';
          else if (kv.settingKey === 'bind_password') out._hasDomainPassword = Boolean(kv.settingValue);
          else if (kv.settingKey === 'ldap_url') out._ldapUrlOverride = kv.settingValue || '';
          else if (kv.settingKey === 'bind_dn') out._bindDnOverride = kv.settingValue || '';
        }
      } catch { /* ignore — keep defaults */ }
      return out;
    }));
    domains.value = enriched;
  } catch (e) { setError(e); }
}

async function loadSettings() {
  if (!selectedForestId.value) { settings.value = []; return; }
  try {
    const r = await forestRegistryApi.listSettings(selectedForestId.value);
    settings.value = r.data.settings || [];
  } catch (e) { setError(e); }
}

// R158.38.2 — loadCentreBinding / openCentreBindingModal / onBindingForestChange /
// saveCentreBinding / onClearCentreBinding 全部删除. 不维护中心 binding.

// ---- forest CRUD ----

function openForestCreate() {
  Object.assign(forestModal, { open: true, mode: 'create', form: emptyForest() });
}
function openForestEdit(f) {
  Object.assign(forestModal, {
    open: true,
    mode: 'edit',
    form: {
      id: f.id,
      forestName: f.forestName,
      rootDn: f.rootDn,
      adUrl: f.adUrl,
      bindDn: f.bindDn,
      bindPassword: '',
      description: f.description || '',
      isDefault: f.isDefault
    }
  });
}
async function saveForest() {
  try {
    if (forestModal.mode === 'create') {
      await forestRegistryApi.createForest(forestModal.form);
    } else {
      const body = { ...forestModal.form };
      if (!body.bindPassword) delete body.bindPassword;
      await forestRegistryApi.updateForest(forestModal.form.id, body);
    }
    forestModal.open = false;
    await loadForests();
  } catch (e) { setError(e); }
}
async function onSetDefault(f) {
  if (!confirm(`将 ${f.forestName} 设为默认森林?`)) return;
  try {
    await forestRegistryApi.setDefaultForest(f.id);
    await loadForests();
  } catch (e) { setError(e); }
}
async function onDeleteForest(f) {
  if (!confirm(`确定删除森林 ${f.forestName}? 所有下属域、DC 绑定、域设置会级联删除。`)) return;
  try {
    await forestRegistryApi.deleteForest(f.id);
    if (selectedForestId.value === f.id) {
      selectedForestId.value = null;
      domains.value = [];
      settings.value = [];
    }
    await loadForests();
  } catch (e) { setError(e); }
}

// ---- domain CRUD ----

function openDomainCreate() {
  Object.assign(domainModal, { open: true, form: emptyDomain() });
}
async function saveDomain() {
  try {
    const body = { ...domainModal.form };
    if (!body.trustDirection) delete body.trustDirection;
    if (!body.dcHostname) delete body.dcHostname;
    await forestRegistryApi.createDomain(selectedForestId.value, body);
    domainModal.open = false;
    await loadDomains();
  } catch (e) { setError(e); }
}
async function onDeleteDomain(d) {
  if (!confirm(`确定删除域 ${d.domainName}? 已绑定的 DC 会级联删除。`)) return;
  try {
    await forestRegistryApi.deleteDomain(d.id);
    await loadDomains();
  } catch (e) { setError(e); }
}

// R158.39 (2026-10-03) — 域自动同步开关 toggle. PATCH 端点 fire-and-forget,
// UI 即时反映 (v-bind:checked) 然后 async confirm.
async function onToggleSyncEnabled(d, newVal) {
  // v-bind:checked 已把 UI 改了; rollback on error
  const prev = d.syncEnabled;
  d.syncEnabled = newVal;
  try {
    await forestRegistryApi.setDomainSyncEnabled(d.id, newVal);
  } catch (e) {
    d.syncEnabled = prev;  // rollback
    setError(e);
  }
}

// R158.5.4 (2026-10-04) — 域级 base_dn 覆盖. 空值 = 删除 KV (fallback 到
// domain_dn). PUT setDomainSetting domainId+key='base_dn' value, 刷新 domains.
async function onSaveBaseDn(d, newVal) {
  const trimmed = String(newVal || '').trim();
  const prev = d._baseDnOverride || '';
  d._baseDnOverride = trimmed;
  try {
    if (!trimmed) {
      await forestRegistryApi.deleteDomainSetting(d.id, 'base_dn');
    } else {
      await forestRegistryApi.setDomainSetting(d.id, 'base_dn', trimmed);
    }
    setInfo(`域 ${d.domainName} Base DN 已${trimmed ? '覆盖' : '恢复默认'}`);
  } catch (e) {
    d._baseDnOverride = prev;
    setError(e);
  }
}

// R158.5.4 — 域级 sync_mode dropdown (inherit/override/independent). 同上
// 走通用 setDomainSetting endpoint.

// R158.44.2 (2026-10-04) — 域级 ldap_url 覆盖. operator 反馈 "绑 DC 但同步依然遵循
// 森林根域 ad_url, 绑的机器没生效". 空 = 继承 forest.adUrl. 端口 + 协议都校验
// (与 syncDirectory preflight 正则一致 ldap(s)?://host:port). 失败回滚.
async function onSaveLdapUrl(d, newVal) {
  const trimmed = String(newVal || '').trim();
  if (trimmed && !/^ldaps?:\/\/[^/]+:\d{2,5}$/.test(trimmed)) {
    setError(`LDAP URL 格式错: '${trimmed}' (期望 ldap://host:389 或 ldaps://host:636)`);
    return;
  }
  const prev = d._ldapUrlOverride || '';
  d._ldapUrlOverride = trimmed;
  try {
    if (!trimmed) {
      await forestRegistryApi.deleteDomainSetting(d.id, 'ldap_url');
      setInfo(`域 ${d.domainName} LDAP URL 已恢复继承 forest.adUrl`);
    } else {
      await forestRegistryApi.setDomainSetting(d.id, 'ldap_url', trimmed);
      setInfo(`域 ${d.domainName} LDAP URL → ${trimmed} (同步会跳过森林 URL)`);
    }
  } catch (e) {
    d._ldapUrlOverride = prev;
    setError(e);
  }
}

// R158.44.3 (2026-10-04) — 域级 bind_dn 覆盖. operator 反馈 "在域注册的界面中没有
// 设置同步的账户, 只有密码". 空 = 继承 forest.bindDn. 简单 trim 校验非空, 不
// 强制 RFC 4514 DN 语法 (ldapts 库在 syncDirectory 内会给出明确错误).
async function onSaveBindDn(d, newVal) {
  const trimmed = String(newVal || '').trim();
  const prev = d._bindDnOverride || '';
  d._bindDnOverride = trimmed;
  try {
    if (!trimmed) {
      await forestRegistryApi.deleteDomainSetting(d.id, 'bind_dn');
      setInfo(`域 ${d.domainName} 同步账户 (DN) 已恢复继承 forest.bindDn`);
    } else {
      await forestRegistryApi.setDomainSetting(d.id, 'bind_dn', trimmed);
      setInfo(`域 ${d.domainName} 同步账户 → ${trimmed} (注意: 若未设独立密码, 会用 forest 密码; 不同 DN 同密码可能 LDAP bind 失败)`);
    }
  } catch (e) {
    d._bindDnOverride = prev;
    setError(e);
  }
}

// 当前选中森林的 adUrl (用于 ldap_url 输入 placeholder / fallback 显示).
const forestAdUrl = computed(() => {
  const f = forests.value.find(x => x.id === selectedForestId.value);
  return f?.adUrl || '';
});

// 当前选中森林的 bindDn (用于 同步账户 (DN) 输入 placeholder / fallback 显示).
const forestBindDn = computed(() => {
  const f = forests.value.find(x => x.id === selectedForestId.value);
  return f?.bindDn || '';
});

async function onSaveSyncMode(d, newVal) {
  const allowed = ['inherit', 'override', 'independent'];
  if (!allowed.includes(newVal)) return;
  const prev = d._syncMode || 'inherit';
  d._syncMode = newVal;
  try {
    await forestRegistryApi.setDomainSetting(d.id, 'sync_mode', newVal);
    setInfo(`域 ${d.domainName} 同步方式 → ${newVal}`);
  } catch (e) {
    d._syncMode = prev;
    setError(e);
  }
}

// R158.5.4 — 域密码 modal state + open/close/submit. 与 DirectorySyncView 同源
// 设计; 这边不调 hasBindPassword 端点 (loadDomains 已经把 _hasDomainPassword
// 拉到了 d 上).
const pwdModal = reactive({
  open: false,
  domainId: 0,
  domainName: '',
  domainDn: '',
  hasPassword: false,
  password: '',
  confirm: '',
  error: '',
  saving: false,
  passwordValid: false
});

function openPwdModal(d) {
  Object.assign(pwdModal, {
    open: true,
    domainId: d.id,
    domainName: d.domainName,
    domainDn: d.domainDn,
    hasPassword: Boolean(d._hasDomainPassword),
    password: '',
    confirm: '',
    error: '',
    saving: false,
    passwordValid: true  // 留空视为合法 (删除)
  });
}

function closePwdModal() {
  if (pwdModal.saving) return;
  Object.assign(pwdModal, { open: false, password: '', confirm: '', error: '' });
}

function updatePwdValid() {
  // 留空 = 删除覆盖 — 直接合法
  if (pwdModal.password === '') {
    pwdModal.passwordValid = true;
    pwdModal.error = '';
    return;
  }
  if (pwdModal.password !== pwdModal.confirm) {
    pwdModal.passwordValid = false;
    pwdModal.error = '两次输入不一致';
    return;
  }
  pwdModal.passwordValid = true;
  pwdModal.error = '';
}

async function submitPwdModal() {
  if (pwdModal.saving || !pwdModal.passwordValid) return;
  pwdModal.saving = true;
  pwdModal.error = '';
  try {
    const r = await forestRegistryApi.setDomainBindPassword(pwdModal.domainId, pwdModal.password);
    const hasPassword = Boolean(r.data?.hasPassword);
    const idx = domains.value.findIndex(x => x.id === pwdModal.domainId);
    if (idx >= 0) domains.value[idx]._hasDomainPassword = hasPassword;
    setInfo(hasPassword
      ? `已为域 ${pwdModal.domainName} 设置独立密码 (覆盖森林)`
      : `已删除域 ${pwdModal.domainName} 密码覆盖, 恢复读森林`);
    closePwdModal();
  } catch (e) {
    pwdModal.error = e?.response?.data?.error || e?.message || '保存失败';
  } finally {
    pwdModal.saving = false;
  }
}

// 监听 pwdModal 字段变化以实时校验.
watch(
  () => [pwdModal.password, pwdModal.confirm],
  () => updatePwdValid()
);

// ---- DC Assign ----

function openAssignDc(d) {
  Object.assign(dcModal, { open: true, domainId: d.id, domainName: d.domainName, dcHostname: '' });
  loadAvailableDcs();
}

async function loadAvailableDcs() {
  try {
    const r = await forestRegistryApi.listAvailableDcs();
    availableDcs.value = r.data?.dcs || [];
  } catch (e) {
    availableDcs.value = [];
    setError(e);
  }
}

async function saveDcAssignment() {
  try {
    await forestRegistryApi.assignDc(dcModal.domainId, {
      dcHostname: dcModal.dcHostname
    });
    dcModal.open = false;
    await loadDomains();
  } catch (e) { setError(e); }
}

// ---- setting ----

function openSettingCreate() {
  Object.assign(settingModal, { open: true, mode: 'create', form: { key: '', value: '' } });
}
function openSettingEdit(s) {
  Object.assign(settingModal, { open: true, mode: 'edit', form: { key: s.settingKey, value: s.settingValue ?? '' } });
}
async function saveSetting() {
  try {
    if (settingModal.mode === 'create') {
      await forestRegistryApi.setSetting(selectedForestId.value, settingModal.form.key, settingModal.form.value);
    } else {
      await forestRegistryApi.setSetting(selectedForestId.value, settingModal.form.key, settingModal.form.value);
    }
    settingModal.open = false;
    await loadSettings();
  } catch (e) { setError(e); }
}
async function onDeleteSetting(s) {
  if (!confirm(`确定删除设置项 ${s.settingKey}?`)) return;
  try {
    await forestRegistryApi.deleteSetting(selectedForestId.value, s.settingKey);
    await loadSettings();
  } catch (e) { setError(e); }
}

// R158.38.3 — 域设置 (独立表 ad_forest_domain_setting, 与森林设置 endpoint
// 完全对称). open 时 loadDomainSettings, 新建/编辑共用 openDomainSettingEdit.
function openDomainSettingModal(d) {
  Object.assign(domainSettingModal, {
    open: true, domainId: d.id, domainName: d.domainName, settings: []
  });
  domainSettingEdit.open = false;
  loadDomainSettings();
}
async function loadDomainSettings() {
  if (!domainSettingModal.domainId) return;
  try {
    const r = await forestRegistryApi.listDomainSettings(domainSettingModal.domainId);
    domainSettingModal.settings = r.data.settings || [];
  } catch (e) { setError(e); }
}
function openDomainSettingEdit(s) {
  if (!s) {
    Object.assign(domainSettingEdit, { open: true, mode: 'create', form: { key: '', value: '' } });
  } else {
    Object.assign(domainSettingEdit, {
      open: true, mode: 'edit',
      form: { id: s.id, key: s.settingKey, value: s.settingValue ?? '' }
    });
  }
}
async function saveDomainSetting() {
  const key = domainSettingEdit.form.key.trim();
  if (!key) { setError(new Error('键名必填')); return; }
  try {
    await forestRegistryApi.setDomainSetting(
      domainSettingModal.domainId, key, domainSettingEdit.form.value
    );
    domainSettingEdit.open = false;
    await loadDomainSettings();
  } catch (e) { setError(e); }
}
async function onDeleteDomainSetting(s) {
  if (!confirm(`确定删除域设置项 ${s.settingKey}?`)) return;
  try {
    await forestRegistryApi.deleteDomainSetting(domainSettingModal.domainId, s.settingKey);
    await loadDomainSettings();
  } catch (e) { setError(e); }
}

onMounted(async () => {
  await loadForests();
  await loadDomains();
  await loadSettings();
});
</script>

<style scoped>
.forest-registry-view {
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fr-head h2 { margin: 0 0 4px; font-size: 18px; }
.fr-head .hint { margin: 0; color: var(--muted); font-size: 12px; }
.fr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.fr-tab {
  background: transparent;
  border: none;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.fr-tab.active { color: var(--text); border-bottom-color: var(--accent, #3b82f6); font-weight: 600; }
.fr-actions, .fr-toolbar { display: flex; gap: 8px; align-items: center; }
.fr-toolbar label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.fr-toolbar select, .modal select {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 13px;
}
.fr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.fr-table.compact th, .fr-table.compact td { padding: 4px 8px; font-size: 12px; }
.fr-table th, .fr-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.fr-table th { color: var(--text-muted); font-weight: 600; background: var(--panel-alt, rgba(255,255,255,0.02)); }
.mono { font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace; font-size: 12px; }
.muted { color: var(--muted); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill.ok { background: rgba(34,197,94,0.14); color: #22c55e; }
.pill.small, .muted.small { font-size: 10px; padding: 0 6px; }
.toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.toggle input { cursor: pointer; }
.link {
  background: transparent;
  border: none;
  color: var(--accent, #3b82f6);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
}
.link:hover { text-decoration: underline; }
.link.danger { color: #ef4444; }
button.primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border: none;
  border-radius: 3px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}
button.primary:disabled { background: var(--muted); cursor: not-allowed; }
button {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
.modal-bg {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--panel, #1e293b);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 18px 20px;
  min-width: 420px;
  max-width: 600px;
  display: flex; flex-direction: column; gap: 10px;
}
.modal.large { min-width: 640px; max-width: 880px; }
.modal-actions-top { margin-top: 0; margin-bottom: 4px; }
.modal h3 { margin: 0 0 4px; font-size: 15px; }
.modal .field { display: flex; flex-direction: column; gap: 3px; }
.modal label { font-size: 12px; color: var(--text-muted); }
.modal input[type="text"], .modal input[type="password"], .modal input:not([type]), .modal select {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 5px 8px;
  font-size: 13px;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.fr-error {
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 13px;
}
.fr-info {
  background: rgba(34, 197, 94, 0.14);
  color: #22c55e;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 13px;
  margin-top: 8px;
}

/* ---- R158.5.4 — 域级 Base DN / sync_mode / 密码 单元格样式 ---- */
.baseline-input {
  width: 100%;
  min-width: 180px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
}
.ldap-url-input {
  width: 100%;
  min-width: 220px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
  font-family: ui-monospace, monospace;
}
.bind-dn-input {
  width: 100%;
  min-width: 240px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
}
.fr-table select {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
}
.pwd-flag {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  margin-right: 4px;
}
.pwd-flag.pwd-set { background: rgba(34, 197, 94, 0.18); color: #22c55e; }
.pwd-flag.pwd-unset { background: rgba(148, 163, 184, 0.14); color: var(--text-muted); }
</style>
