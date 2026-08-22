import api from './client.js';

export function searchLockoutEvents({ targetUser, dc, caller, sinceHours }) {
  const parts = [];
  if (targetUser) parts.push(`targetUser=${encodeURIComponent(targetUser)}`);
  if (dc)         parts.push(`dc=${encodeURIComponent(dc)}`);
  if (caller)     parts.push(`caller=${encodeURIComponent(caller)}`);
  if (sinceHours != null) parts.push(`sinceHours=${encodeURIComponent(sinceHours)}`);
  const qs = parts.length ? `?${parts.join('&')}` : '';
  return api.get(`/api/lockout-events/search${qs}`);
}