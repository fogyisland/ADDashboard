// mock-snapshot.mjs — shared helper for mock-*.mjs runners.
//
// 2026-08-27 round-24: the operator's directive is "mock 反过去执行 agent
// 路径", i.e. mocks must drive the same code paths the real agent drives.
// Before this refactor, each mock-*.mjs hand-rolled the camelCase
// data[] shape that /api/agent/report expects — duplicating the agent's
// `toCamelEntry()` conversion and missing every field the agent adds over
// time (round-18 dropped LockedCount on __dc_summary__, round-13 added
// PartnerPortStatus, etc.). The mock silently drifted out of sync.
//
// This module produces a snapshot in the EXACT PascalCase shape that
// collect-replication.ps1 emits, then defers to the real
// `postReport()` from agent/src/reporter.js. Field changes in the
// reporter are automatically picked up by every mock that imports this.
//
// Public surface:
//   buildDcCounters(agentId)              -> { usersCount, groupsCount, gposCount }
//   buildSummaryEntry(agentId, ...)       -> __dc_summary__ entry (PS1 shape)
//   buildLinkEntries(agentId, links, ...) -> per-link entries (PS1 shape)
//   buildSnapshot({ agentId, links, ... }) -> full snapshot (PS1 shape)
//   postSnapshot({ centerUrl, agentToken, snapshot }) -> wraps reporter.postReport
//   dcSummaryRowOf(snapshot)              -> quick accessor for tests
//
// All values that hit the DB flow through reporter.toCamelEntry() before
// the wire — so this module never has to know about the camelCase wire
// shape. Future field additions in toCamelEntry are picked up for free.

import crypto from 'node:crypto';
import { postReport } from '../agent/src/reporter.js';

// Stable per-DC counters derived from a SHA-256 of the agentId. Same agent
// always yields the same numbers across runs (looks like real AD data),
// different agents get different numbers (simulates per-DC AD scale).
// Ranges chosen to look like realistic small/medium AD deployments:
//   - usersCount: 500..5000
//   - groupsCount: 50..600 (roughly 10-15% of users)
//   - gposCount: 10..100
export function buildDcCounters(agentId) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildDcCounters: agentId required');
  }
  const hash = crypto.createHash('sha256').update(agentId).digest();
  const u32 = (off) => hash.readUInt32BE(off);
  return {
    usersCount:  500 + (u32(0) % 4501),
    groupsCount:  50 + (u32(4) %  551),
    gposCount:   10 + (u32(8) %   91),
  };
}

// 2026-08-26 round-18: LockoutCount moved out of collect-replication.ps1.
// It's now emitted by ad_lockout_summary / ad_lockout_list packages on a
// 15-min cadence. The real __dc_summary__ entry still carries the
// locked_count column in the SQL schema (and the centre's latestSummaryPerDc
// still reads it), but the agent stops setting it to non-null here.
// Mock mirrors that — LockedCount: null — so the operator sees the same
// shape they'd see from a real agent. To exercise the lockedCount path,
// run the ad_lockout_summary package (mock-package-report.mjs).
export function buildSummaryEntry(agentId, collectedAt, sourceSite = null) {
  const counters = buildDcCounters(agentId);
  return {
    SourceDc:         agentId,
    DestDc:           agentId,            // mirror real PS1: self-loop
    SourceSite:       sourceSite,
    DestSite:         null,
    NamingContext:    '__dc_summary__',
    LastSuccessTime:  collectedAt,
    LastAttemptTime:  collectedAt,
    StatusCode:       0,
    ErrorMessage:     null,
    UsersCount:       counters.usersCount,
    GroupsCount:      counters.groupsCount,
    GposCount:        counters.gposCount,
    LockedCount:      null,
    PartnerPortStatus: null
  };
}

// Convert a mock-friendly link descriptor to a PS1 PascalCase entry.
// link shape (camelCase, mock-ergonomic):
//   {
//     destDc, destSite?, namingContext?, statusCode?, errorMessage?,
//     partnerPortStatus?  // round-13: per-partner port probe JSON
//   }
export function buildLinkEntries(agentId, collectedAt, links = [], sourceSite = null) {
  const out = [];
  for (const link of links) {
    out.push({
      SourceDc:         agentId,
      DestDc:           link.destDc,
      SourceSite:       sourceSite,
      DestSite:         link.destSite ?? null,
      NamingContext:    link.namingContext ?? `CN=${agentId}->${link.destDc}`,
      LastSuccessTime:  link.statusCode === 0 ? collectedAt : null,
      LastAttemptTime:  collectedAt,
      StatusCode:       link.statusCode ?? 0,
      ErrorMessage:     link.statusCode === 0 ? null : (link.errorMessage ?? 'unknown'),
      UsersCount:       null,
      GroupsCount:      null,
      GposCount:        null,
      LockedCount:      null,
      PartnerPortStatus: link.partnerPortStatus ?? null
    });
  }
  return out;
}

// Build a complete snapshot the way collect-replication.ps1 would emit it.
// Always appends a __dc_summary__ entry so the centre's
// GET /api/dcs/summary → DcCard UI has live counters even when there are
// no replication links (e.g. a brand-new DC that only did its first
// heartbeat). Without this the Server Overview renders — / 0 / — / —
// which they mistake for "the data path never executed".
export function buildSnapshot({
  agentId,
  collectedAt,                            // ISO string or Date
  sourceSite = null,
  links = []
}) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildSnapshot: agentId required');
  }
  const ts = collectedAt instanceof Date
    ? collectedAt.toISOString()
    : String(collectedAt);
  return {
    AgentId:     agentId,
    CollectedAt: ts,
    Site:        sourceSite,
    Entries: [
      ...buildLinkEntries(agentId, ts, links, sourceSite),
      buildSummaryEntry(agentId, ts, sourceSite)
    ]
  };
}

// Wrapper around reporter.postReport so callers don't have to import
// the agent module. Snapshot is passed verbatim — reporter.postReport
// runs toCamelEntry() on each entry before posting.
export function postSnapshot({ centerUrl, agentToken, snapshot }) {
  return postReport({ centerUrl, agentToken, snapshot });
}

// Convenience: pull the __dc_summary__ entry out of a snapshot for tests.
export function dcSummaryRowOf(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.Entries)) return null;
  return snapshot.Entries.find((e) => e.NamingContext === '__dc_summary__') ?? null;
}