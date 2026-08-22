import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ErrorTable from '../src/components/ErrorTable.vue';

test('ErrorTable explains statusCode 1722 with RPC 服务器不可用', () => {
  const wrapper = mount(ErrorTable, {
    props: {
      rows: [{
        sourceDc: 'DC1',
        destDc: 'DC2',
        sourceSite: 'SiteA',
        destSite: 'SiteB',
        namingContext: 'DC=corp,DC=local',
        statusCode: 1722,
        lastAttemptTime: '2026-07-10T08:00:00Z',
        durationMinutes: 5
      }]
    }
  });
  expect(wrapper.text()).toContain('RPC 服务器不可用');
});

test('ErrorTable falls back to "参见 Windows 错误码参考" for unknown code', () => {
  const wrapper = mount(ErrorTable, {
    props: {
      rows: [{
        sourceDc: 'DC1',
        destDc: 'DC2',
        sourceSite: 'SiteA',
        destSite: 'SiteB',
        namingContext: 'DC=corp,DC=local',
        statusCode: 9999,
        lastAttemptTime: null,
        durationMinutes: null
      }]
    }
  });
  expect(wrapper.text()).toContain('参见 Windows 错误码参考');
});

test('ErrorTable explains statusCode 5 with 访问被拒绝', () => {
  const wrapper = mount(ErrorTable, {
    props: {
      rows: [{
        sourceDc: 'DC1',
        destDc: 'DC2',
        sourceSite: 'SiteA',
        destSite: 'SiteB',
        namingContext: 'DC=corp,DC=local',
        statusCode: 5,
        lastAttemptTime: '2026-07-10T08:00:00Z',
        durationMinutes: 30
      }]
    }
  });
  expect(wrapper.text()).toContain('访问被拒绝');
});
