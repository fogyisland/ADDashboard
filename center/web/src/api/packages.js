import api from './client.js';

// R66 (V1) admin surface for package scripts + policies.
// The legacy Pinia store (src/stores/packages.js) is still alive because
// PackageEditView / RegistryView depend on its envelope; T10 only adds
// this sibling module so the rewritten PackagesView can talk directly
// to the 7 V1 endpoints:
//
//   GET    /api/admin/packages
//   GET    /api/admin/packages/:name/script    (R67-T1 view-mode)
//   POST   /api/admin/packages/upload-script
//   PUT    /api/admin/packages/:name/script
//   PUT    /api/admin/packages/:name/policy
//   PUT    /api/admin/packages/:name/enable
//   PUT    /api/admin/packages/:name/disable
//   DELETE /api/admin/packages/:name
//
// `name` is the operator-supplied script name; it can contain `[a-zA-Z0-9_-]`
// but we still encode it to be safe across the existing express routes.
export const packagesApi = {
  list: () => api.get('/api/admin/packages'),
  // R67-T1 — read-only view path. Returns the raw script body for the
  // EditScriptModal's view-mode (no client cache, every successful call
  // emits a view_script audit row on the backend). Used when the operator
  // wants to see what is currently installed before deciding to replace.
  getScript: (name) =>
    api.get(`/api/admin/packages/${encodeURIComponent(name)}/script`),
  uploadScript: (body) => api.post('/api/admin/packages/upload-script', body),
  editScript: (name, body) =>
    api.put(`/api/admin/packages/${encodeURIComponent(name)}/script`, body),
  setPolicy: (name, body) =>
    api.put(`/api/admin/packages/${encodeURIComponent(name)}/policy`, body),
  enable: (name) =>
    api.put(`/api/admin/packages/${encodeURIComponent(name)}/enable`),
  disable: (name) =>
    api.put(`/api/admin/packages/${encodeURIComponent(name)}/disable`),
  deleteScript: (name) =>
    api.delete(`/api/admin/packages/${encodeURIComponent(name)}`)
};
