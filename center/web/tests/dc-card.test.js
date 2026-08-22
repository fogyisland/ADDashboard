import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import DcCard from '../src/components/DcCard.vue';

function makeDc(over = {}) {
  return {
    dcHost: 'DC01',
    siteName: 'SiteA',
    partnersCount: 3,
    usersCount: 100,
    groupsCount: 30,
    gposCount: 5,
    lockedCount: 2,
    collectedAt: '2026-08-06T10:00:00.000Z',
    ...over
  };
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/lockout-troubleshooting', component: { template: '<div/>' } },
      { path: '/', component: { template: '<div/>' } }
    ]
  });
}

test('DcCard renders hostname, site badge, and all 5 stat tiles with raw keys', () => {
  const w = mount(DcCard, { props: { dc: makeDc() }, global: { plugins: [makeRouter()] } });
  expect(w.find('h3').text()).toBe('DC01');
  expect(w.text()).toContain('SiteA');
  // 5 tiles in order: 复制伙伴, 用户, 组, GPO, 锁定
  const tiles = w.findAll('.stat-tile');
  expect(tiles.length).toBe(5);
  // Raw keys are visible
  expect(w.text()).toContain('partnersCount');
  expect(w.text()).toContain('usersCount');
  expect(w.text()).toContain('groupsCount');
  expect(w.text()).toContain('gposCount');
  expect(w.text()).toContain('lockedCount');
  // Counts visible
  expect(w.text()).toContain('3');   // partners
  expect(w.text()).toContain('100'); // users
  expect(w.text()).toContain('30');  // groups
  expect(w.text()).toContain('5');   // GPOs
  expect(w.text()).toContain('2');   // locked
});

test('DcCard locked tile is a router-link to /lockout-troubleshooting?dc=DC01 when lockedCount > 0', async () => {
  const w = mount(DcCard, { props: { dc: makeDc({ lockedCount: 2 }) }, global: { plugins: [makeRouter()] } });
  const lockedTile = w.findAll('.stat-tile').find(t => /lockedCount/.test(t.text()));
  expect(lockedTile).toBeTruthy();
  expect(lockedTile.classes()).toContain('locked-active');
  const link = lockedTile.find('a');
  expect(link.exists()).toBe(true);
  expect(link.attributes('href')).toBe('/lockout-troubleshooting?dc=DC01');
});

test('DcCard locked tile shows "—" and is NOT clickable when lockedCount is null', () => {
  const w = mount(DcCard, { props: { dc: makeDc({ lockedCount: null }) }, global: { plugins: [makeRouter()] } });
  const lockedTile = w.findAll('.stat-tile').find(t => /lockedCount/.test(t.text()));
  expect(lockedTile.exists()).toBe(true);
  expect(lockedTile.find('a').exists()).toBe(false);
  expect(lockedTile.text()).toContain('—');
  expect(lockedTile.classes()).toContain('locked-unknown');
});
