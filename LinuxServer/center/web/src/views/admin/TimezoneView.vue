<template>
  <AdminLayout>
    <div class="head">
      <h2>显示时区设置</h2>
      <span class="ver" v-if="displayTimezone">
        当前显示时区 {{ displayTimezone }} ({{ offsetText }})
      </span>
    </div>

    <p class="hint">
      这里的时区只影响<strong>界面怎么显示时间</strong>，不影响数据库里存什么。数据库里一律存
      UTC（存储契约 <code>{{ storageContract }}</code>），页面再按你选的时区渲染。
      这样就不会再出现「明明是晚上 9 点，界面却显示凌晨 5 点」这种算错 8 小时的情况。
    </p>

    <!-- ★ 服务器时钟证据: 这是 R161.10 现场事故 (审计时间偏 8 小时) 的根因面板。
         操作员一眼能看出「数据库写出来的是不是 UTC」, 不用猜。 -->
    <section class="card">
      <h3>服务器时钟</h3>

      <div v-if="loadError" class="banner bad">
        <strong>读取服务器时钟失败：</strong>{{ loadError }}
      </div>

      <table class="t" v-if="server">
        <tbody>
          <tr>
            <th>数据库方言</th>
            <td>{{ server.dialect === 'mssql' ? 'MSSQL (SQL Server)' : 'MySQL' }}</td>
          </tr>
          <tr>
            <th>应用会话时区</th>
            <td><code>{{ server.sessionTimeZone }}</code></td>
          </tr>
          <tr>
            <th>服务器操作系统时区</th>
            <td><code>{{ server.systemTimeZone }}</code></td>
          </tr>
          <tr>
            <th>会话与 UTC 的偏差</th>
            <td>
              {{ formatOffsetMinutes(server.sessionOffsetMinutes) }}
              <span class="muted">（{{ server.sessionOffsetMinutes }} 分钟）</span>
            </td>
          </tr>
          <tr>
            <th>服务器当前 UTC 时间</th>
            <td><code>{{ server.serverTimeUtc || '—' }}</code></td>
          </tr>
          <tr>
            <th>服务器当前会话时间</th>
            <td><code>{{ server.serverTimeSession || '—' }}</code></td>
          </tr>
          <tr>
            <th>数据库默认值写入的是 UTC 吗</th>
            <td>
              <span class="pill" :class="server.pinnedToUtc ? 'ok' : 'bad'">
                {{ server.pinnedToUtc ? '是（已钉 UTC）' : '否（会偏 ' + formatOffsetMinutes(server.sessionOffsetMinutes) + '）' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="server && !server.pinnedToUtc" class="banner bad">
        <strong>数据库默认值没有钉在 UTC。</strong>
        <code>DEFAULT CURRENT_TIMESTAMP</code> 会按服务器本地时区写入，
        新记录的时间会整体偏差 {{ formatOffsetMinutes(server.sessionOffsetMinutes) }}。
        这种情况必须先修数据库会话时区，改显示时区救不回来 —— 详见运维日志里的「钉 UTC」说明。
      </div>
      <div v-else-if="server" class="banner ok">
        <strong>数据库默认值已钉在 UTC。</strong>
        新写入的时间戳与 UTC 一致，界面只做显示时区换算，不会出现固定偏移。
      </div>

      <div class="actions">
        <button class="reload" :disabled="loading" @click="load">刷新</button>
      </div>
    </section>

    <section class="card">
      <h3>显示时区</h3>

      <div class="grid">
        <label class="field">
          <span class="lbl">
            界面显示时区
            <em class="range">共 {{ supportedCount }} 个可选</em>
          </span>
          <select v-model="selected" :disabled="saving">
            <option v-for="tz in timeZones" :key="tz" :value="tz">
              {{ tz }} ({{ formatOffsetMinutes(offsetMinutesFor(tz)) }})
            </option>
          </select>
          <span class="desc">
            必须选 IANA 时区名（含夏令时规则），不接受 <code>GMT+8</code> 这类固定偏移串。
            保存后立即生效，所有页面按新时区重新渲染，不用刷新浏览器。
          </span>
        </label>
      </div>

      <table class="t" v-if="selected">
        <tbody>
          <tr>
            <th>当前 UTC 时间</th>
            <td><code>{{ nowUtcText }}</code></td>
          </tr>
          <tr>
            <th>当前显示时区时间</th>
            <td><code>{{ nowLocalText }}</code> <span class="muted">（{{ selected }}）</span></td>
          </tr>
          <tr>
            <th>浏览器所在时区</th>
            <td><code>{{ browserTimeZone() }}</code> <span class="muted">（仅供参考，页面不按它渲染）</span></td>
          </tr>
        </tbody>
      </table>

      <div class="actions">
        <button class="save-btn" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中...' : '保存显示时区' }}
        </button>
        <button :disabled="saving || !dirty" @click="reset">撤销修改</button>
      </div>
      <span v-if="msg" class="msg" :class="{ err: isErr }">{{ msg }}</span>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
import { notifyError } from '../../lib/notify.js';
import {
  DEFAULT_DISPLAY_TIMEZONE,
  applyServerTimezone,
  browserTimeZone,
  formatDateTime,
  formatDateTimeUtc,
  formatOffsetMinutes,
  getDisplayTimezone,
  listSupportedTimeZones,
  offsetMinutesFor,
  setDisplayTimezone
} from '../../lib/timezone.js';

const timeZones = listSupportedTimeZones();

const displayTimezone = ref(DEFAULT_DISPLAY_TIMEZONE);
const selected = ref(DEFAULT_DISPLAY_TIMEZONE);
const server = ref(null);
const storageContract = ref('UTC');
const supportedCount = ref(timeZones.length);
const loading = ref(false);
const saving = ref(false);
const msg = ref('');
const isErr = ref(false);
const loadError = ref('');

// 秒级心跳 —— 让"当前 UTC 时间 / 当前显示时区时间"两行保持同步,
// 操作员改完时区能立刻看到两个时间都跟着走。
const nowTick = ref(Date.now());
let timer = null;

const offsetText = computed(() => formatOffsetMinutes(offsetMinutesFor(displayTimezone.value)));
const dirty = computed(() => selected.value !== displayTimezone.value);
const nowUtcText = computed(() => formatDateTimeUtc(new Date(nowTick.value)));
const nowLocalText = computed(() => formatDateTime(new Date(nowTick.value), { timeZone: selected.value }));

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await adminApi.getSystemTimezone();
    displayTimezone.value = data?.displayTimezone || DEFAULT_DISPLAY_TIMEZONE;
    selected.value = displayTimezone.value;
    server.value = data?.server || null;
    storageContract.value = data?.storageContract || 'UTC';
    supportedCount.value = Number(data?.supportedCount) || timeZones.length;
    // 服务端是权威值 —— 拉到之后立刻同步给前端单一真源。
    applyServerTimezone(displayTimezone.value);
  } catch (e) {
    loadError.value = e?.response?.data?.detail || e?.response?.data?.error || e?.message || '未知错误';
    notifyError(`读取时区设置失败: ${loadError.value}`);
  } finally {
    loading.value = false;
  }
}

function reset() {
  selected.value = displayTimezone.value;
  msg.value = '';
  isErr.value = false;
}

async function save() {
  saving.value = true;
  msg.value = '';
  isErr.value = false;
  try {
    const data = await adminApi.updateSystemTimezone(selected.value);
    displayTimezone.value = data?.displayTimezone || selected.value;
    selected.value = displayTimezone.value;
    // 立即在本浏览器生效 (其它浏览器下次刷新时从服务端拉)。
    setDisplayTimezone(displayTimezone.value);
    msg.value = `已保存显示时区 ${displayTimezone.value}（${formatOffsetMinutes(offsetMinutesFor(displayTimezone.value))}）`;
  } catch (e) {
    isErr.value = true;
    msg.value = e?.response?.data?.detail || e?.response?.data?.error || e?.message || '保存失败';
    notifyError(`保存显示时区失败: ${msg.value}`);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  // 进页面时先用本地缓存里的时区渲染 (避免闪烁), 再用服务端权威值覆盖。
  const local = getDisplayTimezone();
  displayTimezone.value = local;
  selected.value = local;
  load();
  timer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  timer = null;
});
</script>

<style scoped>
.head { display: flex; align-items: baseline; gap: 12px; }
.head h2 { margin: 0; }
.ver { color: var(--muted); font-size: 13px; }
.hint { color: var(--muted); font-size: 13px; margin: 8px 0 16px; line-height: 1.6; }
.hint strong { color: var(--text); }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 6px; padding: 16px; margin-bottom: 16px;
}
.card h3 { margin: 0 0 12px; font-size: 14px; }
.banner {
  border-left: 3px solid var(--border);
  padding: 10px 12px; font-size: 13px; margin: 12px 0 0; line-height: 1.6;
}
.banner.ok { border-left-color: #3fb950; }
.banner.bad { border-left-color: #e5534b; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.lbl { font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.range { color: var(--muted); font-style: normal; font-size: 11px; font-weight: 400; }
.desc { color: var(--muted); font-size: 12px; line-height: 1.5; }
select {
  padding: 6px; background: var(--sidebar-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.msg { display: block; margin-top: 10px; color: var(--accent); font-size: 13px; }
.msg.err { color: #e5534b; }

.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; width: 220px; }
.muted { color: var(--muted); }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.pill.ok { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
.pill.bad { background: rgba(229, 83, 75, 0.15); color: #e5534b; }
</style>
