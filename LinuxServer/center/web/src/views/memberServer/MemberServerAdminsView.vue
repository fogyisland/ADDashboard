<template>
  <div class="member-server-admins-view">
    <h2 class="title">管理员组成员</h2>
    <p class="subtitle">
      收集 3 本地组: <code>BUILTIN\Administrators</code> +
      <code>Remote Desktop Users</code> + <code>Power Users</code>. 走
      <code>Get-LocalGroupMember</code> (0 AD RSAT 必装). 每 24 小时采集一次.
    </p>

    <!-- 顶部 3 tile (跟 R158.78 channel 3 1:1 平行 shape) -->
    <div class="tiles">
      <div class="tile" :class="loading ? 'tile-loading' : ''">
        <div class="tile-num">{{ administratorsCount }}</div>
        <div class="tile-label">Administrators</div>
        <div class="tile-foot">BUILTIN</div>
      </div>
      <div class="tile" :class="loading ? 'tile-loading' : ''">
        <div class="tile-num">{{ rdpCount }}</div>
        <div class="tile-label">Remote Desktop Users</div>
        <div class="tile-foot">远程登录</div>
      </div>
      <div class="tile" :class="loading ? 'tile-loading' : ''">
        <div class="tile-num">{{ powerUsersCount }}</div>
        <div class="tile-label">Power Users</div>
        <div class="tile-foot">高级用户</div>
      </div>
    </div>

    <!-- Hostname selector + main table -->
    <div class="section">
      <div class="section-header">
        <label class="hostname-label">主机:</label>
        <select v-model="selectedHostname" class="hostname-select">
          <option value="">— 全部 —</option>
          <option v-for="h in hostnames" :key="h" :value="h">{{ h }}</option>
        </select>
        <button @click="reload" :disabled="loading" class="reload-btn">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
        <span class="hint">最后更新: {{ lastLoadedAt || '—' }}</span>
      </div>

      <MemberAdminGroupsTable :rows="filteredRows" />
    </div>

    <!-- Footer chips (R145/R146/R154 site grouping + status badge) -->
    <div class="footer-chips">
      <span class="chip">包: member_admin_groups 1.0.0</span>
      <span class="chip">agent.type: non-ad</span>
      <span class="chip">cadence: 24h</span>
      <span class="chip">表: ad_member_admin_groups</span>
      <span class="chip" :class="errorChipClass">
        错误: {{ errorCount }}
      </span>
    </div>
  </div>
</template>

<script>
import MemberAdminGroupsTable from '../../components/MemberAdminGroupsTable.vue';
import { memberServerApi } from '../../api/member-server.js';

export default {
  name: 'MemberServerAdminsView',
  components: { MemberAdminGroupsTable },
  data() {
    return {
      loading: false,
      rows: [],
      summary: [],
      selectedHostname: '',
      lastLoadedAt: null,
      errorCount: 0
    };
  },
  computed: {
    hostnames() {
      // R158.99.1 (2026-10-13) - case-insensitive unique hostnames (跟表 1:1 平行)
      const set = new Set();
      for (const r of this.rows) {
        if (r.hostname) set.add(String(r.hostname).toLowerCase());
      }
      return Array.from(set).sort();
    },
    filteredRows() {
      if (!this.selectedHostname) return this.rows;
      const sel = this.selectedHostname.toLowerCase();
      return this.rows.filter(r => String(r.hostname || '').toLowerCase() === sel);
    },
    administratorsCount() {
      return this.rows.filter(r => r.group_name === 'Administrators').length;
    },
    rdpCount() {
      return this.rows.filter(r => r.group_name === 'Remote Desktop Users').length;
    },
    powerUsersCount() {
      return this.rows.filter(r => r.group_name === 'Power Users').length;
    },
    errorChipClass() {
      return this.errorCount > 0 ? 'chip-warn' : 'chip-ok';
    }
  },
  mounted() {
    this.reload();
  },
  methods: {
    async reload() {
      this.loading = true;
      try {
        // R158.100.8 (2026-10-14) — 改走 memberServerApi (axios + 拦截器
        //   自动注入 Bearer), 跟兄弟 view (Overview/Agents/OSBaseline/
        //   Ports/Packages/Eventlog) 100% 平行. 改前裸 fetch + credentials:
        //   'include', 但 userAuth (user-auth.js:54-56) 只读 Authorization
        //   header 不读 cookie → 100% 401 'missing token'.
        // R158.100.8.d (2026-10-17) — frontend shape 消费层闭合 R158.100.8.c
        //   真因. 0 hostname → endpoint 走 getSummary 返 {summary, hint} (sql.js:3572
        //   COUNT(*) 聚合 3 列: hostname / group_name / member_count). 老代码
        //   data.rows || [] 0 兜底 summary → this.rows = [] → 0 显示. 现在按
        //   是否传 hostname 区分消费 shape: 1 hostname → data.rows (flattened
        //   3 group × N member 全列); 0 hostname → 把 data.summary 平展成
        //   rows (3 列: hostname / group_name / member_count), tile 跟表都吃.
        const reqHostname = this.selectedHostname || null;
        const { data } = await memberServerApi.getAdminGroups({
          hostname: reqHostname
        });
        if (reqHostname) {
          this.rows = Array.isArray(data.rows) ? data.rows : [];
          this.summary = [];
        } else {
          // summary = [{hostname, group_name, member_count}] → 平展成 row-shape
          // 喂 MemberAdminGroupsTable (字段: hostname/group_name/member_count
          // /member_sid=null placeholder 由表 fallback /is_enabled=null /
          // display_name=null). 表 v-for 仍走 row.group_name / row.hostname.
          this.rows = (Array.isArray(data.summary) ? data.summary : []).map(r => ({
            hostname:           r.hostname,
            group_name:         r.group_name,
            member_sid:         `summary:${r.hostname}:${r.group_name}`,
            member_name:        null,
            member_class:       null,
            principal_source:   null,
            is_enabled:         null,
            display_name:       `共 ${r.member_count} 个成员`,
            collected_at:       null
          }));
          this.summary = Array.isArray(data.summary) ? data.summary : [];
        }
        this.errorCount = 0;
        this.lastLoadedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      } catch (e) {
        // R158.100.8 — axios 拦截器 (client.js:34-45) 已对 401 做清 token +
        //   push /login, 这里只计 errorCount 供 chip 显示; 不重复弹 toast.
        //   ANONYMOUS_OK_401 白名单只放 system-settings-v2 polling, 这里
        //   是用户主动 reload, 不入白名单 (R158.103 教训).
        this.errorCount++;
        this.rows = [];
      } finally {
        this.loading = false;
      }
    }
  },
  watch: {
    selectedHostname() {
      this.reload();
    }
  }
};
</script>

<style scoped>
.member-server-admins-view { padding: 16px 24px; }
.title { font-size: 18px; margin: 0 0 4px 0; color: #e5e7eb; }
.subtitle { font-size: 12px; color: #6b7280; margin: 0 0 16px 0; }
.subtitle code { color: #4ea1ff; font-size: 11px; }
.tiles { display: flex; gap: 12px; margin-bottom: 16px; }
.tile {
  flex: 1; padding: 12px 16px; background: #1a2235; border-radius: 8px;
  border: 1px solid #2a3346;
}
.tile-loading { opacity: 0.6; }
.tile-num { font-size: 28px; font-weight: 600; color: #4ea1ff; }
.tile-label { font-size: 12px; color: #aab4c5; margin-top: 4px; }
.tile-foot { font-size: 10px; color: #6b7280; margin-top: 2px; }
.section { background: #0f1729; padding: 12px; border-radius: 8px; border: 1px solid #2a3346; }
.section-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.hostname-label { font-size: 12px; color: #aab4c5; }
.hostname-select {
  padding: 4px 8px; background: #1a2235; color: #e5e7eb; border: 1px solid #2a3346;
  border-radius: 4px; font-size: 12px;
}
.reload-btn {
  padding: 4px 12px; background: #1e40af; color: white; border: none;
  border-radius: 4px; cursor: pointer; font-size: 12px;
}
.reload-btn:disabled { background: #374151; cursor: not-allowed; }
.hint { font-size: 11px; color: #6b7280; margin-left: auto; }
.footer-chips { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.chip {
  padding: 3px 8px; background: #1a2235; color: #aab4c5; border-radius: 10px;
  font-size: 11px; border: 1px solid #2a3346;
}
.chip-ok { background: #14532d; color: #86efac; border-color: #166534; }
.chip-warn { background: #7f1d1d; color: #fca5a5; border-color: #991b1b; }
</style>
