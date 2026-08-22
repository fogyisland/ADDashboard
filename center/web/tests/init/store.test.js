import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useInitStore } from '../../src/stores/init.js';

describe('init store', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('starts at step 1', () => {
    const s = useInitStore();
    expect(s.currentStep).toBe(1);
  });

  it('setDialect updates dialect and connParams defaults', () => {
    const s = useInitStore();
    s.setDialect('mysql');
    expect(s.dialect).toBe('mysql');
    expect(s.connParams.host).toBe('127.0.0.1');
    expect(s.connParams.port).toBe(3306);
    expect(s.connParams.user).toBe('root');
  });

  it('setDialect mssql sets server + sa defaults', () => {
    const s = useInitStore();
    s.setDialect('mssql');
    expect(s.dialect).toBe('mssql');
    expect(s.connParams.server).toBe('');
    expect(s.connParams.port).toBe(1433);
    expect(s.connParams.user).toBe('sa');
  });

  it('next advances step; prev decrements', () => {
    const s = useInitStore();
    s.next();
    expect(s.currentStep).toBe(2);
    s.next();
    expect(s.currentStep).toBe(3);
    s.prev();
    expect(s.currentStep).toBe(2);
  });

  it('reset clears all state', () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ host: 'x' });
    s.reset();
    expect(s.currentStep).toBe(1);
    expect(s.dialect).toBeNull();
    expect(s.connParams).toEqual({});
  });
});