// R116 — OS Baseline status helpers (pure functions, no Vue runtime).
//
// Extracted from OsBaselineView.vue so the disk-threshold / worst-case /
// 综合合规状态算法 can be unit-tested without booting the Vue runtime.
// The Vue component imports these and re-uses them inside <script setup>;
// the test suite (center/tests/os-baseline.test.js) imports them directly
// to assert the operator-mandated thresholds verbatim.
//
// 算法来源 (R116 v2 plan):
//   - 磁盘已使用%: collected emit `disk_free` + `disk_total` (both JSON,
//     per-drive **bytes** from CIM Win32_LogicalDisk FreeSpace/Size —
//     see collect.ps1:10-14). 反向算 usedPct(d) = 100 * (1 - free / total).
//   - 多盘 worst-case: max(usedPct(d)) over all drives — 任一盘破阈即
//     黄/红 (operator: "超过 50% 为黄色表示,超过 80% 红色").
//   - 综合合规状态: ts > 2h → offline (灰); CPU≥95 OR Mem≥95 OR
//     DiskUsed≥80 → critical (红); CPU 80-95 OR Mem 80-95 OR DiskUsed
//     50-80 → warning (黄); else normal (绿). 优先级: 离线 > 严重 >
//     偏高 > 正常. 任一 cpu/mem/disk 触发就升级.
//   - disk_free 或 disk_total 缺失/破损 → 该格 N/A, 不混入合规状态
//     (数据问题 ≠ 合规问题).

export const OFFLINE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 小时
// R158.30.3 — disk warn/red thresholds lifted from 50/80 to 70/90 to match
// CPU/MEM (80/95) tolerance. Old 50% warn made every half-full disk read as
// "warning", which dragged OS Baseline cards into warning/critical even
// when CPU + memory were healthy — operator observed "CPU/内存都不高但
// 卡片整体仍偏高" because disk tile alone flipped computeStatus() to
// warning/critical. New 70/90 keeps the disk-vs-CPU/MEM weighting (disks
// fail harder than CPU saturates) but stops flagging routine 50–70%
// production use.
export const DISK_RED_PCT = 90;
export const DISK_WARN_PCT = 70;
export const CPU_RED_PCT = 95;
export const CPU_WARN_PCT = 80;
export const MEM_RED_PCT = 95;
export const MEM_WARN_PCT = 80;

// parseBytesObject: 把 disk_free / disk_total JSON 字符串解析成 Map<drive, bytes>.
// 缺失 / 解析失败 / 非对象 / 非数值 → 空 Map (调用方 → N/A, 不报红).
export function parseBytesObject(raw) {
  const out = new Map();
  if (typeof raw !== 'string' || raw.length === 0) return out;
  let obj;
  try { obj = JSON.parse(raw); } catch { return out; }
  if (!obj || typeof obj !== 'object') return out;
  for (const [drive, value] of Object.entries(obj)) {
    const n = Number(value);
    if (Number.isFinite(n)) out.set(drive, n);
  }
  return out;
}

// parseDiskPair: 把 disk_free + disk_total 配对成按盘的 [{drive, freeBytes,
// totalBytes, usedPct}]. 任一缺失 → []. 任一盘的 totalBytes <= 0 / freeBytes
// < 0 / 非有限值 → 该盘跳过 (其它盘仍返回).
export function parseDiskPair(freeRaw, totalRaw) {
  const free = parseBytesObject(freeRaw);
  const total = parseBytesObject(totalRaw);
  if (free.size === 0 || total.size === 0) return [];
  const out = [];
  for (const [drive, freeBytes] of free) {
    const totalBytes = total.get(drive);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    if (!Number.isFinite(freeBytes) || freeBytes < 0) continue;
    const usedPct = 100 * (1 - freeBytes / totalBytes);
    out.push({ drive, freeBytes, totalBytes, usedPct });
  }
  return out;
}

// worstDiskDrive: 取 usedPct 最大的盘 (任一盘破阈即黄/红). 空数组 → null.
export function worstDiskDrive(drives) {
  let worst = null;
  for (const d of drives) {
    if (worst === null || d.usedPct > worst.usedPct) worst = d;
  }
  return worst;
}

// computeStatus: 综合合规状态派生. 返回 'offline' | 'critical' | 'warning'
// | 'normal'. 参数全是 number 或 null; null → 该维度不参与判定 (用于
// 磁盘数据缺失 → 不报红). 优先级: 离线 > 严重 > 偏高 > 正常.
export function computeStatus({ lastSeenMs, nowMs, cpuPct, memoryPct, diskUsedPct }) {
  if (!Number.isFinite(lastSeenMs) || (nowMs - lastSeenMs) > OFFLINE_THRESHOLD_MS) {
    return 'offline';
  }
  const cpu = Number(cpuPct);
  const mem = Number(memoryPct);
  const cpuHigh = Number.isFinite(cpu) && cpu >= CPU_RED_PCT;
  const memHigh = Number.isFinite(mem) && mem >= MEM_RED_PCT;
  const diskHigh = diskUsedPct !== null && diskUsedPct !== undefined && diskUsedPct >= DISK_RED_PCT;
  if (cpuHigh || memHigh || diskHigh) return 'critical';
  const cpuMid = Number.isFinite(cpu) && cpu >= CPU_WARN_PCT;
  const memMid = Number.isFinite(mem) && mem >= MEM_WARN_PCT;
  const diskMid = diskUsedPct !== null && diskUsedPct !== undefined && diskUsedPct >= DISK_WARN_PCT;
  if (cpuMid || memMid || diskMid) return 'warning';
  return 'normal';
}

// diskClass / cpuClass / memClass: 用于前端 metric tile 着色 (CSS class).
export function diskClass(usedPct) {
  if (usedPct === null || usedPct === undefined) return 'metric-na';
  if (usedPct >= DISK_RED_PCT) return 'metric-critical';
  if (usedPct >= DISK_WARN_PCT) return 'metric-warning';
  return 'metric-normal';
}
export function cpuClass(pct) {
  if (!Number.isFinite(pct)) return 'metric-na';
  if (pct >= CPU_RED_PCT) return 'metric-critical';
  if (pct >= CPU_WARN_PCT) return 'metric-warning';
  return 'metric-normal';
}
export function memClass(pct) {
  if (!Number.isFinite(pct)) return 'metric-na';
  if (pct >= MEM_RED_PCT) return 'metric-critical';
  if (pct >= MEM_WARN_PCT) return 'metric-warning';
  return 'metric-normal';
}

// formatBytes: B / KB / MB / GB / TB. 用于 "最坏盘: D: 85.0% 已使用
// (123.4 GB / 500.0 GB)" 这类 sub-detail.
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(1)} ${units[u]}`;
}

// statusLabel: 综合合规状态 → 中文 badge 文案. 给 .status-badge 节点用.
export function statusLabel(status) {
  switch (status) {
    case 'offline':  return '离线';
    case 'critical': return '严重';
    case 'warning':  return '偏高';
    case 'normal':   return '正常';
    default:         return '未知';
  }
}

// formatPct: 把 0..100 的 number 渲染成 "12.3%" (一位小数). null/NaN → "N/A".
export function formatPct(pct) {
  if (!Number.isFinite(pct)) return 'N/A';
  return `${pct.toFixed(1)}%`;
}

// formatTime: 把 Date / ISO string / number → 本地时区 "YYYY-MM-DD HH:mm:ss".
// 给 .last-update / .absolute 这类绝对时间戳节点用.
export function formatTime(raw) {
  if (raw === null || raw === undefined || raw === '') return '未知';
  const d = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(d.getTime())) return '未知';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// formatRelative: 把 lastSeenMs (epoch ms) 渲染成 "刚刚 / x 分钟前 / x 小时前
// / x 天前 / 未知". 给 .last-seen .value 节点用.
export function formatRelative(lastSeenMs) {
  if (!Number.isFinite(lastSeenMs)) return '未知';
  const diff = Date.now() - lastSeenMs;
  if (diff < 0) return '刚刚';
  if (diff < 60 * 1000) return '刚刚';
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

// parseJson: 安全的 JSON.parse — 服务端可能送已破损 / 非 JSON 字符串.
// 成功返回对象; 失败 / 输入非 string / 空字符串 → 返回 null (调用方需 fallback).
export function parseJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v == null ? null : v;
  } catch {
    return null;
  }
}

// R147 — parseBiosInfo: 解析 bios_info JSON 字符串为
//   { manufacturer, name, version, release_date } 结构. 缺失 / 解析失败 / 非
//   对象 → 全部 null (调用方 N/A 渲染).
//
// 这是 collect.ps1 1.0.3 新加的 Win32_BIOS 快照. 所有字段允许 null —
// 老 agent (1.0.2 之前) 不会发出 bios_info,UI 渲染 "—".
export function parseBiosInfo(raw) {
  const empty = {
    manufacturer:  null,
    name:          null,
    version:       null,
    release_date:  null,
    serial_number: null  // R158.30 — Win32_BIOS.SerialNumber (collected since 1.0.4)
  };
  if (typeof raw !== 'string' || raw.length === 0) return empty;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return empty;
  return {
    manufacturer:  typeof obj.manufacturer  === 'string' ? obj.manufacturer  : null,
    name:          typeof obj.name          === 'string' ? obj.name          : null,
    version:       typeof obj.version       === 'string' ? obj.version       : null,
    release_date:  typeof obj.release_date  === 'string' ? obj.release_date  : null,
    serial_number: typeof obj.serial_number === 'string' ? obj.serial_number : null
  };
}

// R147 — parseDisksArray: 解析 disks JSON 字符串为
//   [{ letter, free_bytes, total_bytes, model, bus_type }] 数组. 这是 collect.ps1 1.0.3 新
//   加的物理盘 (DriveType=3) 列表 — 仅本地固定盘,过滤光驱/网络盘/虚拟盘.
// 缺失 / 解析失败 / 非数组 → 空数组 (调用方 N/A 渲染).
// R158.30 — extends each disk element with model (Get-PhysicalDisk FriendlyName) +
// bus_type (NVMe / SATA / SAS / ...). Only the C: drive's physical disk info is
// populated by collect.ps1 (using $physDisks[0]) — other letters fall back to
// null. 1.0.3 rows return null for these new fields.
export function parseDisksArray(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({
      letter:      typeof d.letter      === 'string' ? d.letter      : null,
      free_bytes:  typeof d.free_bytes  === 'number' && Number.isFinite(d.free_bytes)  ? d.free_bytes  : 0,
      total_bytes: typeof d.total_bytes === 'number' && Number.isFinite(d.total_bytes) ? d.total_bytes : 0,
      model:       typeof d.model       === 'string' ? d.model : null,
      bus_type:    typeof d.bus_type    === 'string' ? d.bus_type : null
    }))
    .filter((d) => d.letter && d.total_bytes > 0);
}

// R158.30 — parseSystemInfo: parses system_info JSON to
//   { manufacturer, model } (Win32_ComputerSystem Manufacturer + Model —
//   distinct from BIOS vendor in bios_info.manufacturer). Used for the
//   "服务器品牌" row in the hardware-detail section.
// 缺失 / 解析失败 / 非对象 → 全部 null (UI 渲染 "—").
export function parseSystemInfo(raw) {
  const empty = { manufacturer: null, model: null };
  if (typeof raw !== 'string' || raw.length === 0) return empty;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return empty;
  return {
    manufacturer: typeof obj.manufacturer === 'string' ? obj.manufacturer : null,
    model:        typeof obj.model        === 'string' ? obj.model        : null
  };
}

// R158.30 — parseNetworkInfo: parses network_info JSON to
//   { ipv4: [string, ...] } (Win32_NetworkAdapterConfiguration IPEnabled=True,
//   NetConnectionID regex-filtered against virtual adapters, IPv4 regex
//   `^\d{1,3}(\.\d{1,3}){3}$`, Select-Object -Unique by IPAddress).
// 缺失 / 解析失败 / 非对象 → 空 ipv4 数组 (UI 渲染 "—").
export function parseNetworkInfo(raw) {
  const empty = { ipv4: [] };
  if (typeof raw !== 'string' || raw.length === 0) return empty;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return empty;
  const rawArr = Array.isArray(obj.ipv4) ? obj.ipv4 : [];
  return {
    ipv4: rawArr
      .filter((ip) => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
  };
}

// R158.30 — parseMemoryModules: parses memory_modules JSON to
//   [{ manufacturer, part_number, speed_mhz, capacity_bytes }, ...]
//   (Win32_PhysicalMemory — one entry per physical DIMM). capacity_bytes
//   is cast from int64 in collect.ps1 to JS number; >2^53 fallback null
//   is moot since max practical DIMM is <2^48 bytes.
// 缺失 / 解析失败 / 非数组 → 空数组 (UI 渲染 "—").
export function parseMemoryModules(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      manufacturer:   typeof m.manufacturer === 'string' ? m.manufacturer : null,
      part_number:    typeof m.part_number  === 'string' ? m.part_number  : null,
      speed_mhz:      typeof m.speed_mhz    === 'number' && Number.isFinite(m.speed_mhz) ? m.speed_mhz : null,
      capacity_bytes: typeof m.capacity_bytes === 'number' && Number.isFinite(m.capacity_bytes) ? m.capacity_bytes : null
    }))
    .filter((m) => m.part_number || m.capacity_bytes);  // 至少有一个信号
}

// R158.30 — formatMemoryModulesSummary: 友好的内存型号摘要.
// 1 module: "Samsung M393A2K43BB1-CTD @ 2666 MHz — 32.0 GB"
// N identical: "Samsung M393A2K43BB1-CTD × 4 @ 2666 MHz — 128.0 GB total"
// N mixed (same part_number): "Samsung M393A2K43BB1-CTD × 4 — 128.0 GB total" (省 speed)
// N mixed (different part_number): "4 modules — 128.0 GB total" (降级)
// 空数组 → null (UI 不显示该行).
export function formatMemoryModulesSummary(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return null;

  const totalBytes = modules.reduce((s, m) => s + (m.capacity_bytes || 0), 0);
  const totalGB = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
  const count = modules.length;

  // 找众数 part_number (出现最多的)
  const partCounts = new Map();
  for (const m of modules) {
    const pn = m.part_number;
    if (!pn) continue;
    partCounts.set(pn, (partCounts.get(pn) || 0) + 1);
  }
  let dominantPart = null;
  let dominantCount = 0;
  for (const [pn, c] of partCounts) {
    if (c > dominantCount) { dominantPart = pn; dominantCount = c; }
  }

  // 找众数 speed
  const speedCounts = new Map();
  for (const m of modules) {
    const sp = m.speed_mhz;
    if (!sp) continue;
    speedCounts.set(sp, (speedCounts.get(sp) || 0) + 1);
  }
  let dominantSpeed = null;
  let dominantSpeedCount = 0;
  for (const [sp, c] of speedCounts) {
    if (c > dominantSpeedCount) { dominantSpeed = sp; dominantSpeedCount = c; }
  }

  // 全部 part_number + speed 都一致
  if (dominantPart && dominantCount === count && dominantSpeed && dominantSpeedCount === count) {
    return `${dominantPart} × ${count} @ ${dominantSpeed} MHz — ${totalGB} GB total`;
  }
  // 全部 part_number 一致 (speed 有差异)
  if (dominantPart && dominantCount === count) {
    return `${dominantPart} × ${count} — ${totalGB} GB total`;
  }
  // 降级
  return `${count} ${count === 1 ? 'module' : 'modules'} — ${totalGB} GB total`;
}

// diskPct — 给定 free + total → 0..100 的已使用百分比. total<=0 / 非数字 → null.
export function diskPct(freeBytes, totalBytes) {
  if (typeof freeBytes !== 'number' || typeof totalBytes !== 'number') return null;
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return null;
  if (totalBytes <= 0) return null;
  return Math.round((1 - freeBytes / totalBytes) * 1000) / 10;
}