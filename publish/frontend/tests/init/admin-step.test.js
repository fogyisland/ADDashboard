import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminStep from '../../src/views/init/AdminStep.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('AdminStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders username/password/confirm fields', () => {
    const w = mount(AdminStep);
    const inputs = w.findAll('input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);
  });

  it('next button disabled when password is short', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'short', confirm: 'short' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeDefined();
  });

  it('next button disabled when passwords do not match', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'different' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeDefined();
  });

  it('next button enabled when fields valid', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeUndefined();
  });
});
