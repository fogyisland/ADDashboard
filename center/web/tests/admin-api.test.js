import { test, expect, vi, describe, beforeEach } from 'vitest';

vi.mock('../src/api/client.js', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} }))
  }
}));

import api from '../src/api/client.js';
import { adminApi } from '../src/api/admin.js';

describe('adminApi surface', () => {
  beforeEach(() => {
    api.get.mockClear();
    api.post.mockClear();
    api.put.mockClear();
    api.delete.mockClear();
  });

  test('adminApi is an object with all expected keys', () => {
    expect(typeof adminApi).toBe('object');
    expect(adminApi).not.toBeNull();
    const keys = ['listUsers', 'createUser', 'updateUser', 'deleteUser', 'listRoles', 'getConfig', 'updateConfig', 'getAudit', 'getAuditBadge', 'exportAudit'];
    for (const k of keys) {
      expect(adminApi).toHaveProperty(k);
      expect(typeof adminApi[k]).toBe('function');
    }
  });

  test('getAudit({category,size}) calls api.get with /api/admin/audit?category=&page=1&size=100', async () => {
    await adminApi.getAudit({ category: 'security', size: 100 });
    expect(api.get).toHaveBeenCalledWith('/api/admin/audit?category=security&page=1&size=100');
  });

  test('updateUser(7, {roleId: 2, status: 1}) calls api.put with /api/admin/users/7 and the body', async () => {
    await adminApi.updateUser(7, { roleId: 2, status: 1 });
    expect(api.put).toHaveBeenCalledWith('/api/admin/users/7', { roleId: 2, status: 1 });
  });

  test('listRoles hits /api/admin/roles', async () => {
    await adminApi.listRoles();
    expect(api.get).toHaveBeenCalledWith('/api/admin/roles');
  });

  test('getConfig hits /api/admin/config', async () => {
    await adminApi.getConfig();
    expect(api.get).toHaveBeenCalledWith('/api/admin/config');
  });
});