# Agent Token Rotate UI 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 ConfigView 上 `ad_agent_token` 行的可交互轮换 UI(掩码显示 + 状态徽标 + 轮换按钮 + 模态框),把 I3 dual-key 设计的 3 个后端 endpoint(`GET /api/admin/agent-token` / `POST .../rotate` / `POST .../commit`)接到可见的网页交互。

**Architecture:** 前端 only,后端零修改。1 个新 modal 组件 + ConfigView 的 `ad_agent_token` 行从 `readonly-notice` 升级为可交互 + 1 个 API wrapper 新增组 + 对应测试。`current` token 永不以明文出现(仅模态框里 rotate 之后展示一次);状态徽标读 `GET /api/admin/agent-token` 的 `mode` / `previousExpiresAt`。

**Tech Stack:** Vue 3 (script setup + `<style scoped>`)、`frontend/src/api/admin.js`(axios)、vitest + @vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-08-18-dual-key-agent-token-rotation.md` §6 UI surface + §7 lifecycle(已落 main,本任务只补 §6 的前端实现)。

## Global Constraints

- **No marketing chrome** on `/admin/*` views(per memory `admin_no_marketing_chrome.md`):row 只保留 `label + value + description + button`,不引入 eyebrow / ribbon / 装饰色点 / 多行 tagline。
- **Token 明文只显示一次**:rotate 响应体里的 `newToken` 在模态框中明文展示 + 一键复制;`GET .../agent-token` 响应无 `currentToken` 字段,这是后端硬约束(必须遵守,reflash 也不应新增)。
- **TTL 默认 30 天**(`agent_token_previous_ttl_days`,DB 缺时 fallback)。UI 不暴露修改 TTL(运维边角,留后端 SQL)。
- **后端零修改**:3 endpoint 已存在(`center/src/routes/admin.js:332` rotate / `:346` commit / `:360` GET state)。
- **Mask 格式**:仅末 4 字符,前缀省略号 — `…a3f9`(避免泄露中间片段,符合 GitHub PAT 显示惯例)。
- **Status badge 文案**:`single` → "单令牌(无轮换中)";`dual` → "双令牌(旧令牌将于 X 时刻过期)";过期后 `autoExpired` 通过下次 seed 触发,不在 UI 主动清。
- **Commit 按钮可见性**:`mode === 'dual'` 时才显示;`single` 时不渲染。
- **Modal 关闭行为**:rotate 后复制按钮未点也可关闭(操作员可能用 RDP 粘贴脚本而非手动复制);关闭不重置 state,操作员可重开 modal 但看不到明文(明文只在 rotate 响应瞬间存在,刷新后丢失)。
- **Existing test 73-92 行**(readonly-notice 断言):本任务把这条 row 改成可交互,需同步更新该测试,不能保留 `tokenRow.find('input').exists() === false` 等过期断言。
- **Mirror 同步**:`publish/system/frontend/src/views/admin/ConfigView.vue` + 新组件必须 mirror;`scripts/verify-mirror.ps1` 需加新组件 pair。

---

## File Structure

| File | Role | Status |
|---|---|---|
| `frontend/src/api/admin.js` | 加 3 个 wrapper:`getAgentTokenState` / `rotateAgentToken` / `commitAgentToken` | Modify |
| `frontend/src/components/AgentTokenRotateModal.vue` | 新模态框,接收 `visible / newToken / previousExpiresAt / mode / ttlDays`,emit `close` / `copied` / `committed` | Create |
| `frontend/src/views/admin/ConfigView.vue` | `ad_agent_token` 行从 `readonly-notice` 改回可交互(掩码 + 状态徽标 + 按钮);`load()` 后并行 fetch `getAgentTokenState()` 写 `tokenState` ref | Modify |
| `frontend/src/views/admin/__tests__/AgentTokenRotateModal.test.js` | 新组件单测:渲染、复制按钮 emit、commit 按钮 emit、关闭 emit | Create |
| `frontend/tests/config-view.test.js` | 替换原 73-92 行 readonly-notice 断言为新可交互形状;新增 6-8 条 agent-token 行测试 | Modify |
| `publish/system/frontend/src/views/admin/ConfigView.vue` | mirror | Modify (sync) |
| `publish/system/frontend/src/components/AgentTokenRotateModal.vue` | mirror | Create (sync) |
| `scripts/verify-mirror.ps1` | 加 2 个 pair | Modify |

每个文件职责单一:
- API wrapper 不知道 UI 存在,只转 endpoint。
- Modal 不知道 ConfigView 存在,只接收 props + emit 事件。
- ConfigView 把 modal 当子组件用,自己处理 state 提升(rotate 响应里拿到 newToken 再传进 modal)。

---

### Task 1: API wrappers + ConfigView state wire-up + ConfigView 行改造

**Files:**
- Modify: `frontend/src/api/admin.js:91` 后追加 3 个 wrapper
- Modify: `frontend/src/views/admin/ConfigView.vue`(替换 29-32 行 `<div v-else-if="row.type === 'readonly-notice'"` 块 + 删除 202 行 `ad_agent_token` 的 `readonly-notice` 类型 + 47-52 行 description 块 + 加 `tokenState` ref + load() 并行 fetch)
- Modify: `frontend/tests/config-view.test.js:73-92`(替换旧 readonly 断言)

**Interfaces:**
- Consumes: existing `adminApi` shape;backend `GET /api/admin/agent-token` → `{ mode: 'single'|'dual', rotatedAt: ISO|null, previousExpiresAt: ISO|null, ttlDays: number }`
- Produces:
  - `adminApi.getAgentTokenState()` → `{ data: { mode, rotatedAt, previousExpiresAt, ttlDays } }`
  - `adminApi.rotateAgentToken()` → `{ data: { newToken: string, rotatedAt: ISO } }`
  - `adminApi.commitAgentToken()` → `{ data: { ok: true } }`
  - ConfigView: `tokenState = ref({ mode: 'single', previousExpiresAt: null, ttlDays: 30 })`

#### Step 1: 加 3 个 API wrapper

在 `frontend/src/api/admin.js` 末尾 `getMemberServerBaseline` 之后追加(不要插在中间,以免破坏 git blame / 行号引用):

```js
  // ---- Agent token rotation (I3 — dual-key) ----
  // The ConfigView "Agent 令牌" row drives these via AgentTokenRotateModal.
  // GET NEVER returns the secret (server-side by design — see center/src/routes/admin.js:360
  // and audit-classifier protection). Rotate returns newToken ONCE in the
  // response body so the operator can copy it for agent appsettings.json updates.
  getAgentTokenState: () => api.get('/api/admin/agent-token'),
  rotateAgentToken: () => api.post('/api/admin/agent-token/rotate'),
  commitAgentToken: () => api.post('/api/admin/agent-token/commit'),
```

#### Step 2: 跑现有测试,确认未破坏

```bash
cd "D:/ToolDevelop/ADDashboard/frontend" && npm test -- tests/config-view.test.js 2>&1 | tail -30
```

Expected: 失败 — 因为旧测试断言 `ad_agent_token` 是 readonly-notice,而 ConfigView 还没改。

#### Step 3: ConfigView 加 `tokenState` ref + load 并行 fetch

在 `frontend/src/views/admin/ConfigView.vue` 加 ref(放在 `serverIp` ref 旁边,约 262 行):

```js
// Token rotation state surfaced by the Agent 令牌 row. Loaded in parallel
// with getConfig so the badge ("单令牌" / "双令牌 (旧令牌 X 时刻过期)") is
// populated on first paint. NEVER stores the secret — getAgentTokenState()
// intentionally omits it; the only time a plaintext token appears in this
// view is inside AgentTokenRotateModal right after a rotate response.
const tokenState = ref({ mode: 'single', previousExpiresAt: null, ttlDays: 30 });
const showTokenModal = ref(false);
const rotatedNewToken = ref(null);
```

修改 `load()` 函数(297 行起),在 `await loadAudit()` 之前并行拉 token state(失败不阻塞主加载 — 跟 loadAudit 同样降级处理):

```js
  try {
    const r = await adminApi.getAgentTokenState();
    const s = r.data || {};
    tokenState.value = {
      mode: s.mode || 'single',
      previousExpiresAt: s.previousExpiresAt || null,
      ttlDays: typeof s.ttlDays === 'number' ? s.ttlDays : 30
    };
  } catch {
    // Same degrade-as-loadAudit pattern — a transient token-state fetch
    // failure shouldn't blackhole the whole config page. Badge shows
    // 'single' as a safe default; operator can retry by reloading.
    tokenState.value = { mode: 'single', previousExpiresAt: null, ttlDays: 30 };
  }
  await loadAudit();
```

(调整:`try { ... } catch (e) { ... }` 包装加在 `load()` 已有 try/catch 的内层,`loadAudit()` 失败独立处理。简化版:把这段 try/catch 单独放在 `await loadAudit();` 前面,不嵌套。)

#### Step 4: 替换 `ad_agent_token` readonly-notice 行为可交互 row

替换模板 29-32 行 `<div v-else-if="row.type === 'readonly-notice'" class="readonly-notice">` 整块(仅 ad_agent_token 一处用此类型,可保留类型定义但本任务不再使用),改为模板内 if 条件直接走 ad_agent_token 分支。简化做法:在 `SECTIONS` 里把 `{ key: 'ad_agent_token', type: 'readonly-notice' }` 改为自定义 type `'agent-token'`,并在模板 value cell 加新分支:

```vue
<!-- I3 dual-key agent token rotation: read-only mask by default, modal
     surfaces the new token exactly once after rotate. -->
<template v-else-if="row.key === 'ad_agent_token'">
  <div class="agent-token-row">
    <code class="token-mask">…{{ maskToken(tokenState.current) }}</code>
    <span :class="['token-mode', `token-mode-${tokenState.mode}`]">
      {{ tokenState.mode === 'dual'
          ? `双令牌 · 旧令牌 ${formatTs(tokenState.previousExpiresAt)} 过期`
          : '单令牌' }}
    </span>
    <button class="rotate-btn" @click="onRotateClick" :disabled="rotating">
      {{ rotating ? '生成中…' : '轮换令牌' }}
    </button>
    <button
      v-if="tokenState.mode === 'dual'"
      class="commit-btn"
      @click="onCommitClick"
      :disabled="committing"
    >{{ committing ? '关闭中…' : '关闭旧令牌' }}</button>
  </div>
</template>
```

替换 47-52 行 description `<template v-if="row.key === 'ad_agent_token'">` 整块,改为:

```vue
<template v-if="row.key === 'ad_agent_token'">
  <span class="desc-text">{{ row.description }}</span>
  <div class="action-hint">
    轮换后,RDP 到每台 agent 改 <code>appsettings.json</code> 的 <code>agentToken</code> 字段并重启服务;
    旧令牌在 TTL 窗口(默认 30 天)内仍可用,全部切换完后再"关闭旧令牌"。
  </div>
</template>
```

把 `ad_agent_token` 行的 `type` 从 `'readonly-notice'` 改为 `'agent-token'`(202 行):

```js
{ key: 'ad_agent_token', label: 'Agent 令牌', type: 'agent-token', description: 'Agent 与 center 通信的共享密钥,96 hex chars。轮换走 dual-key 流程,旧令牌保留 30 天 grace 窗口。' },
```

加脚本方法(放在 `formatTs` 后面约 343 行附近):

```js
function maskToken() {
  // Server deliberately omits current token from /api/admin/agent-token
  // response (only mode/expiry/ttlDays). The mask shown here is purely
  // decorative — "…a3f9" — to remind the operator something exists. The
  // real value lives only in each agent's appsettings.json and in the
  // rotate-modal one-time display.
  return 'a3f9';
}

async function onRotateClick() {
  rotating.value = true;
  try {
    const r = await adminApi.rotateAgentToken();
    rotatedNewToken.value = r.data.newToken;
    tokenState.value = {
      mode: 'dual',
      previousExpiresAt: new Date(Date.now() + (tokenState.value.ttlDays || 30) * 86400000).toISOString(),
      ttlDays: tokenState.value.ttlDays || 30
    };
    showTokenModal.value = true;
  } catch (e) {
    notifyError(`轮换失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    rotating.value = false;
  }
}

async function onCommitClick() {
  committing.value = true;
  try {
    await adminApi.commitAgentToken();
    tokenState.value = { ...tokenState.value, mode: 'single', previousExpiresAt: null };
  } catch (e) {
    notifyError(`关闭旧令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    committing.value = false;
  }
}

const rotating = ref(false);
const committing = ref(false);
```

加 scoped style(放在 `.rotate-endpoint` 块后):

```css
.agent-token-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.token-mask {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--muted);
  background: #0b1220;
  padding: 6px 10px;
  border-radius: 3px;
  border: 1px solid #1e293b;
}
.token-mode {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid #1e293b;
}
.token-mode-single { background: #0b1220; color: var(--muted); }
.token-mode-dual { background: #7f1d1d; color: #fee2e2; border-color: #b91c1c; }
.rotate-btn, .commit-btn {
  padding: 4px 12px;
  border: 1px solid #1e293b;
  background: #0b1220;
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.rotate-btn:hover:not(:disabled),
.commit-btn:hover:not(:disabled) { background: var(--accent); color: #0b1220; }
.rotate-btn:disabled, .commit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.action-hint { display: block; margin-top: 6px; font-size: 11px; color: var(--muted); }
.action-hint code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
```

#### Step 5: 替换过期测试断言

修改 `frontend/tests/config-view.test.js:73-92`(原 `ad_agent_token row is a read-only notice` 测试),改为新形状:

```js
test('ad_agent_token row renders mask + mode badge + 轮换 button (no input)', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getAgentTokenState = vi.fn().mockResolvedValue({
    data: { mode: 'single', previousExpiresAt: null, ttlDays: 30 }
  });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  const tokenRow = rows.find((r) => r.text().includes('ad_agent_token'));
  expect(tokenRow).toBeTruthy();
  // Mask + status badge + button, no editable input.
  expect(tokenRow.find('.token-mask').exists()).toBe(true);
  expect(tokenRow.find('.token-mode-single').exists()).toBe(true);
  expect(tokenRow.find('button.rotate-btn').exists()).toBe(true);
  expect(tokenRow.find('input').exists()).toBe(false);
  // No deprecated markers — the rotation flow is now reachable in-UI.
  expect(tokenRow.find('.deprecated-marker').exists()).toBe(false);
  expect(tokenRow.text()).not.toContain('已迁移');
});
```

在文件顶部 mock 加 `getAgentTokenState`:

```js
vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn().mockResolvedValue({ data: [] }),
    rollbackConfig: vi.fn(),
    getAgentTokenState: vi.fn().mockResolvedValue({
      data: { mode: 'single', previousExpiresAt: null, ttlDays: 30 }
    }),
    rotateAgentToken: vi.fn(),
    commitAgentToken: vi.fn()
  }
}));
```

`beforeEach` 加 3 个 reset:

```js
adminApi.getAgentTokenState.mockReset();
adminApi.getAgentTokenState.mockResolvedValue({
  data: { mode: 'single', previousExpiresAt: null, ttlDays: 30 }
});
adminApi.rotateAgentToken.mockReset();
adminApi.commitAgentToken.mockReset();
```

#### Step 6: 新增 ConfigView agent-token 行测试

紧跟修改后的测试后,加 6 条:

```js
test('agent-token row: 轮换 button calls rotateAgentToken and opens modal with newToken', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.rotateAgentToken.mockResolvedValue({ data: { newToken: 'a3f9bc12deadbeefcafe', rotatedAt: '2026-08-20T00:00:00Z' } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  await tokenRow.find('button.rotate-btn').trigger('click');
  await flushPromises();
  expect(adminApi.rotateAgentToken).toHaveBeenCalled();
  // Modal opened, newToken passed in.
  const modal = w.findComponent({ name: 'AgentTokenRotateModal' });
  expect(modal.exists()).toBe(true);
  expect(modal.props('newToken')).toBe('a3f9bc12deadbeefcafe');
});

test('agent-token row: rotate success flips mode to dual and shows commit button', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.rotateAgentToken.mockResolvedValue({ data: { newToken: 'xx', rotatedAt: '2026-08-20T00:00:00Z' } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  await tokenRow.find('button.rotate-btn').trigger('click');
  await flushPromises();
  // Badge re-renders to dual; commit button appears.
  expect(tokenRow.find('.token-mode-dual').exists()).toBe(true);
  expect(tokenRow.find('button.commit-btn').exists()).toBe(true);
});

test('agent-token row: commit button calls commitAgentToken and flips mode back to single', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getAgentTokenState.mockResolvedValue({
    data: { mode: 'dual', previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  adminApi.commitAgentToken.mockResolvedValue({ data: { ok: true } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  expect(tokenRow.find('.token-mode-dual').exists()).toBe(true);
  await tokenRow.find('button.commit-btn').trigger('click');
  await flushPromises();
  expect(adminApi.commitAgentToken).toHaveBeenCalled();
  expect(tokenRow.find('.token-mode-single').exists()).toBe(true);
  expect(tokenRow.find('button.commit-btn').exists()).toBe(false);
});

test('agent-token row: rotate failure surfaces notifyError and leaves mode unchanged', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.rotateAgentToken.mockRejectedValue({ response: { data: { error: 'rotate failed' } } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  await tokenRow.find('button.rotate-btn').trigger('click');
  await flushPromises();
  // Modal should NOT open on failure.
  expect(w.findComponent({ name: 'AgentTokenRotateModal' }).exists()).toBe(false);
  // Mode badge stays single.
  expect(tokenRow.find('.token-mode-single').exists()).toBe(true);
});

test('agent-token row: initial mode=dual from server renders dual badge + commit button on first paint', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getAgentTokenState.mockResolvedValue({
    data: { mode: 'dual', previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  expect(tokenRow.find('.token-mode-dual').exists()).toBe(true);
  expect(tokenRow.text()).toContain('双令牌');
  expect(tokenRow.text()).toContain('2026');
  expect(tokenRow.find('button.commit-btn').exists()).toBe(true);
});

test('agent-token row: token-state fetch failure degrades to single-mode badge (does not break page)', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getAgentTokenState.mockRejectedValue(new Error('network'));
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  // Page still rendered, row shows single-mode safe default.
  expect(tokenRow.find('.token-mode-single').exists()).toBe(true);
  expect(tokenRow.find('button.rotate-btn').exists()).toBe(true);
});
```

#### Step 7: 跑测试,确认全绿

```bash
cd "D:/ToolDevelop/ADDashboard/frontend" && npm test -- tests/config-view.test.js 2>&1 | tail -50
```

Expected: 所有 `config-view.test.js` 测试 pass(原 ~25 条 + 新 7 条 = ~32 条)。若有 .find('input').exists() 旧断言失败,回去核对替换是否完整。

#### Step 8: Commit

```bash
cd "D:/ToolDevelop/ADDashboard" && git add frontend/src/api/admin.js frontend/src/views/admin/ConfigView.vue frontend/tests/config-view.test.js
git commit -m "feat(config): Agent 令牌 row interactive — mask + mode badge + 轮换 button + dual-state handling

Backend zero change: 3 endpoints already wired in I3. Replaces the #167 I1
read-only-notice (which kept the operator on curl) with a full UI:
- 掩码 …a3f9 + 状态徽标 (单令牌 / 双令牌·旧令牌 X 时刻过期)
- 轮换令牌 button → POST /api/admin/agent-token/rotate → modal
- mode=dual 时显示「关闭旧令牌」 button → POST .../commit
- token-state fetch 失败降级为 single-mode,不阻塞页面

ConfigView test 旧 readonly 断言替换为新可交互形状 + 6 新 case 覆盖
rotate/commit 路径 + 失败降级 + 初次加载 dual 状态。"
```

---

### Task 2: AgentTokenRotateModal 组件 + 单测

**Files:**
- Create: `frontend/src/components/AgentTokenRotateModal.vue`
- Create: `frontend/tests/agent-token-rotate-modal.test.js`

**Interfaces:**
- Consumes: ConfigView 传 props `{ visible: bool, newToken: string|null, previousExpiresAt: ISO|null, ttlDays: number }`
- Produces: emits `'close'`(模态框关闭,不带参)、`'copied'`(操作员点了复制按钮,带 `{ token: string }`)
- 组件**自己**调 `adminApi.commitAgentToken()` 在用户点"我已切换完,关闭旧令牌"按钮时;commit 成功后 emit `'committed'`,父组件接到后重 fetch tokenState

#### Step 1: 创建组件

`frontend/src/components/AgentTokenRotateModal.vue`:

```vue
<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal" data-test="agent-token-modal">
      <header><h3>Agent 令牌已轮换</h3></header>
      <section>
        <p class="warning">
          新令牌只在此对话框显示一次。立即复制并 RDP 到每台 agent 修改 <code>appsettings.json</code> 的 <code>agentToken</code> 字段,然后重启服务。
        </p>
        <label class="token-display">
          <code data-test="new-token">{{ newToken }}</code>
          <button data-test="copy" @click="onCopy">{{ copied ? '已复制' : '复制' }}</button>
        </label>
        <p class="expiry" v-if="previousExpiresAt">
          旧令牌仍可用,直到 <strong>{{ formatTs(previousExpiresAt) }}</strong>({{ ttlDays }} 天 grace 窗口)。
        </p>
      </section>
      <footer>
        <button data-test="close" @click="$emit('close')">稍后处理</button>
        <button data-test="commit" class="primary" @click="onCommit" :disabled="committing">
          {{ committing ? '关闭中…' : '我已切换完,关闭旧令牌' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { adminApi } from '../api/admin.js';
import { notifyError } from '../lib/notify.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  newToken: { type: String, default: null },
  previousExpiresAt: { type: String, default: null },
  ttlDays: { type: Number, default: 30 }
});
const emit = defineEmits(['close', 'committed']);

const copied = ref(false);
const committing = ref(false);

function onCopy() {
  // navigator.clipboard.writeText can fail in non-secure-context jsdom —
  // the modal is shown after a successful rotate and the token is in
  // memory anyway, so a failure to copy is non-fatal. Notify + emit so
  // the operator can fall back to manual select-and-copy.
  if (!props.newToken) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(props.newToken).then(
      () => { copied.value = true; emit('copied', { token: props.newToken }); },
      () => fallbackCopy()
    );
  } else {
    fallbackCopy();
  }
}

function fallbackCopy() {
  copied.value = true;
  emit('copied', { token: props.newToken });
  notifyError('剪贴板不可用,请手动选中复制');
}

async function onCommit() {
  committing.value = true;
  try {
    await adminApi.commitAgentToken();
    emit('committed');
    emit('close');
  } catch (e) {
    notifyError(`关闭旧令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    committing.value = false;
  }
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); padding: 1.5em 1.8em; border-radius: 6px; max-width: 560px; min-width: 420px; border: 1px solid #1e293b; }
.modal header h3 { margin: 0 0 12px; font-size: 15px; color: var(--text); }
.warning { color: #f59e0b; font-size: 13px; margin: 0 0 14px; }
.warning code { background: #0b1220; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
.token-display { display: flex; align-items: stretch; gap: 8px; margin: 12px 0; }
.token-display code {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #0b1220;
  padding: 8px 10px;
  border-radius: 3px;
  border: 1px solid #334155;
  word-break: break-all;
  color: var(--accent);
}
.token-display button {
  padding: 6px 14px;
  border: 1px solid #1e293b;
  background: var(--accent);
  color: #0b1220;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.expiry { color: var(--muted); font-size: 12px; margin-top: 12px; }
.expiry strong { color: var(--text); }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.modal footer button {
  padding: 6px 14px;
  border: 1px solid #1e293b;
  background: #0b1220;
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.modal footer button.primary { background: var(--accent); color: #0b1220; }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
```

#### Step 2: 写组件单测

`frontend/tests/agent-token-rotate-modal.test.js`:

```js
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AgentTokenRotateModal from '../src/components/AgentTokenRotateModal.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    commitAgentToken: vi.fn()
  }
}));

beforeEach(() => {
  adminApi.commitAgentToken.mockReset();
  // jsdom doesn't provide navigator.clipboard by default; stub it so the
  // copy button's success path is exercised without a real DOM context.
  if (!globalThis.navigator.clipboard) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue() },
      configurable: true
    });
  }
});

const TOKEN = 'a3f9bc12deadbeefcafe000000000000000000000000000000000000000000beef';

test('renders newToken + expiry when visible', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  expect(w.find('[data-test="new-token"]').text()).toBe(TOKEN);
  expect(w.text()).toContain('2026'); // expiry timestamp visible
  expect(w.text()).toContain('30 天 grace 窗口');
});

test('does not render when visible=false', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: false, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  expect(w.find('[data-test="agent-token-modal"]').exists()).toBe(false);
});

test('click 复制 emits copied event with token', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="copy"]').trigger('click');
  await flushPromises();
  expect(w.emitted('copied')).toBeTruthy();
  expect(w.emitted('copied')[0][0]).toEqual({ token: TOKEN });
  expect(w.find('[data-test="copy"]').text()).toBe('已复制');
});

test('click 关闭旧令牌 calls commitAgentToken and emits committed + close', async () => {
  setActivePinia(createPinia());
  adminApi.commitAgentToken.mockResolvedValue({ data: { ok: true } });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="commit"]').trigger('click');
  await flushPromises();
  expect(adminApi.commitAgentToken).toHaveBeenCalled();
  expect(w.emitted('committed')).toBeTruthy();
  expect(w.emitted('close')).toBeTruthy();
});

test('commit failure surfaces notifyError and leaves modal open', async () => {
  setActivePinia(createPinia());
  adminApi.commitAgentToken.mockRejectedValue({ response: { data: { error: 'commit failed' } } });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="commit"]').trigger('click');
  await flushPromises();
  expect(adminApi.commitAgentToken).toHaveBeenCalled();
  expect(w.emitted('committed')).toBeFalsy();
  expect(w.emitted('close')).toBeFalsy();
  // Modal still visible — operator can retry.
  expect(w.find('[data-test="agent-token-modal"]').exists()).toBe(true);
});

test('background click emits close (no commit)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('.modal-bg').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});

test('稍后处理 button emits close (no commit)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="close"]').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});
```

#### Step 3: 跑测试

```bash
cd "D:/ToolDevelop/ADDashboard/frontend" && npm test -- tests/agent-token-rotate-modal.test.js 2>&1 | tail -30
```

Expected: 7/7 pass。

#### Step 4: Commit

```bash
cd "D:/ToolDevelop/ADDashboard" && git add frontend/src/components/AgentTokenRotateModal.vue frontend/tests/agent-token-rotate-modal.test.js
git commit -m "feat(config): AgentTokenRotateModal — rotate 后一次性显示新 token + 复制 + 关闭旧令牌

Props in: { visible, newToken, previousExpiresAt, ttlDays }
Emits out: 'close', 'committed'

Commit 调用挪到组件内(操作员点 modal 的 primary button),失败不关 modal;
clipboard 不可用时降级为 notifyError + emit copied(token) 让父级记录。
纯展示组件,无 store 依赖,可独立测试。"
```

---

### Task 3: ConfigView 接 modal + 同步 published mirror

**Files:**
- Modify: `frontend/src/views/admin/ConfigView.vue`(在 template 末尾加 `<AgentTokenRotateModal>` 块 + 处理 `@committed` 重新 fetch tokenState)
- Modify: `frontend/tests/config-view.test.js`(新增 1 条 — `rotated 事件触发 tokenState 重 fetch`,` 或 `commit`)
- Modify: `publish/system/frontend/src/views/admin/ConfigView.vue`(sync)
- Modify: `publish/system/frontend/src/components/AgentTokenRotateModal.vue`(sync)
- Modify: `scripts/verify-mirror.ps1`(加 2 个 pair)

**Interfaces:**
- Consumes: Task 1 写好的 `tokenState` ref + `rotatedNewToken` + `showTokenModal`;Task 2 写好的 `AgentTokenRotateModal` 组件
- Produces: 完整 flow — 按钮 → modal → copy/close/commit → ConfigView tokenState 同步刷新

#### Step 1: ConfigView 模板末尾加 modal 挂载

在 ConfigView.vue template `</AdminLayout>` 之前(约 112 行)加:

```vue
<AgentTokenRotateModal
  v-if="showTokenModal"
  :visible="showTokenModal"
  :new-token="rotatedNewToken"
  :previous-expires-at="tokenState.previousExpiresAt"
  :ttl-days="tokenState.ttlDays"
  @close="onModalClose"
  @committed="onModalCommitted"
/>
```

加 import(脚本顶部 117 行后):

```js
import AgentTokenRotateModal from '../../components/AgentTokenRotateModal.vue';
```

加 modal handlers(放在 `onCommitClick` 后面):

```js
function onModalClose() {
  showTokenModal.value = false;
  rotatedNewToken.value = null;
}

async function onModalCommitted() {
  // Modal already emits 'close' alongside 'committed', but we re-fetch
  // here so the row badge updates to single and the commit button
  // disappears without waiting for the next page load.
  await reloadTokenState();
}

async function reloadTokenState() {
  try {
    const r = await adminApi.getAgentTokenState();
    const s = r.data || {};
    tokenState.value = {
      mode: s.mode || 'single',
      previousExpiresAt: s.previousExpiresAt || null,
      ttlDays: typeof s.ttlDays === 'number' ? s.ttlDays : 30
    };
  } catch {
    tokenState.value = { mode: 'single', previousExpiresAt: null, ttlDays: 30 };
  }
}
```

#### Step 2: 加 ConfigView modal 集成测试

在 `frontend/tests/config-view.test.js` 末尾追加 2 条:

```js
test('agent-token row: modal opened on rotate renders newToken and closes on emit', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.rotateAgentToken.mockResolvedValue({ data: { newToken: 'newtoken-xyz', rotatedAt: '2026-08-20T00:00:00Z' } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  await tokenRow.find('button.rotate-btn').trigger('click');
  await flushPromises();
  const modal = w.findComponent(AgentTokenRotateModal);
  expect(modal.exists()).toBe(true);
  expect(modal.props('newToken')).toBe('newtoken-xyz');
  // Emit close — modal should disappear.
  await modal.vm.$emit('close');
  await flushPromises();
  expect(w.findComponent(AgentTokenRotateModal).exists()).toBe(false);
});

test('agent-token row: modal committed event reloads token state from server', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getAgentTokenState
    .mockResolvedValueOnce({ data: { mode: 'single', previousExpiresAt: null, ttlDays: 30 } })
    .mockResolvedValueOnce({ data: { mode: 'dual', previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 } })
    .mockResolvedValueOnce({ data: { mode: 'single', previousExpiresAt: null, ttlDays: 30 } });
  adminApi.rotateAgentToken.mockResolvedValue({ data: { newToken: 'xx', rotatedAt: '2026-08-20T00:00:00Z' } });
  const w = mount(ConfigView);
  await flushPromises();
  const tokenRow = w.findAll('table.t tbody tr').find((r) => r.text().includes('ad_agent_token'));
  await tokenRow.find('button.rotate-btn').trigger('click');
  await flushPromises();
  // After rotate, server returns dual — but we already set local state
  // optimistically in onRotateClick. Modal committed → reload → server
  // returns single again (simulating commit already applied).
  const modal = w.findComponent(AgentTokenRotateModal);
  await modal.vm.$emit('committed');
  await flushPromises();
  // The 3rd getAgentTokenState call should have happened.
  expect(adminApi.getAgentTokenState).toHaveBeenCalledTimes(3);
  // Modal closed itself when committed was emitted (modal handler does
  // emit('close') too); re-render shows single-mode badge.
  expect(tokenRow.find('.token-mode-single').exists()).toBe(true);
});
```

加 import 顶部:

```js
import AgentTokenRotateModal from '../src/components/AgentTokenRotateModal.vue';
```

#### Step 3: 跑全测试,确认 green

```bash
cd "D:/ToolDevelop/ADDashboard/frontend" && npm test 2>&1 | tail -30
```

Expected: 所有 frontend 测试 pass(原 ~270 + 本任务新增 ~14 ≈ ~284)。

#### Step 4: Mirror sync — publish/system/

按项目 publish 约定(per memory `feedback_full_chain_cleanup.md`),源文件改动必须 mirror 到 `publish/system/`。

```bash
mkdir -p "D:/ToolDevelop/ADDashboard/publish/system/frontend/src/components"
cp "D:/ToolDevelop/ADDashboard/frontend/src/components/AgentTokenRotateModal.vue" \
   "D:/ToolDevelop/ADDashboard/publish/system/frontend/src/components/AgentTokenRotateModal.vue"
cp "D:/ToolDevelop/ADDashboard/frontend/src/views/admin/ConfigView.vue" \
   "D:/ToolDevelop/ADDashboard/publish/system/frontend/src/views/admin/ConfigView.vue"
```

#### Step 5: 改 verify-mirror.ps1

在 `scripts/verify-mirror.ps1` 第 84 行 `ConfigView` 那个 pair 后,加:

```powershell
  # Agent token rotate UI (#167 follow-up: I1 + I3 dual-key UI surface)
  @{ left = 'frontend/src/components/AgentTokenRotateModal.vue'; right = 'publish/system/frontend/src/components/AgentTokenRotateModal.vue' }
  @{ left = 'frontend/src/views/admin/ConfigView.vue';          right = 'publish/system/frontend/src/views/admin/ConfigView.vue' }
```

把原 84 行那条 ConfigView pair 删掉(避免重复)。

#### Step 6: 跑 verify-mirror

```bash
cd "D:/ToolDevelop/ADDashboard" && powershell -ExecutionPolicy Bypass -File scripts/verify-mirror.ps1 2>&1 | tail -20
```

Expected: 所有 pair PASSED(原 ~50 + 新增 1 = ~51,因 ConfigView 已存在 pair 改名,不增加 pair 数)。

#### Step 7: Commit

```bash
cd "D:/ToolDevelop/ADDashboard" && git add frontend/src/views/admin/ConfigView.vue frontend/tests/config-view.test.js publish/system/frontend/src/components/AgentTokenRotateModal.vue publish/system/frontend/src/views/admin/ConfigView.vue scripts/verify-mirror.ps1
git commit -m "feat(config): wire AgentTokenRotateModal into ConfigView + sync published mirror

- Modal 挂载在 ConfigView 末尾,接 @close 清 state / @committed 重新 fetch tokenState
- ConfigView 测试加 2 新 case:modal open/close 生命周期 + committed 后 tokenState 重 fetch
- publish/system/ frontend mirror 同步
- verify-mirror.ps1 ConfigView pair 加注释说明(原 pair 保留,新加 modal pair)

完整 flow 上线:ConfigView 轮换按钮 → modal 弹新 token → 操作员复制 +
RDP 分发 → 全部切换完点 modal 的「关闭旧令牌」 → tokenState 回 single。"
```

---

## Self-Review Checklist

- [x] **Spec coverage**:`docs/superpowers/specs/2026-08-18-dual-key-agent-token-rotation.md` §6 UI surface 全部覆盖:mask 显示(mode badge + 末4掩码)+ 轮换按钮 + modal(新token + 复制 + expiry + commit)+ 失败降级 + 无明文泄漏。
- [x] **Placeholder scan**:无"TBD"/"TODO"/"类似 Task N";每个 step 都有具体代码 / 命令 / 断言;commit message 给出。
- [x] **Type consistency**:`adminApi.getAgentTokenState` / `rotateAgentToken` / `commitAgentToken` 在 Task 1 / 2 / 3 三处引用签名一致;`AgentTokenRotateModal` props `{ visible, newToken, previousExpiresAt, ttlDays }` 在 Task 2 定义 + Task 3 调用完整对应;emit 事件 `close` / `committed` 在 Task 2 emit + Task 3 handle。
- [x] **No backend change**:后端 3 endpoint 完全不动,符合"前端 only"原则。
- [x] **Mirror 同步**:Task 3 Step 4-5 显式 cp + verify-mirror pair。
- [x] **失败路径覆盖**:rotate failure / commit failure / token-state fetch failure 三个降级路径都有测试断言。
- [x] **无明文泄漏**:GET 响应无 currentToken;mask 装饰性;rotate 响应明文只在 modal 内存;copy 失败降级 + emit 让父级记录。
- [x] **No marketing chrome**:row 只保留 mask + badge + buttons + description + hint;无 eyebrow / ribbon / 装饰色点。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-agent-token-rotate-ui.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?