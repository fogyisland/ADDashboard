import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

vi.mock('../src/api/client.js', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: {} })) }
}));

test('listAgents calls api.get on /api/admin/heartbeat-report/agents', async () => {
  await heartbeatReportApi.listAgents();
  expect(api.get).toHaveBeenCalledWith('/api/admin/heartbeat-report/agents');
});

test('listDcs calls api.get on /api/admin/heartbeat-report/dcs', async () => {
  await heartbeatReportApi.listDcs();
  expect(api.get).toHaveBeenCalledWith('/api/admin/heartbeat-report/dcs');
});

test('getDetail URL-encodes the agentId', async () => {
  await heartbeatReportApi.getDetail('DC with space/01');
  expect(api.get).toHaveBeenCalledWith('/api/admin/heartbeat-report/agents/DC%20with%20space%2F01/report-detail');
});
