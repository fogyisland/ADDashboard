<template>
  <AdminLayout>
    <header class="page-head">
      <h2>邮件 / 告警配置</h2>
      <p class="page-summary">SMTP 发送通道、发件人、收件人与告警评估策略。</p>
    </header>

    <!--
      R158.62 — top-level tabs split the page into "邮件配置" (the
      original 6 sections, R158.61) and "告警" (评估策略 + AlertInboxView
      embed). R158.61+1 (2026-10-10) — daily / weekly reports get their
      OWN tabs (operator directive "邮件的日报和周报放在独立页签"). The
      "报表调度与保留" section (report_loop_interval_seconds +
      report_retention_days) is shared infrastructure — it lives on the
      daily tab because operators editing cron cadence for daily will
      also tune the loop interval + retention at the same time. Weekly
      tab keeps only the weekly-specific keys. We use hand-rolled
      `nav.tabs` (same shape as AuditView.vue line 12) rather than
      <el-tabs> because Element-Plus is not in this project's
      dependency tree. Save bar is shared between all tabs (single
      source of truth, dirty state survives tab switches).
    -->
    <nav class="top-tabs">
      <button :class="['top-tab', { active: topTab === 'mail' }]" @click="topTab = 'mail'">📧 邮件配置</button>
      <button :class="['top-tab', { active: topTab === 'alerts' }]" @click="topTab = 'alerts'">🔔 告警配置与收件箱</button>
      <!-- R158.100.C (2026-10-14) — AD 操作通知 tab (3rd tab, alerts 跟 daily 之间).
           6 kind (user_create / group_create / ou_create / user_password_reset /
           user_enable / user_disable) 共享 1 套 5 config_key. 13 占位符.
           跟 daily / weekly 1:1 平行, 顶部 nav.top-tabs 顺序. -->
      <button :class="['top-tab', { active: topTab === 'adNotify' }]" @click="topTab = 'adNotify'">🛎️ 操作通知</button>
      <button :class="['top-tab', { active: topTab === 'daily' }]" @click="topTab = 'daily'">📅 日报</button>
      <button :class="['top-tab', { active: topTab === 'weekly' }]" @click="topTab = 'weekly'">📊 周报</button>
      <!-- R158.100.B (2026-10-14) — 邮件队列 tab. 跟 history 1:1 平行. 操作员决策
           把 queue 放 history 之前 (R158.100.B+2, 2026-10-14), 队列 = 待处理 / 历史 = 已发,
           顺序"先看未完, 再看已完" 1:1 平行操作员心智. 7th top-level. -->
      <button :class="['top-tab', { active: topTab === 'queue' }]" @click="topTab = 'queue'">📨 邮件队列</button>
      <!-- R158.69 (2026-10-10) — 邮件历史 tab. UNION ALL 查 system_alert_outbox
           + report_email_outbox (operator 决策不建新表). 队列之后的第 8 tab (R158.100.B+2). -->
      <button :class="['top-tab', { active: topTab === 'history' }]" @click="topTab = 'history'">📨 邮件历史</button>
    </nav>

    <!-- Tab 1: 邮件配置 — SMTP 服务 + 发件人 only (R158.61+1 把日报/周报/调度与保留拆出去到独立 tab) -->
    <div v-show="topTab === 'mail'">
    <section v-for="sec in MAIL_SECTIONS" :key="sec.title" class="config-section">
      <header class="section-head">
        <h3>{{ sec.title }}</h3>
        <span v-if="sectionDirtyCounts[sec.title] > 0" class="section-dirty">
          本节 {{ sectionDirtyCounts[sec.title] }} 项未保存
        </span>
      </header>
      <table class="t">
        <tbody>
          <tr v-for="row in sec.rows" :key="row.key">
            <td>
              <div class="key-label">{{ row.label }}</div>
              <code class="raw-key">{{ row.key }}</code>
            </td>
            <td>
              <!--
                smtp_password has its own row (no ConfigFieldRow): the value
                T12-fix1 contract requires the input itself to stay empty while
                the placeholder shows `********` so the operator can type a new
                password to overwrite the existing one.

                R161.11 (2026-10-26) — 外面套一个 <form>:
                Chrome 会对"不在 form 里的 password 框"报
                `[DOM] Password field is not contained in a form`
                (操作员 2026-10-26 在控制台看到)。这不是功能故障, 但会让
                浏览器把该框当"游离密码框" (不参与自动填充/密码管理器),
                也会污染控制台。@submit.prevent 保证按回车不会触发提交/刷新。
                只包这一个 input, 不动其它行 ⇒ 0 改保存语义 (保存走 save bar 按钮)。
              -->
              <template v-if="row.key === 'smtp_password'">
                <form @submit.prevent>
                  <input
                    type="password"
                    :value="''"
                    :placeholder="passwordPlaceholder"
                    autocomplete="new-password"
                    class="has-password-mask"
                    @input="onInput(row.key, $event.target.value)"
                  />
                </form>
              </template>
              <!--
                smtp_secure is a boolean stored as the string 'true'/'false'.
                Inlined because ConfigFieldRow uses @input/$event.target.value,
                which doesn't work for a checkbox.
              -->
              <template v-else-if="row.key === 'smtp_secure'">
                <label class="secure-toggle">
                  <input
                    type="checkbox"
                    :checked="String(current[row.key]) === 'true'"
                    @change="onInput(row.key, $event.target.checked ? 'true' : 'false')"
                  />
                  <span>{{ String(current[row.key]) === 'true' ? '启用' : '关闭' }}</span>
                </label>
              </template>
              <ConfigFieldRow
                v-else
                :value="current[row.key]"
                :type="row.type"
                @update:value="onInput(row.key, $event)"
              />
            </td>
            <td>
              <span class="desc-text">{{ row.description }}</span>
              <div v-if="row.key === 'smtp_from'" class="action-row">
                <button class="token-action" :disabled="testing || !smtpReady" @click="openTestDialog">发送测试邮件</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer v-show="topTab === 'mail'" class="save-bar">
      <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
      <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
      <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
      <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
    </footer>

    <div v-if="showTestDialog" class="modal-bg" @click.self="closeTestDialog">
      <div class="modal">
        <h3>发送测试邮件</h3>
        <div class="row">
          <label>收件人 <span class="req">*</span></label>
          <input v-model="testTo" placeholder="ops@corp.local" />
        </div>
        <div v-if="testError" class="error">{{ testError }}</div>
        <div v-if="testOkMsg" class="ok-msg">{{ testOkMsg }}</div>
        <div class="actions">
          <button @click="closeTestDialog">关闭</button>
          <button class="primary" :disabled="testing || !testTo" @click="sendTest">
            {{ testing ? '发送中...' : '发送' }}
          </button>
        </div>
      </div>
    </div>

    <section v-if="emailAudit.length" class="audit">
      <h3>邮件相关历史变更 (最近 20 条)</h3>
      <table>
        <thead><tr><th>键</th><th>旧值</th><th>新值</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="row in emailAudit" :key="row.id" class="audit-row">
            <td>
              <div class="key-label">{{ labels[row.configKey] || row.configKey }}</div>
              <code class="raw-key">{{ row.configKey }}</code>
            </td>
            <td><code>{{ row.oldValue }}</code></td>
            <td><code>{{ row.newValue }}</code></td>
            <td>{{ row.changedByUsername || row.changedBy || '—' }}</td>
            <td>{{ formatTs(row.changedAt) }}</td>
            <td>
              <button
                v-if="row.changeType !== 'ROLLBACK'"
                class="rollback"
                :disabled="isUnrollbackable(row)"
                :title="rollbackTitle(row)"
                @click="onRollbackClick(row)"
              >{{ isUnrollbackable(row) ? '不可回滚' : '回滚' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
    <ConfirmDialog
      v-if="rollbackTarget"
      title="确认回滚到旧值？"
      :body="`回滚 ${rollbackTarget.configKey} 从 ${rollbackTarget.newValue} 到 ${rollbackTarget.oldValue}`"
      confirm-label="确认回滚"
      :danger="true"
      @confirm="doRollback"
      @cancel="rollbackTarget = null"
    />
    </div>

    <!--
      Tab 2: 系统内置告警 — R158.68. 替代 R158.62/63/67 AlertInboxView
      (3-tab events/outbox/rules 配置驱动) + 评估策略 (4 keys). 新设计:
      5 detector 内置 (heartbeat_offline / replication_failed / port_latency_high /
      disk_low / failed_logon_spike), 阈值由 SystemAlertsView 内部配置 (走
      PUT /api/admin/system-alerts/config, 不再走 useDirtyState 通用 save bar).
      "告警" tab 现在只承载 SystemAlertsView, 不再有 save-bar.
    -->
    <div v-show="topTab === 'alerts'">
      <SystemAlertsView />
    </div>

    <!--
      Tab 3: AD 操作通知 — R158.100.C (2026-10-14) 独立 tab, 在 alerts 跟 daily 之间.
      6 kind 共享 1 套 5 config_key (enabled / to / cc / subject_template /
      body_template). 13 占位符支持. 0 改 alerts / daily / weekly 既有的 4 tab.
    -->
    <div v-show="topTab === 'adNotify'">
      <section v-for="sec in ADNOTIFY_SECTIONS" :key="sec.title" class="config-section">
        <header class="section-head">
          <h3>{{ sec.title }}</h3>
          <span v-if="sectionDirtyCounts[sec.title] > 0" class="section-dirty">
            本节 {{ sectionDirtyCounts[sec.title] }} 项未保存
          </span>
        </header>
        <!-- R158.100.C lesson 1 — 静态占位符 help + password redact 警告.
             防止 operator 误写 {{password}} 模板意图, 渲染永远空. -->
        <details class="placeholder-help">
          <summary>📋 模板占位符 (13 个) 与密码重写说明</summary>
          <!-- v-pre 让整块不解析 Vue 插值, 直接显示 {{xxx}} 字面量 -->
          <div class="placeholder-body" v-pre>
            <p><strong>可用占位符 (5 字段值类型详见服务日志):</strong></p>
            <ul>
              <li><code>{{kind_label}}</code> — 中文操作类型 (创建用户 / 重置密码 / 启用用户 / 禁用用户 / 创建组 / 创建 OU)</li>
              <li><code>{{sam}}</code> — 用户 sam (user_create / password_reset / enable / disable); 组/OU 时为空</li>
              <li><code>{{target}}</code> — 组/OU name (group_create / ou_create); user_* 时为空</li>
              <li><code>{{result}}</code> / <code>{{result_label}}</code> — 英文 / 中文结果 (success 成功 / failed 失败 / timeout 超时)</li>
              <li><code>{{error}}</code> — 失败时 error_message; 成功时为空</li>
              <li><code>{{operator}}</code> — 操作员 display_name (找不到时回退到 username)</li>
              <li><code>{{time}}</code> — ISO 8601 UTC 时间</li>
              <li><code>{{target_dc}}</code> — 目标 DC 名称</li>
              <li><code>{{task_id}}</code> — 关联 ad_admin_commands.task_id</li>
              <li><code>{{duration_ms}}</code> — 执行耗时 (毫秒)</li>
              <li><code>{{has_password}}</code> — 是否涉密码 ("是" / "")</li>
              <li><code>{{password_length}}</code> — 涉密码时返回密码字符数 (非明文, 仅给 operator 模板参考)</li>
            </ul>
            <p class="warn">
              ⚠️ <strong>密码重写 L1 防线</strong>: service 层 (ad-notify.js)
              已 hardcode redact — <code>{{password}}</code> / <code>{{newPassword}}</code> 等
              明文占位符引用永远是空字符串, 模板不应试图写明文密码. 持久化 body_text
              在 ad_notify_outbox 表保留 30 天, 任何 redact 漏洞 = cleartext 留存 30d.
            </p>
          </div>
        </details>
        <table class="t">
          <tbody>
            <tr v-for="row in sec.rows" :key="row.key">
              <td>
                <div class="key-label">{{ row.label }}</div>
                <code class="raw-key">{{ row.key }}</code>
              </td>
              <td>
                <ConfigFieldRow
                  :value="current[row.key]"
                  :type="row.type"
                  @update:value="onInput(row.key, $event)"
                />
              </td>
              <td>
                <span class="desc-text">{{ row.description }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="action-row">
          <button class="token-action" :disabled="notifyPreviewing" @click="onPreviewNotify">
            {{ notifyPreviewing ? '渲染中...' : '预览通知' }}
          </button>
        </div>
        <div v-if="notifyPreview" class="preview-pane">
          <header class="preview-head">主题: <strong>{{ notifyPreview.subject }}</strong></header>
          <pre class="preview-body">{{ notifyPreview.body_text }}</pre>
        </div>
      </section>

      <footer v-show="topTab === 'adNotify'" class="save-bar">
        <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
        <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
        <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
      </footer>
    </div>

    <!--
      Tab 4: 日报 — R158.61+1 (2026-10-10) 独立 tab.
      配置项 (enabled + cron + to + cc) + 报表调度与保留 (loop interval
      + retention) + 立即生成按钮 + 历史表 (kind=daily 过滤).
    -->
    <div v-show="topTab === 'daily'">
      <section v-for="sec in DAILY_SECTIONS" :key="sec.title" class="config-section">
        <header class="section-head">
          <h3>{{ sec.title }}</h3>
          <span v-if="sectionDirtyCounts[sec.title] > 0" class="section-dirty">
            本节 {{ sectionDirtyCounts[sec.title] }} 项未保存
          </span>
        </header>
        <table class="t">
          <tbody>
            <tr v-for="row in sec.rows" :key="row.key">
              <td>
                <div class="key-label">{{ row.label }}</div>
                <code class="raw-key">{{ row.key }}</code>
              </td>
              <td>
                <!-- daily/weekly enabled 跟 smtp_secure 同形, 但极性翻转 (默认 '0' = off) -->
                <template v-if="row.key === 'report_daily_enabled'">
                  <label class="secure-toggle">
                    <input
                      type="checkbox"
                      :checked="String(current[row.key]) === '1'"
                      @change="onInput(row.key, $event.target.checked ? '1' : '0')"
                    />
                    <span>{{ String(current[row.key]) === '1' ? '已启用' : '未启用' }}</span>
                  </label>
                </template>
                <ConfigFieldRow
                  v-else
                  :value="current[row.key]"
                  :type="row.type"
                  @update:value="onInput(row.key, $event)"
                />
              </td>
              <td><span class="desc-text">{{ row.description }}</span></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="config-section report-actions">
        <header class="section-head">
          <h3>立即生成</h3>
          <span v-if="reportRunMsg" class="section-dirty">{{ reportRunMsg }}</span>
        </header>
        <div class="report-action-row">
          <button class="token-action" :disabled="reportRunning" @click="onRunNow('daily')">立即生成日报</button>
          <button class="preview-link" :disabled="previewing" @click="onPreview('daily')">预览日报</button>
        </div>
      </section>

      <section v-if="dailyHistory.length" class="audit">
        <h3>日报历史 (最近 20 条)</h3>
        <table>
          <thead><tr><th>主题</th><th>收件人</th><th>生成时间</th><th>状态</th><th>大小</th></tr></thead>
          <tbody>
            <tr v-for="row in dailyHistory" :key="row.id" class="audit-row">
              <td><code>{{ row.subject }}</code></td>
              <td>{{ row.to_addrs || '—' }}</td>
              <td>{{ formatTs(row.generated_at) }}</td>
              <td>
                <span :class="['status-pill', `status-${row.status || 'pending'}`]">{{ row.status || 'pending' }}</span>
                <span v-if="row.last_error" class="err-inline" :title="row.last_error">⚠</span>
              </td>
              <td>{{ row.html_size ? `${Math.round(row.html_size / 1024)} KB` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer v-show="topTab === 'daily'" class="save-bar">
        <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
        <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
        <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
      </footer>
    </div>

    <!--
      Tab 5: 周报 — 同日报 tab 结构, historyKind='weekly'. (R158.100.B+2 后改 Tab 5, queue 排 Tab 6)
    -->
    <div v-show="topTab === 'weekly'">
      <section v-for="sec in WEEKLY_SECTIONS" :key="sec.title" class="config-section">
        <header class="section-head">
          <h3>{{ sec.title }}</h3>
          <span v-if="sectionDirtyCounts[sec.title] > 0" class="section-dirty">
            本节 {{ sectionDirtyCounts[sec.title] }} 项未保存
          </span>
        </header>
        <table class="t">
          <tbody>
            <tr v-for="row in sec.rows" :key="row.key">
              <td>
                <div class="key-label">{{ row.label }}</div>
                <code class="raw-key">{{ row.key }}</code>
              </td>
              <td>
                <template v-if="row.key === 'report_weekly_enabled'">
                  <label class="secure-toggle">
                    <input
                      type="checkbox"
                      :checked="String(current[row.key]) === '1'"
                      @change="onInput(row.key, $event.target.checked ? '1' : '0')"
                    />
                    <span>{{ String(current[row.key]) === '1' ? '已启用' : '未启用' }}</span>
                  </label>
                </template>
                <ConfigFieldRow
                  v-else
                  :value="current[row.key]"
                  :type="row.type"
                  @update:value="onInput(row.key, $event)"
                />
              </td>
              <td><span class="desc-text">{{ row.description }}</span></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="config-section report-actions">
        <header class="section-head">
          <h3>立即生成</h3>
          <span v-if="reportRunMsg" class="section-dirty">{{ reportRunMsg }}</span>
        </header>
        <div class="report-action-row">
          <button class="token-action" :disabled="reportRunning" @click="onRunNow('weekly')">立即生成周报</button>
          <button class="preview-link" :disabled="previewing" @click="onPreview('weekly')">预览周报</button>
        </div>
      </section>

      <section v-if="weeklyHistory.length" class="audit">
        <h3>周报历史 (最近 20 条)</h3>
        <table>
          <thead><tr><th>主题</th><th>收件人</th><th>生成时间</th><th>状态</th><th>大小</th></tr></thead>
          <tbody>
            <tr v-for="row in weeklyHistory" :key="row.id" class="audit-row">
              <td><code>{{ row.subject }}</code></td>
              <td>{{ row.to_addrs || '—' }}</td>
              <td>{{ formatTs(row.generated_at) }}</td>
              <td>
                <span :class="['status-pill', `status-${row.status || 'pending'}`]">{{ row.status || 'pending' }}</span>
                <span v-if="row.last_error" class="err-inline" :title="row.last_error">⚠</span>
              </td>
              <td>{{ row.html_size ? `${Math.round(row.html_size / 1024)} KB` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer v-show="topTab === 'weekly'" class="save-bar">
        <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
        <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
        <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
      </footer>
    </div>

    <!--
      Tab 7: 邮件历史 — R158.69 (2026-10-10). UNION ALL 查 system_alert_outbox +
      report_email_outbox 两张物理表 (operator 决策不建新表). 默认 30 天, 客户端
      partition 用 source / kind_detail. 自动刷新 onMounted + watch 联动下拉.
      新 div 不动其他 4 tab 内容 (operator "不要改已 ship 前端" 准则 + 本任务显式
      覆盖: "在 EmailConfig 增加一个页签").
    -->
    <div v-show="topTab === 'history'">
      <section class="config-section">
        <header class="section-head">
          <h3>邮件历史 (跨内置告警 + 报表)</h3>
          <span v-if="emailHistoryMsg" class="section-dirty">{{ emailHistoryMsg }}</span>
        </header>
        <div class="report-action-row">
          <label>范围:
            <select v-model.number="historyDays">
              <option :value="1">24 小时</option>
              <option :value="7">7 天</option>
              <option :value="30">30 天</option>
              <option :value="90">90 天</option>
            </select>
          </label>
          <label>类型:
            <select v-model="historyKind">
              <option value="all">全部</option>
              <option value="alert">内置告警</option>
              <option value="report">报表</option>
            </select>
          </label>
          <button class="token-action" :disabled="emailHistoryLoading" @click="loadEmailHistory">
            {{ emailHistoryLoading ? '加载中...' : '刷新' }}
          </button>
        </div>
        <!-- R161.11 (2026-10-26) — 降级横幅: 服务端判定 outbox 表/列缺失
             (数据库基线未完整应用) 时返回 200 + degraded。这不是"没有历史邮件",
             而是"查不了" ⇒ 必须显眼, 并给出下一步 (看诊断端点)。 -->
        <div v-if="historyDegraded" class="degraded-banner">
          <strong>{{ emailHistoryMsg }}</strong>
          <span class="degraded-hint">
            数据库基线未完整应用, 邮件历史表缺失。诊断:
            <code>GET /api/admin/system-settings-v2/email-outbox-diagnostics</code>
            (管理员)
          </span>
        </div>
      </section>

      <section v-if="emailHistory.length" class="audit">
        <h3>已发送邮件 ({{ emailHistory.length }} 条)</h3>
        <table class="email-history-table">
          <thead>
            <tr>
              <th>发送时间</th>
              <th>类型</th>
              <th>主题</th>
              <th>收件人</th>
              <th>尝试</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in emailHistory" :key="row.source + '-' + row.id"
                class="audit-row email-history-row"
                :data-test="`email-history-row-${row.source}-${row.id}`"
                @click="openDetail(row)">
              <td>{{ formatTs(row.sent_at) }}</td>
              <td>
                <span v-if="row.source === 'alert'" class="kind-pill kind-alert">告警</span>
                <span v-else-if="row.kind_detail === 'daily'" class="kind-pill kind-daily">日报</span>
                <span v-else class="kind-pill kind-weekly">周报</span>
              </td>
              <td><code>{{ row.subject }}</code></td>
              <td>{{ row.to_addrs || '—' }}</td>
              <td>{{ row.attempt_count }}/{{ row.max_attempts }}</td>
              <td>
                <code v-if="row.last_error" :title="row.last_error" class="err">{{ row.last_error }}</code>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- R158.100.A (2026-10-14) — 邮件历史行 click → 详情 drawer.
             沿用 AuditView 的 aside.drawer @click.self 范式 (无 Element Plus).
             列表行字段不全 (body_html 不在 list 接口返, 性能保护 200 行 80KB × 200 = 16MB),
             点行触发 detail endpoint 拿完整字段. -->
        <aside v-if="detailRow" class="email-history-drawer" @click.self="closeDetail">
          <div class="email-history-drawer-body">
            <header>
              <h3>
                <span :class="['kind-pill', detailRow.source === 'alert' ? 'kind-alert' : (detailRow.kind_detail === 'daily' ? 'kind-daily' : 'kind-weekly')]">
                  {{ detailRow.source === 'alert' ? '告警' : (detailRow.kind_detail === 'daily' ? '日报' : '周报') }}
                </span>
                邮件发送日志 <small>#{{ detailRow.id }}</small>
              </h3>
              <button class="close" @click="closeDetail" aria-label="关闭">×</button>
            </header>

            <div v-if="detailLoading" class="empty">加载中...</div>
            <div v-else-if="detailError" class="error">{{ detailError }}</div>
            <template v-else>
              <dl class="kv">
                <dt>主题</dt>      <dd><code>{{ detailRow.subject }}</code></dd>
                <dt>收件人</dt>    <dd>{{ detailRow.to_addrs || '—' }}</dd>
                <template v-if="detailRow.cc_addrs">
                  <dt>抄送</dt>    <dd><code>{{ detailRow.cc_addrs }}</code></dd>
                </template>
                <dt>尝试</dt>      <dd>{{ detailRow.attempt_count }} / {{ detailRow.max_attempts }}</dd>
                <dt>关联 ID</dt>   <dd><code>{{ detailRow.source === 'alert' ? 'alert_id' : 'report_id' }} = {{ detailRow.ref_id }}</code></dd>
                <dt>发送时间</dt>  <dd>{{ formatTs(detailRow.sent_at) }}</dd>
                <template v-if="detailRow.next_attempt_at">
                  <dt>下次重试</dt>  <dd>{{ formatTs(detailRow.next_attempt_at) }}</dd>
                </template>
                <template v-if="detailRow.created_at">
                  <dt>入队时间</dt>  <dd>{{ formatTs(detailRow.created_at) }}</dd>
                </template>
              </dl>

              <h4>错误日志</h4>
              <pre v-if="detailRow.last_error" class="error-pre">{{ detailRow.last_error }}</pre>
              <p v-else class="muted">无 (发送成功)</p>

              <h4>邮件原文 (HTML 预览 · sandbox 隔离)</h4>
              <iframe sandbox="" class="email-html-frame" :srcdoc="detailRow.body_html || ''"></iframe>
            </template>
          </div>
        </aside>
      </section>
      <section v-else-if="emailHistoryLoaded && !emailHistoryLoading" class="audit">
        <h3>已发送邮件</h3>
        <div class="empty">尚无已发送邮件记录。{{ historyDays === 30 ? '默认查询 30 天。' : '' }}</div>
      </section>
    </div>

    <!-- R158.100.B (2026-10-14) — 邮件队列 (7th top-level tab). 跟 history
         1:1 平行: 同 v-show 范式, 同 inline banner feedback, 同 drawer 复用.
         显示 2 类未发出行: 待发送 (att<5) + 已失败 (att>=5). 行内 3 操作:
         点行 → 复用 openDetail 既有 drawer / [重发] / [放弃]. status 字段
         前端 derive (后端只返真相 att+max, 跟 history filter precedent 1:1).
         0 改 history 既有 6 tab / 0 改 drawer 既有 / 0 改 openDetail 既有. -->
    <div v-show="topTab === 'queue'">
      <section class="config-section">
        <header class="section-head">
          <h3>邮件队列 (跨内置告警 + 报表, 未发送行)</h3>
          <span v-if="queueMsg" class="section-dirty">{{ queueMsg }}</span>
        </header>
        <div class="report-action-row">
          <span class="muted">待发送 = 下次 tick 重试 / 已失败 = 不会重试, 仅可放弃</span>
          <button class="token-action" :disabled="queueLoading" @click="loadEmailQueue">
            {{ queueLoading ? '加载中...' : '刷新' }}
          </button>
        </div>
        <!-- R161.11 (2026-10-26) — 降级横幅 (跟 history 1:1 平行)。 -->
        <div v-if="queueDegraded" class="degraded-banner">
          <strong>{{ queueMsg }}</strong>
          <span class="degraded-hint">
            数据库基线未完整应用, 邮件队列表缺失 —— 邮件**不会**被投递。诊断:
            <code>GET /api/admin/system-settings-v2/email-outbox-diagnostics</code>
            (管理员)
          </span>
        </div>
      </section>

      <section v-if="emailQueue.length" class="audit">
        <h3>队列 ({{ emailQueue.length }} 条)</h3>
        <table class="email-queue-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>类型</th>
              <th>主题</th>
              <th>收件人</th>
              <th>尝试</th>
              <th>下次重试</th>
              <th>错误</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in emailQueue" :key="row.source + '-' + row.id"
                class="audit-row email-queue-row"
                :class="row.status === 'exhausted' ? 'email-queue-row-exhausted' : ''"
                :data-test="`email-queue-row-${row.source}-${row.id}`"
                @click="openDetail(row)">
              <td>
                <span :class="['kind-pill', row.status === 'exhausted' ? 'kind-alert' : 'kind-daily']">
                  {{ row.status === 'exhausted' ? '已失败' : '待发送' }}
                </span>
              </td>
              <td>
                <span v-if="row.source === 'alert'" class="kind-pill kind-alert">告警</span>
                <span v-else-if="row.kind_detail === 'daily'" class="kind-pill kind-daily">日报</span>
                <span v-else class="kind-pill kind-weekly">周报</span>
              </td>
              <td><code>{{ row.subject }}</code></td>
              <td>{{ row.to_addrs || '—' }}</td>
              <td>{{ row.attempt_count }}/{{ row.max_attempts }}</td>
              <td>
                <code v-if="row.status === 'pending'">{{ formatTs(row.next_attempt_at) }}</code>
                <span v-else>—</span>
              </td>
              <td>
                <code v-if="row.last_error" :title="row.last_error" class="err">{{ (row.last_error || '').slice(0, 60) }}</code>
                <span v-else>—</span>
              </td>
              <!-- 阻止操作列点击冒泡到 tr (避免触发 openDetail) -->
              <td @click.stop>
                <button v-if="row.status === 'pending'" class="token-action" @click="retryQueueRow(row)">重发</button>
                <button v-if="row.status === 'exhausted'" class="token-action" @click="deleteQueueRow(row)">放弃</button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- R158.100.B — 复用 R158.100.A drawer. queue 行点行也走 openDetail
             (source='alert'|'report' 跟 history 同形, 后端 detail endpoint
             同样接受). 0 改 drawer 既有 template, 仅 reuse. -->
        <aside v-if="detailRow" class="email-history-drawer" @click.self="closeDetail">
          <div class="email-history-drawer-body">
            <header>
              <h3>
                <span :class="['kind-pill', detailRow.source === 'alert' ? 'kind-alert' : (detailRow.kind_detail === 'daily' ? 'kind-daily' : 'kind-weekly')]">
                  {{ detailRow.source === 'alert' ? '告警' : (detailRow.kind_detail === 'daily' ? '日报' : '周报') }}
                </span>
                邮件发送日志 <small>#{{ detailRow.id }}</small>
              </h3>
              <button class="close" @click="closeDetail" aria-label="关闭">×</button>
            </header>

            <div v-if="detailLoading" class="empty">加载中...</div>
            <div v-else-if="detailError" class="error">{{ detailError }}</div>
            <template v-else>
              <dl class="kv">
                <dt>主题</dt>      <dd><code>{{ detailRow.subject }}</code></dd>
                <dt>收件人</dt>    <dd>{{ detailRow.to_addrs || '—' }}</dd>
                <template v-if="detailRow.cc_addrs">
                  <dt>抄送</dt>    <dd><code>{{ detailRow.cc_addrs }}</code></dd>
                </template>
                <dt>尝试</dt>      <dd>{{ detailRow.attempt_count }} / {{ detailRow.max_attempts }}</dd>
                <dt>关联 ID</dt>   <dd><code>{{ detailRow.source === 'alert' ? 'alert_id' : 'report_id' }} = {{ detailRow.ref_id }}</code></dd>
                <dt>下次重试</dt>  <dd>{{ formatTs(detailRow.next_attempt_at) }}</dd>
                <template v-if="detailRow.created_at">
                  <dt>入队时间</dt>  <dd>{{ formatTs(detailRow.created_at) }}</dd>
                </template>
              </dl>

              <h4>错误日志</h4>
              <pre v-if="detailRow.last_error" class="error-pre">{{ detailRow.last_error }}</pre>
              <p v-else class="muted">无</p>

              <h4>邮件原文 (HTML 预览 · sandbox 隔离)</h4>
              <iframe sandbox="" class="email-html-frame" :srcdoc="detailRow.body_html || ''"></iframe>
            </template>
          </div>
        </aside>
      </section>

      <section v-else-if="emailQueueLoaded && !queueLoading" class="audit">
        <h3>邮件队列</h3>
        <div class="empty">队列为空, 全部邮件已发送成功或尚无入队记录。</div>
      </section>
    </div>

    <!-- R158.68 — 删 RuleEditorDialog (老 alert 4 tab 的 "编辑" 按钮已无). -->
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
// R158.X.116.l (2026-10-23) — 深链定位 tab。InAppDrawer 的「查看全部」
//   跳 `/admin/email-config?tab=alerts` (旧代码指向根本不存在的
//   /admin/system-alerts → 404, 见 InAppDrawer.vue:149 注释)。
//   topTab 默认 'mail', 不认 query 的话"查看全部"会落到邮件配置页 ——
//   链接不 404 了但还是看不到告警, 属于换一种方式坏。
import { useRoute } from 'vue-router';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfigFieldRow from './ConfigFieldRow.vue';
import ConfirmDialog from './ConfirmDialog.vue';
// R158.68 — 删 AlertInboxView + RuleEditorDialog (老 alert 4 tab + 编辑对话框全废).
// 替换为 SystemAlertsView (内置告警, 3 tab: 当前/历史/阈值配置).
import SystemAlertsView from './SystemAlertsView.vue';
import { adminApi } from '../../api/admin.js';
import { useDirtyState } from '../../composables/useDirtyState.js';
import { formatDateTime } from '../../lib/timezone.js';

const EMAIL_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  // R158.68 — 删 5 个 alert_* key (alert_default_to/cc, alert_eval_interval_seconds,
  //   alert_email_max_attempts, alert_email_initial_backoff_seconds). 新 system_alert_*
  //   阈值由 SystemAlertsView 内部 PUT /api/admin/system-alerts/config, 不再走 EMAIL_KEYS.
  // R158.61 (2026-10-10) — daily / weekly email report scheduler.
  'report_daily_enabled', 'report_daily_cron', 'report_daily_to', 'report_daily_cc',
  'report_weekly_enabled', 'report_weekly_cron', 'report_weekly_to', 'report_weekly_cc',
  'report_loop_interval_seconds', 'report_retention_days',
  // R158.100.C (2026-10-14) — AD 操作通知 (success / failed / timeout)
  //   5 key 共享 6 kind. 0 改既有 EMAIL_KEYS 顺序, 5 key 加在末尾. 0
  //   改 adminApi.getConfig() / updateConfig() — 既有 PATCH 走全量
  //   替换 (emailConfig precedent).
  'ad_notify_enabled', 'ad_notify_to', 'ad_notify_cc',
  'ad_notify_subject_template', 'ad_notify_body_template'
];

// R158.68 (2026-10-10) — top-level tab switch. 4 tab 保留: 邮件配置 / 告警(内置) / 日报 / 周报.
// "告警" tab 改承载 SystemAlertsView (内置告警, 阈值配置在内部, 不走 useDirtyState).
// 删 ALERT_POLICY_ROWS (5 老 keys) + onEditRuleFromInbox handler (无 RuleEditorDialog 了).
// R158.X.116.l (2026-10-23) — `?tab=` 深链白名单。合法值必须跟模板里 7 个
//   v-show 的 key 一一对应 (mail / alerts / adNotify / daily / weekly /
//   queue / history)。**白名单是必需的**: topTab 只驱动 v-show, 没有
//   fallback —— 若 query 带个不存在的值, 7 个 div 全部 v-show=false,
//   整页只剩一条空 tab bar, 比 404 更难查。
const TOP_TABS = ['mail', 'alerts', 'adNotify', 'daily', 'weekly', 'queue', 'history'];
const route = useRoute();
const topTab = ref(TOP_TABS.includes(route.query.tab) ? route.query.tab : 'mail');

const SECTIONS = [
  {
    title: 'SMTP 服务',
    rows: [
      { key: 'smtp_host',     label: 'SMTP 主机',  description: 'SMTP 服务器主机名或 IP,空表示未配置邮件告警。',         type: 'text' },
      { key: 'smtp_port',     label: 'SMTP 端口',  description: 'SMTP 端口,常用 25 / 465 / 587。',                        type: 'number' },
      { key: 'smtp_secure',   label: 'SSL/TLS',    description: '是否使用 SSL/TLS (SMTPS),取决于服务器要求。',          type: 'text' },
      { key: 'smtp_user',     label: 'SMTP 用户名',description: 'SMTP 鉴权用户名,部分服务器可留空。',                    type: 'text' },
      { key: 'smtp_password', label: 'SMTP 密码',  description: 'SMTP 鉴权密码,保存后再次读取显示 `********`。',        type: 'text' },
    ]
  },
  {
    title: '发件人',
    rows: [
      { key: 'smtp_from', label: '发件人地址', description: '告警邮件发件人地址,需被 SMTP 服务器允许。', type: 'text' },
    ]
  },
];

// R158.61+1 (2026-10-10) — daily / weekly 拆 3 组 sections, 每组
// 独立 tab render. MAIL_SECTIONS = 邮件 tab 2 节; DAILY_SECTIONS =
// 日报 tab 2 节 (含 报表调度与保留); WEEKLY_SECTIONS = 周报 tab 1
// 节. ALL_SECTIONS = sectionDirtyCounts 聚合 5 节.
const MAIL_SECTIONS = SECTIONS;

const DAILY_SECTIONS = [
  // R158.61 — daily report section. enabled flag, cron
  // expression (5-field, CST), to/cc. "立即生成" button is in its
  // own section below the table so the operator can fire a report
  // without touching the cron.
  {
    title: '日报 (Daily Report)',
    rows: [
      { key: 'report_daily_enabled', label: '启用',     description: '启用后,中心按下方 cron 表达式生成日报并发送邮件。',  type: 'text' },
      { key: 'report_daily_cron',    label: 'Cron 表达式', description: '5 字段 cron, 按 CST 解析。默认 0 9 * * * (每日 09:00 CST)。', type: 'text' },
      { key: 'report_daily_to',      label: '收件人',   description: '日报收件人 (逗号分隔)。空则回退到 alert_default_to。',  type: 'text' },
      { key: 'report_daily_cc',      label: '抄送',     description: '日报抄送 (逗号分隔)。',                       type: 'text' },
    ]
  },
  // R158.61 — scheduler/retention knobs. One row each; cadence in seconds
  // matches the alert/email loops. Lives on the daily tab because
  // operators editing daily cron will also tune the loop interval +
  // retention at the same time. Weekly tab keeps only the weekly-
  // specific keys (loop/retention are shared infrastructure).
  {
    title: '报表调度与保留',
    rows: [
      { key: 'report_loop_interval_seconds', label: '调度器循环间隔', description: '报表调度器检查 cron 的间隔 (秒),默认 300 (5min)。', type: 'number' },
      { key: 'report_retention_days',        label: '历史保留天数',   description: '日报/周报历史表保留天数,默认 30,0 表示不清理。',     type: 'number' },
    ]
  },
];

const WEEKLY_SECTIONS = [
  // R158.61 — weekly report section. Same shape as daily; default cron
  // 0 9 * * MON = Mon 09:00 CST. Loop interval + retention are on
  // the daily tab (shared infrastructure).
  {
    title: '周报 (Weekly Report)',
    rows: [
      { key: 'report_weekly_enabled', label: '启用',     description: '启用后,中心按下方 cron 表达式生成周报并发送邮件。',  type: 'text' },
      { key: 'report_weekly_cron',    label: 'Cron 表达式', description: '5 字段 cron, 按 CST 解析。默认 0 9 * * MON (周一 09:00 CST)。', type: 'text' },
      { key: 'report_weekly_to',      label: '收件人',   description: '周报收件人 (逗号分隔)。空则回退到 alert_default_to。',  type: 'text' },
      { key: 'report_weekly_cc',      label: '抄送',     description: '周报抄送 (逗号分隔)。',                       type: 'text' },
    ]
  },
];

// R158.100.C (2026-10-14) — AD 操作通知 1 section, 5 row.
//   6 kind (user_create / group_create / ou_create / user_password_reset /
//   user_enable / user_disable) 共享 1 套. 13 占位符. subject_template
//   跟 body_template 走 textarea (ConfigFieldRow 加 textarea 分支), 3 个
//   文本框走 text. password 相关警告在 section header 静态文字 (不存到
//   description 字段, 跟 daily 1:1 平行.
const ADNOTIFY_SECTIONS = [
  {
    title: 'AD 操作通知 (用户/组/OU 创建 + 密码重置 + 用户启用/禁用)',
    rows: [
      { key: 'ad_notify_enabled',         label: '启用',       description: '启用后,6 类 AD 操作 (成功/失败/超时) 都会发送通知邮件。',  type: 'toggle' },
      { key: 'ad_notify_to',              label: '收件人',     description: '收件人邮箱 (逗号分隔)。空则跳过 (跟 alert_default_to 1:1)。',  type: 'text' },
      { key: 'ad_notify_cc',              label: '抄送',       description: '抄送邮箱 (逗号分隔)。',  type: 'text' },
      { key: 'ad_notify_subject_template',label: '主题模板',   description: '支持 {{result_label}} {{sam}} {{target}} {{target_dc}} 等 13 占位符。',  type: 'textarea' },
      { key: 'ad_notify_body_template',   label: '正文模板',   description: '正文模板, 同样支持 13 占位符。⚠️ 引用 {{password}} 永远是空, 模板不应写出明文密码意图。',  type: 'textarea' },
    ]
  },
];

// R158.61+1 — sectionDirtyCounts 跨 5 tab 聚合 7 sections
// (mail×2 + adNotify×1 + daily×2 + weekly×1 + queue + history 自管理),
// 单一 source of truth. R158.100.C 6th tab (adNotify) 1 节加在 daily 之前.
const ALL_SECTIONS = [...MAIL_SECTIONS, ...ADNOTIFY_SECTIONS, ...DAILY_SECTIONS, ...WEEKLY_SECTIONS];

// Audit rows can reference keys that aren't in any of the rendered
// sections (MAIL_SECTIONS / DAILY_SECTIONS / WEEKLY_SECTIONS /
// ALERT_POLICY_ROWS). The audit column falls back to the raw key if
// no label is registered — keep this map non-exhaustive on purpose.
const labels = {
  smtp_host: 'SMTP 主机',
  smtp_port: 'SMTP 端口',
  smtp_secure: 'SSL/TLS',
  smtp_user: 'SMTP 用户名',
  smtp_password: 'SMTP 密码',
  smtp_from: '发件人地址',
  alert_default_to: '默认收件人',
  alert_default_cc: '默认抄送',
  alert_eval_interval_seconds: '评估间隔',
  alert_email_max_attempts: '最大重试次数',
  alert_email_initial_backoff_seconds: '初始退避',
  // R158.61
  report_daily_enabled: '日报启用',
  report_daily_cron: '日报 cron',
  report_daily_to: '日报收件人',
  report_daily_cc: '日报抄送',
  report_weekly_enabled: '周报启用',
  report_weekly_cron: '周报 cron',
  report_weekly_to: '周报收件人',
  report_weekly_cc: '周报抄送',
  report_loop_interval_seconds: '调度器循环间隔',
  report_retention_days: '历史保留天数',
  // R158.100.C (2026-10-14) — AD 操作通知 5 label. 跟 daily/weekly label
  //   1:1 平行. 用于 audit 列表 fallback 显示 (跟 report 1:1 平行).
  ad_notify_enabled: 'AD 通知启用',
  ad_notify_to: 'AD 通知收件人',
  ad_notify_cc: 'AD 通知抄送',
  ad_notify_subject_template: 'AD 通知主题模板',
  ad_notify_body_template: 'AD 通知正文模板',
};

const initial = ref({});
const { current, snapshot, dirty, markClean, reset } = useDirtyState({});
// SMTP keys don't have client-side validation rules (their constraints are
// server-side: port range, email format, etc.). Keep the save button enabled
// whenever the user has dirty edits — ConfigView's useConfigValidation
// composable only knows the base keys and would mark everything invalid.
const hasErrors = computed(() => false);

// Per-section dirty count drives the "[本节 N 项未保存]" badge.
// R158.61+1 — 跨 4 tab 聚合 5 sections (mail×2 + daily×2 + weekly×1),
// ALL_SECTIONS 顺序与 tab 渲染一致, badge 在每节 header 独立显示.
const sectionDirtyCounts = computed(() => {
  const map = {};
  for (const sec of ALL_SECTIONS) {
    map[sec.title] = sec.rows.filter(
      (r) => String(current.value[r.key]) !== String(snapshot.value[r.key])
    ).length;
  }
  return map;
});
// R158.68 — 删 alertSectionDirty / editingRule / onEditRuleFromInbox / onRuleSaved
// (老 AlertInboxView 4 tab 的 "评估策略" 段 + RuleEditorDialog 全废). "告警" tab
// 现在只承载 SystemAlertsView, 阈值配置走 PUT /api/admin/system-alerts/config
// 独立通道, 不再走 useDirtyState 通用 save bar.

const saving = ref(false);
const topLevelMsg = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);

// T12 fix1: a present smtp_password is returned by getConfig() as the mask
// sentinel `********`. Show that as the placeholder so the operator sees
// "password is set, click to overwrite" without revealing the value. Empty
// or absent → empty placeholder.
const SMTP_PASSWORD_MASK = '********';
const passwordPlaceholder = computed(() => {
  const v = current.value.smtp_password;
  return v === SMTP_PASSWORD_MASK ? SMTP_PASSWORD_MASK : '';
});

// True iff smtp_host is non-empty (the only hard requirement for sending).
// Test-mail button is disabled otherwise — saving with an empty host would
// have the backend return 'smtp_host not configured' on every send attempt.
const smtpReady = computed(() => !!String(current.value.smtp_host || '').trim());

// Audit filtered to email-related keys (smtp_*, alert_*) so this page focuses
// on the workflow the operator came here for. The full list lives in the
// main 系统配置 audit.
const emailAudit = computed(() => audit.value.filter((r) => EMAIL_KEYS.includes(r.configKey)).slice(0, 20));

function isUnrollbackable(row) {
  if (!row) return false;
  if (row.configKey !== 'smtp_password') return false;
  if (row.changeType === 'ROLLBACK') return false;
  if (row.oldValue === SMTP_PASSWORD_MASK) return true;
  if (row.newValue === SMTP_PASSWORD_MASK) return true;
  return false;
}
function rollbackTitle(row) {
  return isUnrollbackable(row) ? '密码变更不可回滚' : '';
}

function formatTs(s) {
  if (!s) return '—';
  return formatDateTime(s, { fallback: s });
}

function onRollbackClick(row) {
  rollbackTarget.value = row;
}

async function doRollback() {
  const row = rollbackTarget.value;
  rollbackTarget.value = null;
  if (!row) return;
  try {
    await adminApi.rollbackConfig(row.id);
    await Promise.all([load(), loadAudit()]);
  } catch {
    topLevelMsg.value = '回滚失败';
  }
}

// ---- Test mail dialog ----
const showTestDialog = ref(false);
const testTo = ref('');
const testing = ref(false);
const testError = ref('');
const testOkMsg = ref('');

function openTestDialog() {
  testTo.value = current.value.alert_default_to || '';
  testError.value = '';
  testOkMsg.value = '';
  showTestDialog.value = true;
}

function closeTestDialog() {
  showTestDialog.value = false;
  testing.value = false;
}

async function sendTest() {
  testError.value = '';
  testOkMsg.value = '';
  testing.value = true;
  try {
    const r = await adminApi.sendTestEmail({ to: testTo.value });
    const ok = r?.data?.ok ?? r?.ok ?? false;
    const err = r?.data?.error ?? r?.error ?? null;
    if (ok) {
      testOkMsg.value = `已发送 (${testTo.value})`;
    } else {
      testError.value = err || '发送失败';
    }
  } catch (e) {
    const body = e?.response?.data;
    testError.value = body?.error || e?.message || String(e);
  } finally {
    testing.value = false;
  }
}

async function load() {
  const r = await adminApi.getConfig();
  // Project only the keys this page owns — the backend returns the full
  // config map, but we don't want to render the polling/heartbeat/etc rows
  // here. Update PUT sends only the email subset.
  const all = r.data || {};
  const subset = {};
  for (const k of EMAIL_KEYS) subset[k] = all[k];
  initial.value = subset;
  current.value = { ...subset };
  markClean(current.value);
  await loadAudit();
  await loadReportHistory();
}

async function loadAudit() {
  try {
    const r = await adminApi.getConfigAudit();
    audit.value = r.data || [];
  } catch {
    audit.value = [];
  }
}

function onInput(k, v) {
  current.value = { ...current.value, [k]: v };
}

function onSaveClick() {
  if (!dirty.value || hasErrors.value) return;
  doSave();
}

function onCancel() {
  reset();
  topLevelMsg.value = '';
}

async function doSave() {
  saving.value = true;
  topLevelMsg.value = '';
  try {
    await adminApi.updateConfig(current.value);
    markClean(current.value);
    topLevelMsg.value = '已保存';
  } catch (e) {
    const body = e?.response?.data;
    if (body?.error) topLevelMsg.value = `保存失败：${body.error}`;
    else topLevelMsg.value = '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

// ---- R158.61 — daily / weekly report run-now + history ----
const reportRunning = ref(false);
const reportRunMsg = ref('');
const reportHistory = ref([]);

// R158.61+1 — daily / weekly 各自 tab 渲染独立历史表, 共享同一份
// 后端 /api/admin/reports/history 接口返回, 客户端按 kind 过滤
// 避免重复拉接口. Backend 在 R158.61 一次返回最近 20 条 (混合
// daily/weekly), 客户端 partition 是 0 cost.
const dailyHistory = computed(() =>
  reportHistory.value.filter((r) => r.kind === 'daily')
);
const weeklyHistory = computed(() =>
  reportHistory.value.filter((r) => r.kind === 'weekly')
);

// R158.61+5.6 (2026-10-10) — preview was a hard-coded <a target="_blank">
// link to the protected endpoint, but the backend only authenticates
// `Authorization: Bearer …` (see auth/user-auth.js:55) — it does NOT read
// any cookie. A browser-native navigation can't attach a custom
// Authorization header, so the new tab always landed on `401 missing
// token`. Operator-visible symptom: clicking "预览日报/周报" opened an
// empty tab with `{"error":"missing token"}`. Fix: keep the new-tab UX
// (operator expects the rendered email on its own tab so the form
// stays interactive) but route the GET through axios (which auto-attaches
// the localStorage `ad_token` via the request interceptor at
// web/src/api/client.js:7) and stream the HTML body into the new
// document via document.write. The previous `previewUrl()` is now dead —
// it's kept as a stub returning the same URL for any older code paths
// that might still reference it.
function previewUrl(kind) {
  return `/api/admin/reports/preview?kind=${kind}`;
}

const previewing = ref(false);

// R158.100.C (2026-10-14) — AD 操作通知 preview state.
//   notifyPreviewing 防止双击. notifyPreview 存最近渲染的 { subject, body_text }
//   让 UI 弹个 .preview-pane 让 operator 看到模板渲染结果, 0 必真发邮件.
const notifyPreviewing = ref(false);
const notifyPreview = ref(null);

async function onPreviewNotify() {
  notifyPreviewing.value = true;
  try {
    const r = await adminApi.previewAdNotify();
    notifyPreview.value = r;
  } catch (e) {
    topLevelMsg.value = '预览失败: ' + (e?.message || 'unknown');
    setTimeout(() => { topLevelMsg.value = ''; }, 5000);
  } finally {
    notifyPreviewing.value = false;
  }
}

async function onPreview(kind) {
  previewing.value = true;
  try {
    // Force responseType 'text' (matches admin.js:311) so axios doesn't
    // try to JSON-parse the HTML body. The interceptor still attaches
    // Bearer <token> from localStorage before the request leaves the
    // SPA, so the backend's userAuth middleware (user-auth.js:55)
    // accepts the call.
    const r = await adminApi.previewReport({ kind });
    const html = typeof r?.data === 'string' ? r.data : String(r?.data || '');
    if (!html) {
      // Defensive: if the backend ever returns empty body, surface a
      // clear error instead of opening a blank tab.
      reportRunMsg.value = '预览失败: 后端未返回 HTML';
      return;
    }
    // Open a blank tab synchronously (preserves the popup-blocker-
    // friendly pattern) then write the rendered HTML into it. Using
    // document.write lets the email's inline <style> / <img> references
    // resolve relative to the new tab's about:blank origin, which is
    // what the operator expects when "previewing" an email.
    const w = window.open('', '_blank');
    if (!w) {
      reportRunMsg.value = '预览失败: 浏览器拦截了新窗口, 请允许弹窗后重试';
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || '请求失败';
    reportRunMsg.value = `预览失败: ${msg}`;
  } finally {
    previewing.value = false;
  }
}

async function onRunNow(kind) {
  reportRunning.value = true;
  reportRunMsg.value = `正在生成${kind === 'daily' ? '日报' : '周报'}...`;
  try {
    const r = await adminApi.runReportNow({ kind });
    const data = r.data || {};
    if (data.ok) {
      reportRunMsg.value = `${kind === 'daily' ? '日报' : '周报'}已加入发送队列 (runId=${data.runId}, ${Math.round((data.htmlSize || 0) / 1024)} KB, to=${data.to || '—'})`;
      await loadReportHistory();
    } else {
      reportRunMsg.value = `生成失败: ${data.error || 'unknown'}`;
    }
  } catch (e) {
    const body = e?.response?.data;
    reportRunMsg.value = `生成失败: ${body?.error || e?.message || String(e)}`;
  } finally {
    reportRunning.value = false;
  }
}

async function loadReportHistory() {
  try {
    const r = await adminApi.listReportHistory({ limit: 20 });
    reportHistory.value = r.data?.rows || [];
  } catch {
    reportHistory.value = [];
  }
}

// ---- R158.69 (2026-10-10) — 邮件历史 tab state + loader ----
// UNION ALL 跨 system_alert_outbox + report_email_outbox. 客户端 partition
// 用 source / kind_detail. 30 天默认 + 4 档范围 + 3 档 kind. watch 触发自动
// reload; onMounted 不再调用 (等用户切到 history tab 才拉, 减少 mount 时负载).
const historyDays = ref(30);
const historyKind = ref('all');
const emailHistory = ref([]);
const emailHistoryMsg = ref('');
const emailHistoryLoading = ref(false);
const emailHistoryLoaded = ref(false);
// R161.11 (2026-10-26) — 跟 queueDegraded 1:1 平行: 服务端降级 (表/列缺失)
//   ⇒ 空列表 + 显式提示, 不能跟"真的没有已发送记录"混为一谈。
const historyDegraded = ref(false);

// ---- R158.100.B (2026-10-14) — 邮件队列 (7th tab) state + loader ----
// 跟 history 1:1 平行: UNION ALL 跨 2 表, 只查 sent_at IS NULL (未发出).
// status 字段前端 derive: attempt_count < max_attempts → 'pending' (待发送),
// else → 'exhausted' (已失败, R158.100-fix listPending 跳过, 不会再发).
// 行内 3 操作: 点行 → 复用既有 openDetail / [重发] / [放弃]. 反馈走
// 既有 inline banner 范式 (项目没 ElMessage, 跟 emailHistoryMsg 1:1).
const emailQueue = ref([]);
const queueMsg = ref('');
const queueLoading = ref(false);
const emailQueueLoaded = ref(false);
// R161.11 (2026-10-26) — 降级标记: 服务端判定"队列表缺失/结构不完整"时返回
//   200 + { rows: [], degraded: true, reason, detail }。这**不是**空队列, 而是
//   schema 漂移 ⇒ 页面必须显式提示, 否则操作员会以为"真的没有待发邮件"。
const queueDegraded = ref(false);

async function loadEmailQueue() {
  queueLoading.value = true;
  queueMsg.value = '加载中...';
  queueDegraded.value = false;
  try {
    const r = await adminApi.listEmailQueue({ limit: 500 });
    const body = r.data || {};
    if (body.degraded) {
      emailQueue.value = [];
      queueDegraded.value = true;
      const missing = body.missingTable
        ? `缺表 ${body.missingTable}`
        : (body.missingColumn ? `缺列 ${body.missingColumn}` : '');
      queueMsg.value = `${body.reasonText || '邮件队列不可用'}${missing ? ` (${missing})` : ''} — ${body.detail || ''}`;
      return;
    }
    const rows = r.data?.rows || [];
    // status 字段前端算: attempt_count < max_attempts → pending, else exhausted
    emailQueue.value = rows.map((x) => ({
      ...x,
      status: (Number(x.attempt_count) < Number(x.max_attempts)) ? 'pending' : 'exhausted'
    }));
    const pending = emailQueue.value.filter((x) => x.status === 'pending').length;
    const exhausted = emailQueue.value.filter((x) => x.status === 'exhausted').length;
    queueMsg.value = `共 ${emailQueue.value.length} 条, 待发送 ${pending} / 已失败 ${exhausted}`;
  } catch (e) {
    const body = e?.response?.data;
    emailQueue.value = [];
    // R161.11 — 把服务端的 detail (MySQL/MSSQL 的真实原因) 也显示出来。
    //   此前只显示 body.error (= "email-queue query failed"), 真实原因被丢掉,
    //   操作员只能在 DevTools 里翻。
    queueMsg.value = `加载失败: ${body?.error || e?.message || String(e)}`
      + (body?.detail ? ` — ${body.detail}` : '');
  } finally {
    queueLoading.value = false;
    emailQueueLoaded.value = true;
  }
}

async function retryQueueRow(row) {
  try {
    await adminApi.retryEmailQueue({ source: row.source, id: row.id });
    queueMsg.value = `已重发 #${row.id} (${row.source}), 下次 tick 立即尝试`;
    setTimeout(() => { queueMsg.value = ''; }, 3000);
    await loadEmailQueue();
  } catch (e) {
    const body = e?.response?.data;
    queueMsg.value = `重发失败 #${row.id}: ${body?.error || e?.message || String(e)}`;
  }
}

async function deleteQueueRow(row) {
  try {
    await adminApi.deleteEmailQueue({ source: row.source, id: row.id });
    queueMsg.value = `已放弃 #${row.id} (${row.source})`;
    setTimeout(() => { queueMsg.value = ''; }, 3000);
    await loadEmailQueue();
  } catch (e) {
    const body = e?.response?.data;
    queueMsg.value = `放弃失败 #${row.id}: ${body?.error || e?.message || String(e)}`;
  }
}

async function loadEmailHistory() {
  emailHistoryLoading.value = true;
  emailHistoryMsg.value = '加载中...';
  historyDegraded.value = false;
  try {
    const r = await adminApi.listEmailHistory({
      days: historyDays.value,
      kind: historyKind.value,
      limit: 200,
    });
    const body = r.data || {};
    // R161.11 — 降级 (表/列缺失) ⇒ 空列表 + 显式提示, 不是"加载失败"。
    if (body.degraded) {
      emailHistory.value = [];
      historyDegraded.value = true;
      const missing = body.missingTable
        ? `缺表 ${body.missingTable}`
        : (body.missingColumn ? `缺列 ${body.missingColumn}` : '');
      emailHistoryMsg.value = `${body.reasonText || '邮件历史不可用'}${missing ? ` (${missing})` : ''} — ${body.detail || ''}`;
      return;
    }
    emailHistory.value = r.data?.rows || [];
    const cnt = r.data?.count ?? emailHistory.value.length;
    emailHistoryMsg.value = cnt === 0
      ? `近 ${historyDays.value} 天无${historyKind.value === 'all' ? '' : (historyKind.value === 'alert' ? '告警' : '报表')}已发送记录`
      : `近 ${historyDays.value} 天, 共 ${cnt} 条`;
  } catch (e) {
    const body = e?.response?.data;
    emailHistory.value = [];
    emailHistoryMsg.value = `加载失败: ${body?.error || e?.message || String(e)}`
      + (body?.detail ? ` — ${body.detail}` : '');
  } finally {
    emailHistoryLoading.value = false;
    emailHistoryLoaded.value = true;
  }
}

// 当用户切到 history tab 才拉 (节流: 4 个老 tab mount 时不拉).
// watch topTab 切到 'history' 才触发.
watch(() => topTab.value, (v) => {
  if (v === 'history' && !emailHistoryLoaded.value) loadEmailHistory();
  // R158.100.B — 切到 queue tab 也才拉 (跟 history 1:1 平行)
  if (v === 'queue' && !emailQueueLoaded.value) loadEmailQueue();
});
// 下拉变化时, 已 loaded 也重新拉 (用户主动筛选).
watch([historyDays, historyKind], () => {
  if (emailHistoryLoaded.value) loadEmailHistory();
});

// R158.100.A (2026-10-14) — 邮件历史行 click → 详情 drawer state.
// 列表 row 字段不全 (body_html 不在 list 接口返, 性能保护), 点行触发
// detail endpoint 拿完整字段. 沿用 AuditView drawer 范式 (line 61 aside.drawer
// @click.self="selected=null"). source+id 唯一定位 (系统告警 outbox.id
// 跟报表 outbox.id 是不同自增序列, 同一 id 可能冲突 → 必须 source 区分).
const detailRow = ref(null);
const detailLoading = ref(false);
const detailError = ref('');

async function openDetail(row) {
  detailError.value = '';
  // 先把列表 row 放进 drawer, 用户立刻看到 subject/to 等
  detailRow.value = { ...row };
  detailLoading.value = true;
  try {
    const r = await adminApi.getEmailHistoryDetail({ source: row.source, id: row.id });
    // 后端返 { row: {...} }
    const payload = r?.data?.row ?? r?.data;
    detailRow.value = { ...row, ...(payload || {}) };
  } catch (e) {
    const body = e?.response?.data;
    detailError.value = `加载失败: ${body?.error || e?.message || String(e)}`;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  detailRow.value = null;
  detailError.value = '';
  detailLoading.value = false;
}

onMounted(load);
</script>

<style scoped>
.page-head { margin-bottom: 18px; }
.page-head h2 { margin: 0 0 4px; }
.page-summary { margin: 0; color: var(--muted); font-size: 13px; }

/* R158.62 — top-level page tabs (邮件 / 告警). Hand-rolled <nav>
   matches the AuditView tab pattern; v-show keeps both branches in
   the DOM so the save bar's `dirty` ref stays warm across switches. */
.top-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 18px; }
.top-tab {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-bottom: none;
  padding: 8px 18px; cursor: pointer; font-size: 14px;
  margin-right: 4px; border-radius: 4px 4px 0 0;
}
.top-tab.active { background: var(--panel); color: var(--text); border-bottom: 1px solid var(--panel); margin-bottom: -1px; }

.config-section { margin-bottom: 22px; }
.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.section-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.section-dirty { color: var(--status-pill-fg-warn); font-size: 12px; }

/* R161.11 (2026-10-26) — 降级横幅: 服务端判定 outbox 表/列缺失时显示。
   跟 .section-dirty (行内小字) 区分开: 这是"整个数据源不可用", 得显眼。 */
.degraded-banner {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--status-pill-fg-warn);
  border-radius: 3px;
  background: var(--panel);
  color: var(--status-pill-fg-warn);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.degraded-banner strong { font-weight: 600; }
.degraded-hint { color: var(--muted); }
.degraded-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text);
}

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.desc-text { color: var(--muted); font-size: 12px; display: block; }
.action-row { margin-top: 6px; display: flex; gap: 4px; align-items: center; }
.secure-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.secure-toggle input[type=checkbox] { width: auto; }

.save-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 0;
  margin-top: 8px;
  background: var(--bg);
  border-top: 1px solid var(--border);
}
.dirty { color: var(--yellow); margin-right: 12px; }
button.save, button.cancel { padding: 6px 14px; border: 1px solid var(--border); background: var(--accent); color: var(--sidebar-bg); border-radius: 3px; cursor: pointer; margin-right: 8px; }
button.save:disabled, button.cancel:disabled { opacity: 0.5; cursor: not-allowed; }
button.cancel { background: var(--sidebar-bg); color: var(--text); }
.msg { margin-left: 12px; color: var(--accent); }

.audit { margin-top: 24px; }
.audit h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.audit table { width: 100%; border-collapse: collapse; background: var(--panel); }
.audit th, .audit td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.audit th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.audit code { font-size: 12px; color: var(--text); }
.audit button.rollback { padding: 4px 10px; border: 1px solid var(--border); background: var(--accent); color: var(--sidebar-bg); border-radius: 3px; cursor: pointer; font-size: 12px; }
.audit button.rollback:disabled { background: var(--border); color: var(--muted); cursor: not-allowed; }
.token-action { padding: 3px 10px; border: 1px solid var(--border); background: var(--sidebar-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 4px; }
.token-action:hover:not(:disabled) { background: var(--accent); color: var(--sidebar-bg); }
.token-action:disabled { opacity: 0.5; cursor: not-allowed; }
.key-label { font-weight: 600; color: var(--text); }
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; font-style: italic; }
.err { display: block; color: var(--red); font-size: 12px; margin-top: 4px; }
.has-password-mask { font-family: monospace; }
.modal-bg { position: fixed; inset: 0; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 420px; max-width: 90vw; }
.modal h3 { margin: 0 0 12px; }
.modal .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.modal .row label { width: 80px; color: var(--muted); font-size: 13px; }
.modal .row input { flex: 1; background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 6px 8px; border-radius: 3px; }
.modal .actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px; }
.modal .primary { background: var(--accent); color: var(--sidebar-bg); padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
.modal .primary:disabled { opacity: 0.5; cursor: not-allowed; }
.modal button { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 6px 14px; border-radius: 3px; cursor: pointer; }
.error { color: var(--red); font-size: 13px; margin: 8px 0; white-space: pre-wrap; }
.ok-msg { color: var(--accent); font-size: 13px; margin: 8px 0; }
.req { color: var(--red); }
/* R158.61 — report quick actions + history table */
.report-action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.preview-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
}
.preview-link:hover { color: var(--text); border-bottom-color: var(--text); }

/* R158.100.C (2026-10-14) — AD 操作通知 tab 静态占位符 help + 预览 pane.
   .placeholder-help 是 <details> 折叠, .preview-pane 是预览渲染结果框. */
.placeholder-help {
  margin: 8px 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  border-radius: 3px;
  font-size: 12px;
  color: var(--text);
}
.placeholder-help summary {
  cursor: pointer;
  color: var(--accent);
  user-select: none;
  margin-bottom: 6px;
}
.placeholder-body { padding: 4px 0 0 0; }
.placeholder-body p { margin: 4px 0; }
.placeholder-body ul { margin: 4px 0 8px 16px; padding: 0; }
.placeholder-body li { margin: 2px 0; }
.placeholder-body code { font-size: 11px; color: var(--accent); }
.placeholder-body .warn { color: #d97706; font-size: 12px; margin-top: 8px; }
.preview-pane {
  margin: 12px 0 0 0;
  padding: 8px 12px;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  border-radius: 3px;
}
.preview-head { font-size: 12px; color: var(--text); margin-bottom: 6px; }
.preview-body { font-size: 12px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.status-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  color: var(--muted);
}
.status-pending { color: var(--yellow); border-color: var(--yellow); }
.status-success { color: var(--accent); border-color: var(--accent); }
.status-failed  { color: var(--red); border-color: var(--red); }
.status-sent    { color: var(--accent); border-color: var(--accent); }
.err-inline { margin-left: 4px; color: var(--red); cursor: help; }
/* R158.69 (2026-10-10) — 邮件历史 tab table + kind pill */
.email-history-table { font-size: 13px; }
.email-history-table code { font-size: 12px; }
.kind-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
}
.kind-alert  { color: var(--red);    border-color: var(--red); }
.kind-daily  { color: var(--accent); border-color: var(--accent); }
.kind-weekly { color: var(--yellow); border-color: var(--yellow); }
.empty { color: var(--muted); font-size: 13px; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 3px; }
.email-history-table td code.err { color: var(--red); max-width: 320px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* R158.100.A (2026-10-14) — 邮件历史行 click → 详情 drawer.
   沿用 AuditView .drawer 范式 (AuditView.vue:222-225) + 50% 宽 (操作员决策,
   比 AuditView 40% 宽, 因邮件详情 body 80KB 需要更宽的 iframe).
   z-index 200 覆盖 table 跟 other elements. */
.email-history-row { cursor: pointer; }
.email-history-row:hover { background: var(--panel-alt); }

.email-history-drawer {
  position: fixed; inset: 0 0 0 auto; width: 50%; min-width: 480px;
  background: var(--panel); border-left: 1px solid var(--border);
  padding: 20px; overflow: auto; z-index: 200;
  box-shadow: -2px 0 8px var(--modal-backdrop);
}
.email-history-drawer-body header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;
}
.email-history-drawer-body h3 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
.email-history-drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 4px; font-weight: normal; }
.email-history-drawer-body .close {
  background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; line-height: 1;
}
.email-history-drawer-body h4 {
  margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: var(--text);
  border-top: 1px solid var(--border); padding-top: 12px;
}
.email-history-drawer-body .kv { display: grid; grid-template-columns: 90px 1fr; gap: 6px 12px; margin: 0; }
.email-history-drawer-body .kv dt { color: var(--muted); font-size: 12px; padding-top: 2px; }
.email-history-drawer-body .kv dd { margin: 0; font-size: 13px; word-break: break-all; }
.email-history-drawer-body .kv code { font-size: 12px; }

.email-history-drawer-body .error-pre {
  background: var(--terminal-bg, var(--sidebar-bg));
  border: 1px solid var(--border); border-radius: 3px;
  padding: 8px 10px; margin: 0; max-height: 240px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; color: var(--red); white-space: pre-wrap; word-break: break-word;
}
.email-history-drawer-body .muted { color: var(--muted); }
.email-history-drawer-body .error { color: var(--red); font-size: 13px; padding: 8px 0; }

.email-history-drawer-body .email-html-frame {
  width: 100%; height: 480px; border: 1px solid var(--border); border-radius: 3px;
  background: var(--sidebar-bg);
}

/* ---- R158.100.B (2026-10-14) — 邮件队列 7th tab CSS ----
   跟 .email-history-row 1:1 平行, exhausted 行淡化提示"已死"语义. */
.email-queue-row { cursor: pointer; }
.email-queue-row:hover { background: var(--panel-alt); }
.email-queue-row-exhausted { opacity: 0.7; }
.email-queue-row-exhausted:hover { opacity: 1; }
.email-queue-table .err {
  color: var(--red);
  font-size: 12px;
  display: inline-block;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
</style>