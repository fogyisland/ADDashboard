import { ref, computed } from 'vue';

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
  // #167 I1: ad_agent_token validation rule removed — the field is now
  // a read-only notice-row; backend rejects writes with 400.
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
