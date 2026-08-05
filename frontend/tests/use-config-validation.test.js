import { test, expect } from 'vitest';
import { useConfigValidation } from '../src/composables/useConfigValidation.js';

test('all fields valid: empty errors', () => {
  const { errors, validate } = useConfigValidation();
  validate({
    polling_interval_minutes: '5',
    latency_threshold_minutes: '60',
    heartbeat_interval_seconds: '10',
    history_enabled: '1',
    ad_agent_token: 'long-enough-token-12345'
  });
  expect(errors.value).toEqual({});
});

test('polling_interval_minutes below 1', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '0', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.polling_interval_minutes).toMatch(/1-1440/);
});

test('polling_interval_minutes above 1440', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '9999', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.polling_interval_minutes).toMatch(/1-1440/);
});

test('polling_interval_minutes non-numeric', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: 'abc', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.polling_interval_minutes).toBeTruthy();
});

test('latency_threshold_minutes boundary 1 accepted, 10080 accepted, 0 rejected, 10081 rejected', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '5', latency_threshold_minutes: '1', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.latency_threshold_minutes).toBeUndefined();
  validate({ ...{}, latency_threshold_minutes: '10080' });
  expect(errors.value.latency_threshold_minutes).toBeUndefined();
  validate({ ...{}, latency_threshold_minutes: '0' });
  expect(errors.value.latency_threshold_minutes).toBeTruthy();
  validate({ ...{}, latency_threshold_minutes: '10081' });
  expect(errors.value.latency_threshold_minutes).toBeTruthy();
});

test('heartbeat_interval_seconds boundary 1-300', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '5', latency_threshold_minutes: '60', heartbeat_interval_seconds: '0', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.heartbeat_interval_seconds).toBeTruthy();
  validate({ ...{}, heartbeat_interval_seconds: '301' });
  expect(errors.value.heartbeat_interval_seconds).toBeTruthy();
});

test('history_enabled must be 0 or 1', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '5', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '2', ad_agent_token: 'long-enough-token-12345' });
  expect(errors.value.history_enabled).toBeTruthy();
  validate({ ...{}, history_enabled: '0' });
  expect(errors.value.history_enabled).toBeUndefined();
  validate({ ...{}, history_enabled: '1' });
  expect(errors.value.history_enabled).toBeUndefined();
});

test('ad_agent_token too short', () => {
  const { errors, validate } = useConfigValidation();
  validate({ polling_interval_minutes: '5', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'short' });
  expect(errors.value.ad_agent_token).toMatch(/16/);
});

test('hasErrors reflects errors count', () => {
  const { errors, hasErrors, validate, clear } = useConfigValidation();
  expect(hasErrors.value).toBe(false);
  validate({ polling_interval_minutes: 'abc', latency_threshold_minutes: '60', heartbeat_interval_seconds: '5', history_enabled: '1', ad_agent_token: 'long-enough-token-12345' });
  expect(hasErrors.value).toBe(true);
  clear();
  expect(hasErrors.value).toBe(false);
});