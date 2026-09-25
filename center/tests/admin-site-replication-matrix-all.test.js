import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildSql } from '../src/db/sql.js';
import { buildMockDb } from './helpers/db-mock.js';
import { signJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret';

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function buildApp(db) {
  const a = express();
  a.use(express.json());
  // dashboardRouter internally composes userAuth + requirePerm, so mount
  // it directly. The route handler reads db via getDb() which returns
  // whatever _setDbForTest installed — the same shape buildMockDb emits.
  // The auth middleware's per-request SELECTs (sys_users / jwt_secret)
  // fall through buildMockDb's default empty-rows path; db-mock.js's
  // defaultQuery (installed by buildMockDb.standard()) routes those to
  // auth-success rows.
  _setDbForTest(db);
  return a.use(
    dashboardRouter({
      config: {},
      logger: null
    })
  );
}

// Catalogue row for a DC. Bare name only — matches the actual ad_dcs
// schema (see sql.dashboard.allDcsBySite).
function fakeDc(overrides = {}) {
  return {
    dc_name: 'KDLFLOFADSRV2',
    site_id: 'site-fl',
    is_bridgehead: true,
    is_pdc: false, is_gc: false, is_rid_master: false, is_schema_master: false,
    is_domain_naming_master: false, is_infrastructure_master: false,
    os_version: 'Win2022', discovered_at: new Date(),
    ...overrides
  };
}

function fakeSite(overrides = {}) {
  return {
    site_id: 'site-fl', site_name: 'KDL-FL-HubSite',
    region_code: 'CN-FL', is_hub: true,
    ...overrides
  };
}

// Link row with full NTDS Settings DN (as collector emits to
// ad_replication_status).
function fakeLink(overrides = {}) {
  return {
    source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
    dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
    source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
    naming_context: 'DC=shaphar,DC=com',
    status_code: 0,
    last_success_time: new Date('2026-09-25T08:00:00Z'),
    last_attempt_time: new Date('2026-09-25T08:00:00Z'),
    duration_minutes: 5,
    ...overrides
  };
}

function mockMatrixDb({ dcs = [], sites = [], links = [] } = {}) {
  return buildMockDb([
    {
      // allSitesOrdered: SELECT ... FROM ad_sites ORDER BY is_hub DESC, ...
      match: /FROM\s+ad_sites\s+ORDER\s+BY/i,
      rows: sites
    },
    {
      // allDcsBySite: SELECT ... FROM ad_dcs d INNER JOIN ad_sites s ...
      match: /FROM\s+ad_dcs\b[\s\S]*?INNER\s+JOIN\s+ad_sites/i,
      rows: dcs
    },
    {
      // allReplicationLinks: SELECT ... FROM ad_replication_status t1
      //   WHERE t1.source_dc <> t1.dest_dc AND naming_context NOT IN ...
      match: /FROM\s+ad_replication_status[\s\S]*?WHERE\s+t1\.source_dc\s*<>\s*t1\.dest_dc/i,
      rows: links
    },
    {
      // refreshSeconds: SELECT config_value FROM system_config ...
      match: /FROM\s+system_config/i,
      rows: [{ config_key: 'dashboard_refresh_seconds', config_value: '10' }]
    }
  ]).standard();
}

// R93.12: collector writes full NTDS Settings DN into
// ad_replication_status.source_dc / dest_dc, but ad_dcs.dc_name is the bare
// DC name. The matrix route handler must normalise both sides before
// joining link rows against the catalogue, otherwise every link is dropped
// and the matrix renders empty.
test('site-replication-matrix/all: DN link rows match bare-name catalogue (R93.12 normalisation)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-bj', site_name: 'KDL-BeiJing', region_code: 'CN-BJ', is_hub: true }),
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite', region_code: 'CN-FL', is_hub: true }),
      fakeSite({ site_id: 'site-sh', site_name: 'KDL-ShangHai', region_code: 'CN-SH', is_hub: false })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLBJOFADSRV1', site_id: 'site-bj' }),
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' }),
      fakeDc({ dc_name: 'KDLSHTOFADSRV1', site_id: 'site-sh' })
    ],
    links: [
      // Inbound to KDLFLOFADSRV2 from KDLBJOFADSRV1
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
        status_code: 0, last_success_time: new Date('2026-09-25T08:00:00Z'),
        last_attempt_time: new Date('2026-09-25T08:00:00Z'), duration_minutes: 5
      }),
      // Outbound from KDLFLOFADSRV2 to KDLSHTOFADSRV1
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLSHTOFADSRV1,CN=Servers,CN=KDL-ShangHai,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-FL-HubSite', dest_site: 'KDL-ShangHai',
        status_code: 2, last_success_time: null,
        last_attempt_time: new Date('2026-09-25T08:00:00Z'), duration_minutes: 30
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const payload = res.body;
  assert.ok(Array.isArray(payload.primaries), 'payload.primaries should be an array');
  assert.equal(payload.primaries.length, 3, 'all 3 sites should be present');

  // KDLFLOFADSRV2 lives in KDL-FL-HubSite — that site appears as a primary row.
  const fl = payload.primaries.find(p => p.siteName === 'KDL-FL-HubSite');
  assert.ok(fl, 'KDL-FL-HubSite must be in primaries');
  const flDc = fl.dcPartners.find(d => d.dcName === 'KDLFLOFADSRV2');
  assert.ok(flDc, 'KDLFLOFADSRV2 should be listed in dcPartners for KDL-FL-HubSite');

  // DN-format link KDLBJOFADSRV1 → KDLFLOFADSRV2 produces a partner entry
  // on KDLFLOFADSRV2 with bare-name peerDc (R93.12 normalisation).
  const bjPeer = flDc.partners.find(p => p.peerDc === 'KDLBJOFADSRV1');
  assert.ok(bjPeer, 'inbound partner from KDLBJOFADSRV1 must land on KDLFLOFADSRV2 with bare-name peerDc');
  assert.equal(bjPeer.peerType, 'bridgehead');
  assert.equal(bjPeer.peerSite, 'KDL-BeiJing');
  assert.equal(bjPeer.statusCode, 0);

  // Reverse direction: KDLFLOFADSRV2 → KDLSHTOFADSRV1. Look at the ShangHai
  // primary — it should have an inbound entry from KDLFLOFADSRV2 with
  // bare-name peerDc.
  const sh = payload.primaries.find(p => p.siteName === 'KDL-ShangHai');
  assert.ok(sh, 'KDL-ShangHai must be in primaries');
  const shDc = sh.dcPartners.find(d => d.dcName === 'KDLSHTOFADSRV1');
  assert.ok(shDc, 'KDLSHTOFADSRV1 should be listed in dcPartners for KDL-ShangHai');
  const flPeer = shDc.partners.find(p => p.peerDc === 'KDLFLOFADSRV2');
  assert.ok(flPeer, 'inbound partner from KDLFLOFADSRV2 must land on KDLSHTOFADSRV1 with bare-name peerDc');
  assert.equal(flPeer.statusCode, 2);
});

// R93.13: real-machine data on KDLFLOFADSRV2 shows link.source_dc is a
// full NTDS Settings DN whose bare host (e.g. KDLJTWHADSRV1) is a SECONDARY
// DC in a remote site — NOT the remote site's primary. The route handler's
// `allowedPeers` set was round-32 inherited from per-site primary-only
// inbound filter (`本 site DC + cross-site primary`) and wrongly drops
// secondary-DC sources. The matrix `/all` view is an N×N network-wide
// perspective — every catalogue DC must surface as a peer regardless of
// whether it's a site primary or not. Lock the contract with this test:
// every catalogue DC that sources a link whose dest is in the current
// site must land in the dest's `partners` list.
test('site-replication-matrix/all: secondary-DC partners must surface (R93.13 allowedPeers fix)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-fl',  site_name: 'KDL-FL-HubSite',  region_code: 'CN-FL', is_hub: true }),
      // Two other sites — each has a *primary* (BJOFADSRV1 / WHOFADSRV1)
      // and a *secondary* (JTWHADSRV1 / BSWHADSRV1). The 8-row real-machine
      // pattern on KDLFLOFADSRV2 has dest=KDLFLOFADSRV2 (bare) and
      // source=DN whose bare host is the *secondary* DC of the remote
      // site. Pre-R93.13 this fails because allowedPeers only contains
      // the site primary. We bridgehead-flag the secondary false so the
      // primary sort still picks the primary first; the secondary must
      // still appear as a peer.
      fakeSite({ site_id: 'site-shjt', site_name: 'KDL-ShangHaiJiuTing', region_code: 'CN-SH', is_hub: false }),
      fakeSite({ site_id: 'site-shbs', site_name: 'KDL-ShangHaiCheDun',  region_code: 'CN-SH', is_hub: false })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' }),
      // site-shjt: primary first (so it becomes primaryBySiteId entry), then secondary
      fakeDc({ dc_name: 'KDLBJOFADSRV1', site_id: 'site-shjt', is_bridgehead: true }),
      fakeDc({ dc_name: 'KDLJTWHADSRV1', site_id: 'site-shjt', is_bridgehead: false }),
      // site-shbs: same pattern
      fakeDc({ dc_name: 'KDLWHOFADSRV1', site_id: 'site-shbs', is_bridgehead: true }),
      fakeDc({ dc_name: 'KDLBSWHADSRV1', site_id: 'site-shbs', is_bridgehead: false })
    ],
    links: [
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLJTWHADSRV1,CN=Servers,CN=KDL-ShangHaiJiuTing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'KDLFLOFADSRV2',
        source_site: 'KDL-ShangHaiJiuTing', dest_site: 'KDL-FL-HubSite',
        naming_context: '__partner_naming__:0bd554d5',
        status_code: 0
      }),
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLBSWHADSRV1,CN=Servers,CN=KDL-ShangHaiCheDun,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'KDLFLOFADSRV2',
        source_site: 'KDL-ShangHaiCheDun', dest_site: 'KDL-FL-HubSite',
        naming_context: '__partner_naming__:9fd0efd6',
        status_code: 0
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const fl = res.body.primaries.find(p => p.siteName === 'KDL-FL-HubSite');
  assert.ok(fl, 'KDL-FL-HubSite must be in primaries');
  const flDc = fl.dcPartners.find(d => d.dcName === 'KDLFLOFADSRV2');
  assert.ok(flDc, 'KDLFLOFADSRV2 must be listed in dcPartners');
  const peerDcs = flDc.partners.map(p => p.peerDc).sort();
  // Secondary DCs from remote sites must appear as peers — they are
  // catalogue-known DCs even though they are not the remote site primary.
  // Pre-R93.13 these are filtered out by `allowedPeers` (which only
  // contains site primaries), leaving KDLFLOFADSRV2 with 0 inbound
  // partners. The real-machine data has 8 such rows.
  assert.ok(peerDcs.includes('KDLJTWHADSRV1'),
    `KDLJTWHADSRV1 (secondary peer) must surface; got partners=${JSON.stringify(peerDcs)}`);
  assert.ok(peerDcs.includes('KDLBSWHADSRV1'),
    `KDLBSWHADSRV1 (secondary peer) must surface; got partners=${JSON.stringify(peerDcs)}`);
});

// R95: catalogue `ad_sites` lists every AD site the operator has registered,
// but `ad_dcs` only has rows for the DCs the agent has actually discovered.
// When an operator pre-registers a site in ad_sites but no DC has reported
// for it yet (or all DC rows for it got dropped by INNER JOIN due to a
// site_id drift), the site should STILL appear in the matrix payload as
// an empty-DCs entry — the matrix is an N×N site view, not a "currently
// active" view. Frontend uses the empty `dcs: []` to render a "暂未注册 DC"
// placeholder cell. Pre-R95 the handler did
//   `if (dcList.length === 0) continue;`
// at line 369, silently skipping empty sites and shrinking the matrix to
// match only "sites with at least one DC" — which is exactly the bug
// operator reported when 3 sites are registered but the matrix shows 2.
//
// Lock the contract: every site in ad_sites surfaces in primaries, even
// when ad_dcs has no rows for it.
test('site-replication-matrix/all: empty sites (no DC rows in ad_dcs) still surface in primaries (R95 catalogue mirror)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite',  region_code: 'CN-FL', is_hub: true }),
      fakeSite({ site_id: 'site-sh', site_name: 'KDL-ShangHai',   region_code: 'CN-SH', is_hub: false }),
      // The third site has NO DC rows in ad_dcs — either the operator
      // pre-registered it but no agent has reported yet, or every DC row
      // for this site got dropped by INNER JOIN due to a site_id drift.
      // Either way, R95 says the site must still surface in primaries
      // so the matrix renders a 3×3 grid with a "暂未注册 DC" column/row
      // for the empty site.
      fakeSite({ site_id: 'site-empty', site_name: 'KDL-BeiJing-New', region_code: 'CN-BJ', is_hub: false })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' }),
      fakeDc({ dc_name: 'KDLSHTOFADSRV1', site_id: 'site-sh' })
      // NOTE: no DC rows for site-empty
    ],
    links: [
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLSHTOFADSRV1,CN=Servers,CN=KDL-ShangHai,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-ShangHai', dest_site: 'KDL-FL-HubSite',
        status_code: 0
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const payload = res.body;
  assert.ok(Array.isArray(payload.primaries), 'payload.primaries should be an array');
  // R95 contract: primaries.length == ad_sites row count, not
  // "ad_sites with at least one ad_dcs row" count. Pre-R95 the handler
  // skipped the empty site, returning 2 primaries (one per site with DCs).
  assert.equal(payload.primaries.length, 3,
    `expected 3 primaries (one per ad_sites row), got ${payload.primaries.length}`);

  // The empty site surfaces with dcs: [] and dcPartners: []. The front-end
  // matrix renders this as a "暂未注册 DC" cell.
  const empty = payload.primaries.find(p => p.siteName === 'KDL-BeiJing-New');
  assert.ok(empty, 'KDL-BeiJing-New must be in primaries even when ad_dcs has no rows for it');
  assert.equal(empty.dcs.length, 0, 'empty site should have dcs: []');
  assert.equal(empty.dcPartners.length, 0, 'empty site should have dcPartners: []');
  // siteName/isHub/regionCode must still be the catalogue values.
  assert.equal(empty.siteName, 'KDL-BeiJing-New');
  assert.equal(empty.isHub, false);
  assert.equal(empty.regionCode, 'CN-BJ');
});

// R95 anti-regression sentinel: the cataloge-mirror contract from the
// previous test (every ad_sites row in primaries, even with empty dcs).
// Pre-R95 the handler did `if (dcList.length === 0) continue;` which
// shrunk primaries.length to only the "sites with DC rows" subset.
// This sentinel lives separately so a future refactor that drops the
// mirror logic is caught.
test('site-replication-matrix/all: primaries count mirrors ad_sites catalogue count (R95 sentinel)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite',  region_code: 'CN-FL', is_hub: true }),
      fakeSite({ site_id: 'site-sh', site_name: 'KDL-ShangHai',   region_code: 'CN-SH', is_hub: false })
    ],
    // dcs has only KDLFLOFADSRV2 in site-fl — site-sh has NO DCs at all.
    dcs: [
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' })
    ],
    links: []
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  // R95: 2 primaries (one per ad_sites row), not 1 (only the "site with
  // DCs" subset).
  assert.equal(res.body.primaries.length, 2,
    `expected 2 primaries (one per ad_sites row), got ${res.body.primaries.length}`);

  // The site without DCs still surfaces as an entry with empty dcs/dcPartners.
  const sh = res.body.primaries.find(p => p.siteName === 'KDL-ShangHai');
  assert.ok(sh, 'KDL-ShangHai must surface even when it has no DCs in ad_dcs');
  assert.equal(sh.dcs.length, 0);
  assert.equal(sh.dcPartners.length, 0);
});

// Pre-R93.12 sentinel: if a future refactor accidentally drops the
// DN-to-bare-name normalisation, this test catches the regression.
test('site-replication-matrix/all: DN link rows must surface partner entries (sentinel)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-bj', site_name: 'KDL-BeiJing', region_code: 'CN-BJ', is_hub: true }),
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite', region_code: 'CN-FL', is_hub: true })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLBJOFADSRV1', site_id: 'site-bj' }),
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' })
    ],
    links: [
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
        status_code: 0
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const fl = res.body.primaries.find(p => p.siteName === 'KDL-FL-HubSite');
  assert.ok(fl, 'KDL-FL-HubSite must be in primaries');
  const flDc = fl.dcPartners.find(d => d.dcName === 'KDLFLOFADSRV2');
  assert.ok(flDc, 'KDLFLOFADSRV2 must be listed in dcPartners');
  assert.ok(flDc.partners.length > 0,
    `expected at least one inbound partner after DN normalisation, got ${flDc.partners.length}`);
});