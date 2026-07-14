import { defineStore } from 'pinia';
import * as initApi from '../api/init.js';
import { resetInitStatusCache } from '../router.js';

const DEFAULTS = {
  mysql: { host: '127.0.0.1', port: 3306, database: '', user: 'root', password: '' },
  mssql: { server: '', port: 1433, database: '', user: 'sa', password: '', encrypt: false, trustServerCert: true }
};

export const useInitStore = defineStore('init', {
  state: () => ({
    currentStep: 1,
    dialect: null,           // 'mysql' | 'mssql' | null
    connParams: {},          // {host|server, port, database, user, password, ...}
    admin: { username: 'admin', password: '', confirm: '' },
    dbTestResult: null,      // {ok, error?}
    initStatus: null,        // {needsInit, dialect?}
    applyProgress: null,     // {schema, seed, migrations} | null
    applyError: null,
    adminError: null,
    finalizeError: null
  }),
  actions: {
    async loadStatus() {
      const r = await initApi.getStatus();
      this.initStatus = r.data;
      return r.data;
    },
    setDialect(d) {
      this.dialect = d;
      this.connParams = { ...DEFAULTS[d] };
      this.dbTestResult = null;
    },
    setConnParams(p) { this.connParams = { ...this.connParams, ...p }; this.dbTestResult = null; },
    setAdmin(a) { this.admin = { ...this.admin, ...a }; },
    async testDb() {
      this.dbTestResult = null;
      const r = await initApi.testDb({ dialect: this.dialect, ...this.connParams });
      this.dbTestResult = r.data;
      return r.data;
    },
    next() { if (this.currentStep < 3) this.currentStep++; },
    prev() { if (this.currentStep > 1) this.currentStep--; },
    async applyDb(createDatabase = false) {
      this.applyError = null;
      try {
        const r = await initApi.applyDb({ dialect: this.dialect, connParams: this.connParams, createDatabase });
        this.applyProgress = r.data;
        return r.data;
      } catch (e) {
        this.applyError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    async createAdmin() {
      this.adminError = null;
      try {
        const r = await initApi.createAdmin({
          dialect: this.dialect, connParams: this.connParams,
          username: this.admin.username, password: this.admin.password
        });
        return r.data;
      } catch (e) {
        this.adminError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    async finalize() {
      this.finalizeError = null;
      try {
        const r = await initApi.finalize({
          dialect: this.dialect, connParams: this.connParams,
          listenPort: 8080, agentToken: '', jwtSecret: '', logLevel: 'info', env: 'prod', staticDir: './dist'
        });
        resetInitStatusCache();
        return r.data;
      } catch (e) {
        this.finalizeError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    reset() {
      this.currentStep = 1;
      this.dialect = null;
      this.connParams = {};
      this.admin = { username: 'admin', password: '', confirm: '' };
      this.dbTestResult = null;
      this.applyProgress = null;
      this.applyError = null;
      this.adminError = null;
      this.finalizeError = null;
    }
  }
});