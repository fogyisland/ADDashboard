// ouTreeBuilder.js — R158.43 (2026-10-03), R158.44.7.10 (2026-10-05)
//
// Build a nested OU tree from ad_ous_snapshot flat list. Two helpers:
//   - stripFirstRdn(dn): "CN=jdoe,OU=Finance,DC=corp,DC=local" → "OU=Finance,DC=corp,DC=local"
//   - firstRdnValue(dn): "OU=Finance,DC=corp,DC=local" → "Finance"
//   - countUsersGroupsComputers(users, groups, computers): build three
//     Map<ouDn, count> from ad_users_snapshot + ad_groups_snapshot +
//     ad_computers_snapshot rows (used to attach userCount / groupCount /
//     computerCount to each OU node in the tree).
//   - buildOuTree(list, userCounts, groupCounts, computerCounts): input =
//     ad_ous_snapshot list (flat), output = nested roots with children +
//     userCount + groupCount + computerCount + depth + isBuiltin flag.
//
// Originally inline in DailyOpsView.vue (lines ~923-970); extracted to allow
// SnapshotTreeSection (R158.43) to reuse the same algorithm so the same DC
// renders identical trees in both views. R158.44.7.10 added computerCount
// (3rd object class — R158.44.7.8 agent端 computers_count 跟 sync 端对齐).

export function stripFirstRdn(dn) {
  const idx = String(dn).indexOf(',');
  return idx >= 0 ? dn.slice(idx + 1) : '';
}

export function firstRdnValue(dn) {
  const m = String(dn).match(/^([A-Z]+)=([^,]+)/);
  return m ? m[2] : dn;
}

// countUsersGroupsComputers(users, groups, computers) →
//   { userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn }
// Each is a Map<ouDn, count>. Skips Builtin groups (their parent_dn doesn't
// live in ad_ous_snapshot; they belong in their own builtin panel).
// Tries row.ouDn first (ad_users_snapshot.ou_dn column from R158.35), falls
// back to stripFirstRdn(distinguishedName) which works for both user + group
// DN patterns. R158.44.7.10 — computer 跟 user 同形 (ouDn primary, dn slice fallback).
export function countUsersGroupsComputers(users, groups, computers) {
  const userCountsByOuDn = new Map();
  const groupCountsByOuDn = new Map();
  const computerCountsByOuDn = new Map();
  for (const u of users || []) {
    const ouDn = u.ouDn || (u.distinguishedName ? stripFirstRdn(u.distinguishedName) : null);
    if (ouDn) userCountsByOuDn.set(ouDn, (userCountsByOuDn.get(ouDn) || 0) + 1);
  }
  for (const g of groups || []) {
    const dn = g.distinguishedName || '';
    if (/CN=Builtin(,|$)/i.test(dn)) continue;
    const ouDn = g.ouDn || stripFirstRdn(dn);
    if (ouDn) groupCountsByOuDn.set(ouDn, (groupCountsByOuDn.get(ouDn) || 0) + 1);
  }
  for (const c of computers || []) {
    const ouDn = c.ouDn || (c.distinguishedName ? stripFirstRdn(c.distinguishedName) : null);
    if (ouDn) computerCountsByOuDn.set(ouDn, (computerCountsByOuDn.get(ouDn) || 0) + 1);
  }
  return { userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn };
}

// buildOuTree(list, userCounts, groupCounts, computerCounts) → roots[].
//
// parentDn == null OR parentDn not present in map → root.
// Each node: { dn, name, parentDn, description, isBuiltin, children,
//              userCount, groupCount, computerCount, depth }.
// R158.44.7.10 — 加 computerCount (3rd counter, 跟 user/group 同形).
// R158.45.11 (2026-10-05) — operator "组和用户计算机信息没出来":
//   user/group/computer count 从 leaf 直接读改为**递归子节点求和**.
//   之前 root OU (DC=... 上面那层) 没有对应 ad_ous_snapshot entry, 直接读
//   userCounts.get(rootDn) 必 0; 现在递归累加子树总和, root 显示整域总数.
export function buildOuTree(list, userCounts = new Map(), groupCounts = new Map(), computerCounts = new Map()) {
  const map = new Map();
  for (const o of list || []) {
    const dn = o.distinguishedName || o.dn;
    if (!dn) continue;
    map.set(dn, {
      dn,
      name: o.name || firstRdnValue(dn),
      parentDn: o.parentDn || null,
      description: o.description || '',
      isBuiltin: /CN=Builtin(,|$)/i.test(dn),
      children: [],
      userCount: userCounts.get(dn) || 0,
      groupCount: groupCounts.get(dn) || 0,
      computerCount: computerCounts.get(dn) || 0
    });
  }
  const roots = [];
  for (const node of map.values()) {
    if (node.parentDn && map.has(node.parentDn)) {
      map.get(node.parentDn).children.push(node);
    } else {
      roots.push(node);
    }
  }
  // R158.45.11 — 子树计数递归求和到父节点. leaf 节点保留自己直接计数,
  //   中间节点 (含 root) = 自己直接 + 所有 descendants 累计.
  //   Builtin 容器排除递归 (它是叶子, 不应算 user/group 总数).
  function rollUp(n) {
    if (n.isBuiltin) return;        // Builtin 不递归 (它里面不是 OU, 不该被计数)
    if (!n.children.length) return;  // leaf, 保留 own userCount
    let u = n.userCount, g = n.groupCount, c = n.computerCount;
    for (const child of n.children) {
      rollUp(child);
      u += child.userCount;
      g += child.groupCount;
      c += child.computerCount;
    }
    n.userCount = u;
    n.groupCount = g;
    n.computerCount = c;
  }
  const walk = (n, d) => {
    n.depth = d;
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of n.children) walk(c, d + 1);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of roots) {
    rollUp(r);          // 先求和
    walk(r, 0);         // 再设 depth (顺序无关, 但求和须在 children sort 前 → 调整)
  }
  return roots;
}
