<template>
  <AdminLayout>
    <h2>成员服务器执行命令</h2>
    <p class="hint">
      上传 PowerShell 命令, 推送到成员服务器执行, 结果回报。
      <small>(R53 placeholder — mock-first per operator; backend + agent wire-up pending)</small>
    </p>

    <div class="actions">
      <button disabled>+ 新建命令</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <div class="empty-block">
      <h3>命令执行历史</h3>
      <p>暂无执行记录 — 后端打通后会显示:
        <code>task_id</code> · 脚本内容 · 目标服务器 · 执行状态 · stdout/stderr · 退出码 · 完成时间</p>
    </div>

    <section class="mock-plan">
      <h3>设计草案 (mock-first)</h3>
      <ul>
        <li>输入: PowerShell 脚本文本 (textarea, 等宽字体) + 目标成员服务器(组 / 单)</li>
        <li>超时: 默认 5 分钟, 可配置上限 30 分钟</li>
        <li>Agent 端: 接 <code>/api/agent/exec</code>, 写临时 ps1 → 执行 → 捕获 stdout/stderr/退出码 → 回报</li>
        <li>权限: agent service 账号必须有本地执行权限(已是 LocalSystem)</li>
        <li>审计: 命令内容 + 执行人 + 时间 → <code>audit_logs</code>(audit-classifier 加 <code>exec_member_command</code>)</li>
        <li>风险: 命令可任意执行 — 必须有审批流或权限分级, 待 operator 拍板</li>
      </ul>
    </section>
  </AdminLayout>
</template>

<script setup>
import AdminLayout from '../../components/AdminLayout.vue';
function load() { /* TODO: fetch exec history */ }
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