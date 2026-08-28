<template>
  <AdminLayout>
    <h2>成员服务器文件推送</h2>
    <p class="hint">
      上传文件, 推送到指定成员服务器(非 AD 成员)的目标目录。
      <small>(R53 placeholder — mock-first per operator; backend + agent wire-up pending)</small>
    </p>

    <div class="actions">
      <button disabled>+ 上传文件</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <div class="empty-block">
      <h3>推送任务列表</h3>
      <p>暂无推送任务 — 后端打通后会显示:
        <code>task_id</code> · 源文件 · 目标成员服务器 · 目标路径 · 状态 · 上传时间</p>
    </div>

    <section class="mock-plan">
      <h3>设计草案 (mock-first)</h3>
      <ul>
        <li>复用 <router-link to="/admin/ad-file-push">AD 文件推送</router-link> 的后端路径, 加 <code>target_type=server</code></li>
        <li>目标: 成员服务器组 / 单个成员服务器 全选 — 已注册的 member_servers 列表</li>
        <li>目标路径: 默认 <code>C:\ProgramData\ADDashboard\distribute\&lt;name&gt;</code></li>
        <li>Agent 端: 同 AD 文件推送协议</li>
      </ul>
    </section>
  </AdminLayout>
</template>

<script setup>
import AdminLayout from '../../components/AdminLayout.vue';
function load() { /* TODO: fetch push tasks */ }
</script>

<style scoped>
.actions { display: flex; gap: 8px; margin: 12px 0; }
.actions button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.empty-block { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); margin: 12px 0; }
.mock-plan { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); margin: 12px 0; }
.mock-plan ul { padding-left: 20px; }
.mock-plan li { margin: 6px 0; }
.hint { color: var(--muted); }
.hint small { color: var(--muted); font-size: 12px; }
</style>