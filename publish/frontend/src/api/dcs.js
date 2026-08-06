import api from './client.js';

export function getDcSummary(siteId) {
  const qs = (siteId === null || siteId === undefined || siteId === '') ? '' : `?siteId=${encodeURIComponent(siteId)}`;
  return api.get(`/api/dcs/summary${qs}`);
}
