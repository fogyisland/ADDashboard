// 2026-08-31 R75 — mock AD user/group data store + dispatchers.
//
// In-memory mirror of the 17 AD cmdlets the real agent's
// ad-admin-users.ps1 / ad-admin-groups.ps1 scripts will invoke on a live
// DC. Each mockAd* function takes the (dcName, params) shape the agent's
// dispatcher will pass through and returns the same shape the AD cmdlets
// emit on the wire (the object ConvertTo-Json serializes on the real side).
//
// Why an in-memory store rather than extending mock-snapshot.mjs:
//   1. The operator's spec calls for *deterministic seed data per DC*
//      (4 users + 3 groups) so the e2e driver can assert specific
//      mutations without seeding real AD. The replication snapshot
//      helpers don't carry that surface.
//   2. Mock tests need to reset the store between scenarios (no leak
//      between test files). A fresh Map per test is the cheapest reset.
//   3. The dispatcher path runs *on the agent side* (the mock e2e
//      simulates the agent's processAdCommands → dispatchMockAdCommand
//      → mockAd* → ack POST), so the store is keyed by agentId / DC
//      hostname and matches what real AD cmdlets would see.
//
// Password fields are NEVER echoed back in the result envelope (spec
// §3.4 ruling #8). Protected accounts (Administrator / Guest / krbtgt
// for users; Domain Admins / Enterprise Admins / Schema Admins /
// Administrators for groups) throw a MockAdError on any write/delete
// action; the UI surfaces this as 400/409 via the route layer.

import crypto from 'node:crypto';

// ── error class ─────────────────────────────────────────────────────────

export class MockAdError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.name = 'MockAdError';
    this.httpStatus = httpStatus;
  }
}

// ── protected account set ───────────────────────────────────────────────
// Spec §8 row 9 — built-in accounts the UI / real AD both reject on
// any write/delete action. Mock enforces the same to keep the e2e path
// representative of the real agent's AD-side behavior.

const PROTECTED_USERS = new Set(['Administrator', 'Guest', 'krbtgt']);
const PROTECTED_GROUPS = new Set(['Domain Admins', 'Enterprise Admins', 'Schema Admins', 'Administrators']);

// ── seed dataset (4 users + 3 groups per DC) ─────────────────────────────
// Spec §5.1. Same dataset for every DC so the e2e driver has predictable
// mutation assertions (e.g. "after user_create 'bwayne', mockAdUserSearch
// returns 5 entries").

const SEED_USERS = [
  { sam: 'admin',      givenName: 'Alice', surname: 'Admin',     displayName: 'Alice Admin',     enabled: true,  description: 'Domain Administrator', upn: 'admin@contoso.local', mail: 'admin@contoso.local', title: 'IT Director', department: 'IT' },
  { sam: 'jdoe',       givenName: 'John',  surname: 'Doe',       displayName: 'John Doe',        enabled: true,  description: 'Sales Engineer',     upn: 'jdoe@contoso.local',  mail: 'jdoe@contoso.local',  title: 'Sales Engineer', department: 'Sales' },
  { sam: 'asmith',     givenName: 'Alice', surname: 'Smith',     displayName: 'Alice Smith',     enabled: false, description: 'Disabled — on leave', upn: 'asmith@contoso.local', mail: 'asmith@contoso.local', title: 'Accountant', department: 'Finance' },
  { sam: 'servicebot', givenName: 'Svc',  surname: 'Bot',       displayName: 'Service Account', enabled: true,  description: 'Scheduled tasks runner', upn: 'servicebot@contoso.local', mail: null, title: 'Service Account', department: 'Operations' }
];

const SEED_GROUPS = [
  { name: 'Domain Admins',     sam: 'Domain Admins',     category: 'Security',     scope: 'Global',      description: 'Tier-0 administrators', mail: null, managedBy: null, displayName: 'Domain Admins', members: ['admin'] },
  { name: 'Sales Team',        sam: 'Sales Team',        category: 'Security',     scope: 'Universal',   description: 'Sales department users', mail: 'sales@contoso.local', managedBy: null, displayName: 'Sales Team', members: ['jdoe'] },
  { name: 'All Staff DL',      sam: 'All Staff DL',      category: 'Distribution', scope: 'Universal',   description: 'Company-wide distro', mail: 'allstaff@contoso.local', managedBy: null, displayName: 'All Staff Distribution List', members: [] }
];

// ── adStore ─────────────────────────────────────────────────────────────
// dcName → { users: Map<sam, UserObj>, groups: Map<name, GroupObj> }
//
// Initialized lazily on first access (MOCK_AD_DATA env var override for
// tests that want a specific dataset; default to the seed dataset).

export const adStore = new Map();

function getDcStore(dcName) {
  if (typeof dcName !== 'string' || !dcName) {
    throw new MockAdError('dcName required', 400);
  }
  let store = adStore.get(dcName);
  if (!store) {
    store = initDcStore(dcName);
    adStore.set(dcName, store);
  }
  return store;
}

function initDcStore(dcName) {
  const users = new Map();
  const groups = new Map();
  // MOCK_AD_DATA env var lets tests inject custom data:
  //   MOCK_AD_DATA='{"DC-A":{"users":[...],"groups":[...]}}'
  const env = process.env.MOCK_AD_DATA;
  let dataset = null;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      dataset = parsed?.[dcName] ?? null;
    } catch { /* fall through to default */ }
  }
  const usersSrc = dataset?.users ?? SEED_USERS;
  const groupsSrc = dataset?.groups ?? SEED_GROUPS;
  for (const u of usersSrc) {
    users.set(u.sam.toLowerCase(), { ...u, lastLogon: u.lastLogon ?? null });
  }
  for (const g of groupsSrc) {
    groups.set(g.name, {
      ...g,
      members: Array.isArray(g.members) ? [...g.members] : [],
      memberCount: Array.isArray(g.members) ? g.members.length : 0
    });
  }
  return { users, groups };
}

// ── internal helpers ────────────────────────────────────────────────────

function assertNonProtectedUser(sam) {
  if (PROTECTED_USERS.has(sam)) {
    throw new MockAdError(`protected account: ${sam}`, 400);
  }
}

function assertNonProtectedGroup(name) {
  if (PROTECTED_GROUPS.has(name)) {
    throw new MockAdError(`protected group: ${name}`, 400);
  }
}

function assertString(v, field) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new MockAdError(`missing or empty ${field}`, 400);
  }
  return v.trim();
}

function assertArray(v, field) {
  if (!Array.isArray(v)) {
    throw new MockAdError(`invalid params: ${field} must be array`, 400);
  }
  return v;
}

// Compute a deterministic DN for a created user. Real AD would derive
// from the OU path; the mock uses a stable <dcName>-based DN so the
// returned dn is recognizable in e2e assertions.
function deriveUserDn(dcName, sam) {
  return `CN=${sam},OU=MOCK-Users,DC=${dcName.toLowerCase()},DC=mock`;
}

function deriveGroupDn(dcName, name) {
  return `CN=${name},OU=MOCK-Groups,DC=${dcName.toLowerCase()},DC=mock`;
}

// Validate GroupCategory + GroupScope combination. Spec §1.2 ruling —
// Distribution + DomainLocal is the only combo with restriction;
// others are accepted. AD rejects invalid combos with an error.
function validateCategoryScope(category, scope) {
  const validCategories = new Set(['Security', 'Distribution']);
  const validScopes = new Set(['DomainLocal', 'Global', 'Universal']);
  if (!validCategories.has(category)) {
    throw new MockAdError(`invalid params: category must be Security or Distribution`, 400);
  }
  if (!validScopes.has(scope)) {
    throw new MockAdError(`invalid params: scope must be DomainLocal/Global/Universal`, 400);
  }
}

// ── user dispatchers ────────────────────────────────────────────────────

export function mockAdUserSearch(dcName, { filter = '', limit = 200 } = {}) {
  const store = getDcStore(dcName);
  const filt = String(filter || '').toLowerCase();
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const out = [];
  for (const u of store.users.values()) {
    if (!filt || u.sam.toLowerCase().includes(filt)) {
      out.push({
        sam: u.sam,
        displayName: u.displayName ?? null,
        enabled: !!u.enabled,
        lastLogon: u.lastLogon ?? null,
        description: u.description ?? null
      });
    }
    if (out.length >= cap + 1) break; // peek ahead to set truncated
  }
  const truncated = out.length > cap;
  const users = truncated ? out.slice(0, cap) : out;
  return { users, truncated, count: users.length };
}

export function mockAdUserCreate(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  assertNonProtectedUser(sam);
  if (store.users.has(sam.toLowerCase())) {
    throw new MockAdError(`user already exists: ${sam}`, 409);
  }
  // Password is required (validated upstream by the service validator).
  // We don't store the password in the user record (spec §8 ruling #8).
  const givenName = typeof params.givenName === 'string' ? params.givenName : '';
  const surname = typeof params.surname === 'string' ? params.surname : '';
  const displayName = typeof params.displayName === 'string' && params.displayName.trim()
    ? params.displayName.trim()
    : `${givenName} ${surname}`.trim() || sam;
  const user = {
    sam,
    givenName: givenName || null,
    surname: surname || null,
    displayName,
    upn: typeof params.upn === 'string' ? params.upn : null,
    mail: typeof params.upn === 'string' ? params.upn : null,
    enabled: true,
    description: typeof params.description === 'string' ? params.description : null,
    lastLogon: null
  };
  store.users.set(sam.toLowerCase(), user);
  // Real AD auto-adds new users to Domain Users — a built-in group that
  // exists in every AD forest. The mock lazily creates Domain Users on
  // first user_create (the seed dataset doesn't include it; the 3 seed
  // groups are Domain Admins / Sales Team / All Staff DL).
  if (!store.groups.has('Domain Users')) {
    store.groups.set('Domain Users', {
      name: 'Domain Users',
      sam: 'Domain Users',
      category: 'Security',
      scope: 'Global',
      description: 'All domain users (built-in)',
      mail: null,
      managedBy: null,
      displayName: 'Domain Users',
      members: [],
      memberCount: 0
    });
  }
  const domainUsers = store.groups.get('Domain Users');
  if (!domainUsers.members.includes(sam)) {
    domainUsers.members.push(sam);
    domainUsers.memberCount = domainUsers.members.length;
  }
  return { sam, dn: deriveUserDn(dcName, sam), created: true };
}

export function mockAdUserPasswordReset(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  const user = store.users.get(sam.toLowerCase());
  if (!user) throw new MockAdError(`user not found: ${sam}`, 404);
  // Password reset allowed even for disabled users (spec §1.1 edge case a).
  // We never echo the password back.
  return { sam, passwordReset: true, unlocked: !!params.unlockAccount };
}

export function mockAdUserEnable(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  const user = store.users.get(sam.toLowerCase());
  if (!user) throw new MockAdError(`user not found: ${sam}`, 404);
  user.enabled = true;
  return { sam, enabled: true };
}

export function mockAdUserDisable(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  assertNonProtectedUser(sam);
  const user = store.users.get(sam.toLowerCase());
  if (!user) throw new MockAdError(`user not found: ${sam}`, 404);
  user.enabled = false;
  return { sam, enabled: false };
}

export function mockAdUserUnlock(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  const user = store.users.get(sam.toLowerCase());
  if (!user) throw new MockAdError(`user not found: ${sam}`, 404);
  return { sam, unlocked: true };
}

export function mockAdUserSetAttributes(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  const user = store.users.get(sam.toLowerCase());
  if (!user) throw new MockAdError(`user not found: ${sam}`, 404);
  const attrs = params.attributes ?? {};
  if (!attrs || typeof attrs !== 'object') {
    throw new MockAdError('invalid params: attributes', 400);
  }
  const updated = [];
  for (const [k, v] of Object.entries(attrs)) {
    // Map spec attribute names → user record fields. Real AD cmdlets
    // accept a different set per field (-Replace vs explicit flag);
    // the mock collapses them onto the same shape.
    if (v === null || v === undefined) continue;
    user[k] = v;
    updated.push(k);
  }
  return { sam, updatedFields: updated };
}

export function mockAdUserDelete(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  assertNonProtectedUser(sam);
  if (!store.users.has(sam.toLowerCase())) {
    throw new MockAdError(`user not found: ${sam}`, 404);
  }
  store.users.delete(sam.toLowerCase());
  // Remove the user from every group's member list (real AD also does
  // this cascade implicitly).
  for (const g of store.groups.values()) {
    const idx = g.members.indexOf(sam);
    if (idx !== -1) {
      g.members.splice(idx, 1);
      g.memberCount = g.members.length;
    }
  }
  return { sam, deleted: true };
}

export function mockAdUserListGroups(dcName, params = {}) {
  const store = getDcStore(dcName);
  const sam = assertString(params.sam, 'sam');
  if (!store.users.has(sam.toLowerCase())) {
    throw new MockAdError(`user not found: ${sam}`, 404);
  }
  const groups = [];
  for (const g of store.groups.values()) {
    if (g.members.includes(sam)) {
      groups.push({
        name: g.name,
        dn: deriveGroupDn(dcName, g.name),
        category: g.category,
        scope: g.scope
      });
    }
  }
  return { sam, groups };
}

// ── group dispatchers ───────────────────────────────────────────────────

export function mockAdGroupSearch(dcName, { filter = '', limit = 200 } = {}) {
  const store = getDcStore(dcName);
  const filt = String(filter || '').toLowerCase();
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const out = [];
  for (const g of store.groups.values()) {
    if (!filt || g.name.toLowerCase().includes(filt)) {
      out.push({
        name: g.name,
        sam: g.sam,
        category: g.category,
        scope: g.scope,
        description: g.description ?? null,
        memberCount: g.memberCount
      });
    }
    if (out.length >= cap + 1) break;
  }
  const truncated = out.length > cap;
  const groups = truncated ? out.slice(0, cap) : out;
  return { groups, truncated, count: groups.length };
}

export function mockAdGroupCreate(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  assertNonProtectedGroup(name);
  validateCategoryScope(params.category, params.scope);
  if (store.groups.has(name)) {
    throw new MockAdError(`group already exists: ${name}`, 409);
  }
  const sam = typeof params.sam === 'string' && params.sam.trim()
    ? params.sam.trim()
    : name;
  const grp = {
    name,
    sam,
    displayName: typeof params.displayName === 'string' && params.displayName.trim()
      ? params.displayName.trim() : name,
    category: params.category,
    scope: params.scope,
    description: typeof params.description === 'string' ? params.description : null,
    mail: typeof params.mail === 'string' ? params.mail : null,
    managedBy: null,
    members: [],
    memberCount: 0
  };
  store.groups.set(name, grp);
  return { name, dn: deriveGroupDn(dcName, name), created: true };
}

export function mockAdGroupSetAttributes(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  const grp = store.groups.get(name);
  if (!grp) throw new MockAdError(`group not found: ${name}`, 404);
  const attrs = params.attributes ?? {};
  if (!attrs || typeof attrs !== 'object') {
    throw new MockAdError('invalid params: attributes', 400);
  }
  // category/scope change may invalidate membership — AD would error if
  // there are members that can't fit. Mock keeps them but accepts the change.
  const updated = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if ((k === 'category' || k === 'scope') && grp[k] !== v) {
      // Validate the new combo before committing
      validateCategoryScope(
        k === 'category' ? v : grp.category,
        k === 'scope' ? v : grp.scope
      );
    }
    grp[k] = v;
    updated.push(k);
  }
  return { name, updatedFields: updated };
}

export function mockAdGroupAddMember(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  const grp = store.groups.get(name);
  if (!grp) throw new MockAdError(`group not found: ${name}`, 404);
  const members = assertArray(params.members, 'members').map(String);
  const added = [];
  const alreadyMembers = [];
  for (const m of members) {
    if (grp.members.includes(m)) {
      alreadyMembers.push(m);
    } else {
      grp.members.push(m);
      added.push(m);
    }
  }
  grp.memberCount = grp.members.length;
  return { name, added, alreadyMembers };
}

export function mockAdGroupRemoveMember(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  const grp = store.groups.get(name);
  if (!grp) throw new MockAdError(`group not found: ${name}`, 404);
  const members = assertArray(params.members, 'members').map(String);
  const removed = [];
  const notMembers = [];
  for (const m of members) {
    const idx = grp.members.indexOf(m);
    if (idx === -1) {
      notMembers.push(m);
    } else {
      grp.members.splice(idx, 1);
      removed.push(m);
    }
  }
  grp.memberCount = grp.members.length;
  return { name, removed, notMembers };
}

export function mockAdGroupSetMembers(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  const grp = store.groups.get(name);
  if (!grp) throw new MockAdError(`group not found: ${name}`, 404);
  const newMembers = assertArray(params.members, 'members').map(String);
  const prev = new Set(grp.members);
  const next = new Set(newMembers);
  const added = [...next].filter(m => !prev.has(m));
  const removed = [...prev].filter(m => !next.has(m));
  grp.members = newMembers;
  grp.memberCount = newMembers.length;
  return { name, added, removed };
}

export function mockAdGroupDelete(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  assertNonProtectedGroup(name);
  if (!store.groups.has(name)) {
    throw new MockAdError(`group not found: ${name}`, 404);
  }
  store.groups.delete(name);
  return { name, deleted: true };
}

export function mockAdGroupListMembers(dcName, params = {}) {
  const store = getDcStore(dcName);
  const name = assertString(params.name, 'name');
  const grp = store.groups.get(name);
  if (!grp) throw new MockAdError(`group not found: ${name}`, 404);
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const size = Math.max(1, Math.min(1000, Math.floor(Number(params.size) || 100)));
  const start = (page - 1) * size;
  const slice = grp.members.slice(start, start + size);
  return {
    name,
    members: slice.map(sam => ({ sam, dn: deriveUserDn(dcName, sam) })),
    total: grp.memberCount,
    page,
    size
  };
}

// ── command router ──────────────────────────────────────────────────────

// dispatchMockAdCommand(agentId, cmd) routes cmd.commandType to the
// matching mockAd* function. Returns { success, data, error, exitCode }
// so the mock agent's ack layer can wrap it into the result envelope
// (the agent's real JS dispatcher will produce the same shape from its
// PowerShell spawn()).

export function dispatchMockAdCommand(agentId, cmd) {
  const start = Date.now();
  try {
    if (!cmd || typeof cmd !== 'object') {
      throw new MockAdError('command object required', 400);
    }
    const { commandType, params } = cmd;
    if (typeof commandType !== 'string' || !commandType) {
      throw new MockAdError('commandType required', 400);
    }
    let data;
    switch (commandType) {
      case 'user_search':          data = mockAdUserSearch(agentId, params || {}); break;
      case 'user_create':          data = mockAdUserCreate(agentId, params || {}); break;
      case 'user_password_reset':  data = mockAdUserPasswordReset(agentId, params || {}); break;
      case 'user_enable':          data = mockAdUserEnable(agentId, params || {}); break;
      case 'user_disable':         data = mockAdUserDisable(agentId, params || {}); break;
      case 'user_unlock':          data = mockAdUserUnlock(agentId, params || {}); break;
      case 'user_set_attributes':  data = mockAdUserSetAttributes(agentId, params || {}); break;
      case 'user_delete':          data = mockAdUserDelete(agentId, params || {}); break;
      case 'user_list_groups':     data = mockAdUserListGroups(agentId, params || {}); break;
      case 'group_search':         data = mockAdGroupSearch(agentId, params || {}); break;
      case 'group_create':         data = mockAdGroupCreate(agentId, params || {}); break;
      case 'group_set_attributes': data = mockAdGroupSetAttributes(agentId, params || {}); break;
      case 'group_add_member':     data = mockAdGroupAddMember(agentId, params || {}); break;
      case 'group_remove_member':  data = mockAdGroupRemoveMember(agentId, params || {}); break;
      case 'group_set_members':    data = mockAdGroupSetMembers(agentId, params || {}); break;
      case 'group_delete':         data = mockAdGroupDelete(agentId, params || {}); break;
      case 'group_list_members':   data = mockAdGroupListMembers(agentId, params || {}); break;
      default:
        throw new MockAdError(`unknown command_type: ${commandType}`, 400);
    }
    const durationMs = Date.now() - start;
    return {
      success: true,
      data,
      error: null,
      exitCode: 0,
      durationMs
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const httpStatus = (e && typeof e.httpStatus === 'number') ? e.httpStatus : 500;
    const message = (e && e.message) ? e.message : String(e);
    return {
      success: false,
      data: null,
      error: message,
      exitCode: httpStatus >= 500 ? 2 : 1,
      durationMs
    };
  }
}

// ── reset helper (test-only) ────────────────────────────────────────────
// Exposed so test files can call `resetAdStore()` between scenarios
// without leaking state. NOT part of the agent-facing API.

export function resetAdStore() {
  adStore.clear();
}

// ── test introspection helpers (test-only) ──────────────────────────────
// Direct access to the underlying maps. Production code MUST NOT use
// these — they're here so tests can verify the store mutated as expected
// after a dispatch without re-querying through the dispatcher.

export function _internalStoreView(dcName) {
  // Lazy-init so callers can inspect the store even after a resetAdStore()
  // without first having to dispatch a command. Mirrors getDcStore so
  // tests don't have to remember the init order.
  const store = getDcStore(dcName);
  return {
    users: Array.from(store.users.values()),
    groups: Array.from(store.groups.values())
  };
}

// ── detection of "run directly" so e2e driver can import safely ─────────
// Detect via process.argv[1] (Windows + POSIX safe). The mock file is
// designed to be import-only — running it standalone just prints the
// seed dataset shape and exits. The mock-ad-admin-e2e.mjs driver boots
// the daemon and exercises the full path.

const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('mock-ad-admin.mjs') ||
   process.argv[1].endsWith('mock-ad-admin'));
if (isDirectRun) {
  console.log('mock-ad-admin.mjs — module surface:');
  console.log('  exports: adStore, MockAdError, resetAdStore, _internalStoreView');
  console.log('  dispatchers (17):');
  const fns = [
    'mockAdUserSearch','mockAdUserCreate','mockAdUserPasswordReset',
    'mockAdUserEnable','mockAdUserDisable','mockAdUserUnlock',
    'mockAdUserSetAttributes','mockAdUserDelete','mockAdUserListGroups',
    'mockAdGroupSearch','mockAdGroupCreate','mockAdGroupSetAttributes',
    'mockAdGroupAddMember','mockAdGroupRemoveMember','mockAdGroupSetMembers',
    'mockAdGroupDelete','mockAdGroupListMembers'
  ];
  for (const f of fns) console.log(`    ${f}`);
  console.log('  helper: dispatchMockAdCommand(agentId, { commandType, params })');
  // Suppress unused-import warning for crypto if not used.
  void crypto;
}
