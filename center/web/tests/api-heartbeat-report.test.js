import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

vi.mock('../src/api/client.js', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} }))
  }
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

test('requestReport calls api.post on /api/admin/agents/:id/request-report', async () => {
  await heartbeatReportApi.requestReport('agent-online');
  expect(api.post).toHaveBeenCalledWith('/api/admin/agents/agent-online/request-report');
});

test('deleteAgent calls api.delete on /api/admin/heartbeat-report/agents/:id', async () => {
  await heartbeatReportApi.deleteAgent('agent-online');
  expect(api.delete).toHaveBeenCalledWith('/api/admin/heartbeat-report/agents/agent-online');
});

test('deleteDc calls api.delete on /api/admin/heartbeat-report/dcs/:dcName', async () => {
  await heartbeatReportApi.deleteDc('dc01');
  expect(api.delete).toHaveBeenCalledWith('/api/admin/heartbeat-report/dcs/dc01');
});

test('deleteAgent URL-encodes the agentId', async () => {
  await heartbeatReportApi.deleteAgent('MOCK NC srv/01');
  expect(api.delete).toHaveBeenCalledWith('/api/admin/heartbeat-report/agents/MOCK%20NC%20srv%2F01');
});
