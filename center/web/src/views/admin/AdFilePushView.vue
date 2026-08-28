<template>
  <AdminLayout>
    <h2>文件推送功能 (AD 域控)</h2>
    <p class="hint">
      上传文件, 推送到指定 AD 域控的目标目录。
      <small>(R53 placeholder — mock-first per operator; backend + agent wire-up pending)</small>
    </p>

    <div class="actions">
      <button disabled>+ 上传文件</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <div class="empty-block">
      <h3>推送任务列表</h3>
      <p>暂无推送任务 — 后端打通后会显示:
        <code>task_id</code> · 源文件 · 目标 DC · 目标路径 · 状态 · 上传时间</p>
    </div>

    <section class="mock-plan">
      <h3>设计草案 (mock-first)</h3>
      <ul>
        <li>上传: 多文件选择 + SHA-256 校验</li>
        <li>目标: 站点 / DC / 域 全选 — 已注册的 AD DC 列表</li>
        <li>目标路径: 必填, 默认 <code>C:\ProgramData\ADDashboard\distribute\&lt;name&gt;</code></li>
        <li>状态: queued → uploading → success | failed (per-DC)</li>
        <li>Agent 端: 接 <code>/api/agent/file-push</code>, 收到任务后 HTTP GET 拉文件 + 落盘 + 回报</li>
      </ul>
    </section>
  </AdminLayout>
</template>

<script setup>
import AdminLayout from '../../components/AdminLayout.vue';
function load() { /* TODO: fetch push tasks from /api/admin/file-push */ }
</script>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
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