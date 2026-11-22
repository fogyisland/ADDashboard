<!--
  ExecuteCommandModal.vue — 成员服务器「动作」弹窗.

  2026-09-05 R81 — 初版: 自由 PowerShell 编辑器 + 超时选择 + 提交.
  ★ R161.35 第 2 步 (2026-11-22) — **重写为动作表单**:
    中心不再接受脚本文本. 操作员只能从密封清单里选一个 scriptId,
    再填它的结构化参数. 代码 = 随 agent 发版的 .ps1 (带 sha256 封印),
    数据 = 经过 schema 校验的 JSON 参数 —— 两者在 wire 上永远分离.

  Fields:
    hostname (required, prop, read-only here)
    scriptId (required, 来自 GET /api/admin/member-commands/actions)
    args     (per-action, 由 actions[].args 的 schema 动态渲染)

  data-test contract:
    exec-modal            — modal root
    exec-hostname         — host preview banner
    exec-script           — 动作下拉框 (原名保留, 供旧测试/脚本定位)
    exec-args             — 参数表单容器
    exec-arg-<name>       — 单个参数输入
    exec-force            — 跳过在线检查 checkbox
    exec-submit           — submit button
    exec-cancel           — cancel button
    exec-progress         — in-flight banner
    exec-result           — terminal success/failure banner
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="exec-modal">
      <header><h3>成员服务器动作</h3></header>
      <section class="form-body">
        <div class="host-banner">
          <span class="label">目标主机</span>
          <code class="hostname" data-test="exec-hostname">{{ props.hostname }}</code>
        </div>

        <label class="field">
          <span class="label">动作 <em>*</em></span>
          <select
            data-test="exec-script"
            v-model="form.scriptId"
            :disabled="submitting || isLoadingActions"
            @change="onActionChange"
          >
            <option value="" disabled>{{ isLoadingActions ? '加载动作清单…' : '— 请选择 —' }}</option>
            <option v-for="a in actions" :key="a.scriptId" :value="a.scriptId">
              {{ a.label }} ({{ a.scriptId }} · 超时 {{ a.timeoutSec }}s)
            </option>
          </select>
          <small class="size-hint">
            可用动作由 agent 随版本发布, 此处只能选择, 不能输入代码.
          </small>
        </label>

        <div v-if="selectedAction" class="args-box" data-test="exec-args">
          <div
            v-for="spec in selectedAction.args"
            :key="spec.name"
            class="field arg-field"
          >
            <span class="label">
              {{ spec.label }}
              <em v-if="!spec.optional">*</em>
            </span>

            <select
              v-if="spec.type === 'enum'"
              :data-test="`exec-arg-${spec.name}`"
              v-model="form.args[spec.name]"
              :disabled="submitting"
            >
              <option value="" disabled>— 请选择 —</option>
              <option v-for="v in spec.values" :key="v" :value="v">{{ v }}</option>
            </select>

            <label v-else-if="spec.type === 'bool'" class="checkbox-field">
              <input
                type="checkbox"
                :data-test="`exec-arg-${spec.name}`"
                v-model="form.args[spec.name]"
                :disabled="submitting"
              />
              <span>{{ spec.label }}</span>
            </label>

            <input
              v-else-if="spec.type === 'int'"
              type="number"
              :min="spec.min ?? undefined"
              :max="spec.max ?? undefined"
              :data-test="`exec-arg-${spec.name}`"
              v-model.number="form.args[spec.name]"
              :disabled="submitting"
            />

            <input
              v-else
              type="text"
              :maxlength="spec.maxLen ?? undefined"
              :data-test="`exec-arg-${spec.name}`"
              v-model="form.args[spec.name]"
              :disabled="submitting"
            />

            <small v-if="spec.type === 'string' && spec.maxLen" class="size-hint">
              最多 {{ spec.maxLen }} 字符
            </small>
          </div>
        </div>

        <label class="field checkbox-field">
          <input
            type="checkbox"
            data-test="exec-force"
            v-model="form.force"
            :disabled="submitting"
          />
          <span>跳过在线检查 (目标主机心跳 ≥ 5 分钟内仍可执行)</span>
        </label>

        <p v-if="actionsError" class="error">{{ actionsError }}</p>
        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting" class="hint" data-test="exec-progress">
          命令已发送到 {{ props.hostname }} · 命令 ID #{{ activeCommand?.id }} · 等待结果…
        </p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="exec-result">
          {{ resultMessage }}
        </p>
      </section>
      <footer>
        <button type="button" data-test="exec-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="exec-submit"
          class="primary"
          @click="submit"
          :disabled="submitting || !canSubmit"
        >提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, watch } from 'vue';
import { memberCommandsApi } from '../../api/member-commands.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';

const props = defineProps({
  hostname: { type: String, required: true }
});
const emit = defineEmits(['close', 'submitted']);

const actions = ref([]);
const isLoadingActions = ref(false);
const actionsError = ref('');

const form = reactive({
  scriptId: '',
  args: {},
  force: false
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

const selectedAction = computed(() =>
  actions.value.find((a) => a.scriptId === form.scriptId) || null
);

// 本地先校验一遍, 让操作员在点提交前就看到问题. **权威校验在服务端**
// (member-commands.js:validateMemberAction → member-scripts-manifest.js:
// validateArgs); 这里只是 UX 提速, 不做安全判断.
const canSubmit = computed(() => {
  if (submitting.value || !selectedAction.value) return false;
  for (const spec of selectedAction.value.args) {
    const raw = form.args[spec.name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing && !spec.optional) return false;
    if (!missing && spec.type === 'int' && !Number.isInteger(Number(raw))) return false;
  }
  return true;
});

function buildDefaultArg(spec) {
  if (spec.type === 'bool') return false;
  if (spec.type === 'int') return spec.min ?? null;
  return '';
}

function onActionChange() {
  // 切换动作时重建参数对象: 上一个动作遗留的键会被服务端当作 unknown arg
  // 拒绝, 留着只会制造一个看不懂的 400.
  const next = {};
  if (selectedAction.value) {
    for (const spec of selectedAction.value.args) next[spec.name] = buildDefaultArg(spec);
  }
  form.args = next;
  formError.value = '';
}

function validateLocal() {
  if (!selectedAction.value) return '请选择动作';
  for (const spec of selectedAction.value.args) {
    const raw = form.args[spec.name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (spec.optional) continue;
      return `${spec.label} 必填`;
    }
    if (spec.type === 'string' && /[\x00-\x1f\x7f]/.test(String(raw))) {
      return `${spec.label} 含控制字符`;
    }
    if (spec.type === 'string' && spec.pattern && !new RegExp(spec.pattern).test(String(raw))) {
      return `${spec.label} 格式不正确`;
    }
    if (spec.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) return `${spec.label} 必须是整数`;
      if (spec.min != null && n < spec.min) return `${spec.label} 不能小于 ${spec.min}`;
      if (spec.max != null && n > spec.max) return `${spec.label} 不能大于 ${spec.max}`;
    }
    if (spec.type === 'enum' && !spec.values.includes(raw)) {
      return `${spec.label} 必须是 ${spec.values.join(' / ')} 之一`;
    }
  }
  return null;
}

const polling = useCommandPolling(null, {
  intervalMs: 1500,
  timeoutMs: 35_000,
  // 2026-09-05 R81: inject memberCommandsApi.getCommand so the composable
  // doesn't fall through to the R75 ad-admin default (which would hit
  // a different endpoint /api/admin/ad-commands/:id).
  fetcher: async (id) => {
    const r = await memberCommandsApi.getCommand(id);
    return r.data || null;
  }
});
watch(polling.timedOut, (v) => { if (v) timedOut.value = true; });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    const dur = r.result?.durationMs != null ? `${r.result.durationMs}ms` : '?';
    resultMessage.value = `执行成功 · 退出码 ${r.exitCode ?? 0} · ${dur}`;
    resultOk.value = true;
    submitting.value = false;
    emit('submitted', r);
  } else {
    resultMessage.value = r.errorMessage || `命令${r.status}`;
    resultOk.value = false;
    submitting.value = false;
  }
});

async function loadActions() {
  isLoadingActions.value = true;
  actionsError.value = '';
  try {
    const r = await memberCommandsApi.listActions();
    const list = Array.isArray(r.data?.actions) ? r.data.actions : [];
    actions.value = list;
    // 只有一个动作时直接选中, 省一次点击.
    if (list.length === 1) {
      form.scriptId = list[0].scriptId;
      onActionChange();
    }
  } catch (e) {
    actionsError.value = `动作清单加载失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  } finally {
    isLoadingActions.value = false;
  }
}

onMounted(loadActions);

async function submit() {
  formError.value = '';
  const v = validateLocal();
  if (v) { formError.value = v; return; }
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    // ★ 只发 schema 里声明过的参数; bool 型未勾选时也显式发 false,
    //   否则服务端会把它当作"未提供"(optional) 而不是 false.
    const args = {};
    for (const spec of selectedAction.value.args) {
      const raw = form.args[spec.name];
      if (spec.type === 'bool') args[spec.name] = !!raw;
      else if (raw !== undefined && raw !== null && raw !== '') args[spec.name] = raw;
    }
    const resp = await memberCommandsApi.queueCommand({
      hostname: props.hostname,
      commandType: 'member_action',
      params: { scriptId: form.scriptId, args },
      // `force` rides the query string, not params (R161.35 第 1 步修复).
      force: form.force
    });
    activeCommand.value = resp.data;
    polling.start(resp.data);
  } catch (e) {
    formError.value = e?.response?.data?.error || e?.message || '提交失败';
    submitting.value = false;
  }
}

function cancel() {
  polling.stop();
  emit('close');
}
</script>

<style scoped>
.modal-bg {
  position: fixed; inset: 0; background: var(--modal-backdrop);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  min-width: 560px; max-width: 760px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }

.host-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--input-bg); border: 1px solid var(--border);
  border-radius: 3px;
}
.host-banner .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.host-banner .hostname {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--accent); font-size: 13px; font-weight: 600;
}

.args-box {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 12px; border: 1px dashed var(--border); border-radius: 3px;
}
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input, .field select, .field textarea {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 5px 8px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.field input:focus, .field select:focus, .field textarea:focus {
  outline: 2px solid var(--accent); border-color: var(--accent);
}
.field input:disabled, .field select:disabled, .field textarea:disabled { opacity: 0.6; }

.checkbox-field { flex-direction: row; align-items: center; gap: 8px; min-width: 280px; }
.checkbox-field span { font-size: 12px; color: var(--text); }

.size-hint { font-size: 11px; color: var(--muted); margin-top: 2px; }

.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error {
  background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--status-pill-fg-err);
  padding: 6px 10px; border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent);
  font-size: 12px; margin: 0;
}
.result.ok { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--status-pill-fg-ok); padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--status-pill-fg-err); padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }

.modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid var(--border);
}
.modal footer button {
  padding: 6px 14px; border: 1px solid var(--border);
  background: var(--input-bg); color: var(--text); border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.modal footer button.primary { background: var(--accent); color: var(--sidebar-bg); border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
