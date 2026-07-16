import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentStatusTable from '../src/components/AgentStatusTable.vue';

test('AgentStatusTable marks agent with secondsSinceHeartbeat=60 as 在线 with ok badge', () => {
  const wrapper = mount(AgentStatusTable, {
    props: {
      rows: [{
        agentId: 'A1',
        lastHeartbeatAt: '2026-07-10T08:00:00Z',
        agentVersion: '1.0.0',
        lastReportAt: '2026-07-10T08:00:00Z',
        lastReportStatus: 'ok',
        pendingQueueSize: 0,
        secondsSinceHeartbeat: 60
      }]
    }
  });
  expect(wrapper.text()).toContain('在线');
  const badge = wrapper.find('span');
  expect(badge.classes()).toContain('ok');
});

test('AgentStatusTable marks agent with secondsSinceHeartbeat=200 as 离线 with stale badge', () => {
  const wrapper = mount(AgentStatusTable, {
    props: {
      rows: [{
        agentId: 'A2',
        lastHeartbeatAt: '2026-07-10T07:55:00Z',
        agentVersion: '1.0.0',
        lastReportAt: '2026-07-10T07:55:00Z',
        lastReportStatus: 'ok',
        pendingQueueSize: 5,
        secondsSinceHeartbeat: 200
      }]
    }
  });
  expect(wrapper.text()).toContain('离线');
  const badge = wrapper.find('span');
  expect(badge.classes()).toContain('stale');
});

test('AgentStatusTable renders two rows when given two agents', () => {
  const wrapper = mount(AgentStatusTable, {
    props: {
      rows: [
        {
          agentId: 'A1',
          lastHeartbeatAt: '2026-07-10T08:00:00Z',
          agentVersion: '1.0.0',
          lastReportAt: '2026-07-10T08:00:00Z',
          lastReportStatus: 'ok',
          pendingQueueSize: 0,
          secondsSinceHeartbeat: 30
        },
        {
          agentId: 'A2',
          lastHeartbeatAt: '2026-07-10T07:55:00Z',
          agentVersion: '1.0.0',
          lastReportAt: '2026-07-10T07:55:00Z',
          lastReportStatus: 'ok',
          pendingQueueSize: 5,
          secondsSinceHeartbeat: 300
        }
      ]
    }
  });
  const trs = wrapper.findAll('tbody tr');
  expect(trs).toHaveLength(2);
});
