import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import InitWizardView from '../../src/views/init/InitWizardView.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('InitWizardView', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders the stepper with 3 steps', () => {
    const w = mount(InitWizardView);
    const items = w.findAll('.stepper li');
    expect(items.length).toBe(3);
  });

  it('shows DbConnStep at step 1', () => {
    const w = mount(InitWizardView);
    expect(w.text()).toMatch(/数据库连接|database/i);
  });

  it('shows AdminStep at step 2', async () => {
    const s = useInitStore();
    s.next();
    const w = mount(InitWizardView);
    expect(w.text()).toMatch(/管理员|admin/i);
  });
});