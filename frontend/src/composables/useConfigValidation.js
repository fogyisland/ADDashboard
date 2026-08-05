import { ref, computed } from 'vue';

const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

const RULES = {
  polling_interval_minutes: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1440) return '采集周期必须在 1-1440 分钟之间';
    return null;
  },
  latency_threshold_minutes: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10080) return '延迟阈值必须在 1-10080 分钟之间';
    return null;
  },
  heartbeat_interval_seconds: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 300) return '心跳间隔必须在 1-300 秒之间';
    return null;
  },
  history_enabled: (v) => (v === '0' || v === '1') ? null : '只能填 0 或 1',
  ad_agent_token: (v) => (v && String(v).length >= 16) ? null : 'Token 至少 16 字符',
  center_public_host: (v) => {
    if (!v || typeof v !== 'string' || !v.trim()) return '主机名不合法';
    const s = v.trim();
    if (IPV4_RE.test(s)) {
      const parts = s.split('.').map(Number);
      if (parts.some((p) => p < 0 || p > 255)) return '主机名不合法';
      return null;
    }
    if (HOST_RE.test(s)) return null;
    return '主机名不合法';
  },
  center_public_port: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) return '端口必须在 1-65535 之间';
    return null;
  }
};

export function useConfigValidation(initialErrors = {}) {
  const errors = ref({ ...initialErrors });
  function validate(values) {
    const next = {};
    for (const [k, rule] of Object.entries(RULES)) {
      const msg = rule(values[k]);
      if (msg) next[k] = msg;
    }
    errors.value = next;
  }
  function clear() { errors.value = {}; }
  const hasErrors = computed(() => Object.keys(errors.value).length > 0);
  return { errors, validate, clear, hasErrors };
}