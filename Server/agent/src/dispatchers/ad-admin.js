import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 2026-08-31 R75 — Real agent JS dispatcher for AD user/group commands.
//
// Bridges queued `user_*` and `group_*` commands (queued in center,
// polled via /api/agent/ad-commands) to the matching PowerShell
// scripts under agent/scripts/. Mirrors the shape of
// center/mock-ad-admin.mjs::dispatchMockAdCommand so the center-side
// audit classifier + result handler don't care whether the executor
// was the mock store or a real DC.
//
// Contract:
//   dispatchAdCommand({ commandType, params, powerShellPath?, scriptsDir?,
//                       timeoutMs?, spawnFn?, nowFn? })
//     → Promise<{ success, data, error, exitCode, durationMs }>
//
// - `commandType` MUST start with "user_" or "group_". The prefix
//   decides which PS1 script is invoked (ad-admin-users.ps1 vs
//   ad-admin-groups.ps1).
// - `params` is the JSON object the PS1 reads via ConvertFrom-Json.
//   It is written to a unique temp file (-ParamsPath) and the file is
//   deleted on the way out (best-effort).
// - `spawnFn` is injectable for unit tests; defaults to node:child_process spawn.
// - On spawn / parse / non-zero-exit failures we synthesize a result
//   envelope with success:false — the center-side handler only ever
//   consumes a result envelope, not a thrown error.
//
// Password fields are NEVER copied into data on the way back. The PS1
// scripts don't echo them on stdout, and the dispatcher does not log
// `params` either (per spec §8 ruling #8 — passwords redacted
// everywhere downstream of the cmdlet call).

const USER_PREFIX = 'user_';
const GROUP_PREFIX = 'group_';
const DEFAULT_TIMEOUT_MS = 60_000;

// R158.40 (2026-10-03) — ADUC 写动作补齐. `ou_` / `object_` prefix 走包路径
// (镜像 R158.34 quickfix 的 dispatch 风格 — package-manager syncFromCenter 把
// collect.ps1 拉到 agentDataDir/cache/<pkgName>/<version>/collect.ps1). 这是
// 跟老 17 个 user_/group_ 命令的关键架构差异: 老 17 个走 agent/scripts/ 静态
// PS1, 本轮 3 个走包分发 (manifest.type=command, argv 风格跟 quickfix 一致).
const OU_PREFIX = 'ou_';
const OBJECT_PREFIX = 'object_';

// R158.40 — 包名映射. 中心 data/packages/ad_ad_<op>/1.0.0/collect.ps1.
// 版本号在中心改包时同步更新这里 (跟 R158.34 quickfix 1.0.0 模式一致).
// R158.56c (2026-10-08) — 临时撤回 object_delete. operator directive
// "将ad_object_delete 删除, 当前我们不需要删除对象, 避免出错删除对象".
// ad_ad_object_delete 1.0.0 PS1 + manifest + content.sha256 + DB row 保留在
// 仓库, 等以后真需要时一键恢复 (删 BUILTIN_PACKAGES 注释 + 改这里加回).
// 撤回期间, POST /api/admin/ad-commands {commandType: 'object_delete'}
// 走 pickScript → unsupported commandType prefix → error envelope,
// centre 写 ad_admin_commands.status=failed, 不调 agent PS1.
// R158.60.10-final (2026-10-09) — agent bundle 静态路径 (跟 user_/group_
//   走 ad-admin-users.ps1 / ad-admin-groups.ps1 一样的 dispatch 风格).
//   operator directive "放在客户端执行, 这些操作不用在 center 实现":
//     - 中心端 BUILTIN_PACKAGES 列表里 4 个 ad_ad_* 不再注册
//     - DB package_scripts / package_policies 也不再有 4 包行
//     - /admin/packages UI 也不显 (ONDEMAND_PACKAGES 静态 set 不含)
//   但 R75 dispatchAdCommand 必须仍能派发 ou_create / object_move 命令
//   (operator 在 /admin/daily-ops 用户管理界面提交, 中心入 ad_admin_commands
//   队列, agent 端 R75 拉取执行). R75 走 cache 路径需要 centre publish
//   维护 4 个 package, 跟 operator 上述 directive 冲突.
//
//   解法: 4 个 ad_ad_* collect.ps1 拷到 agent/scripts/ 静态副本, R75
//   pickScript 走 'ad-ad-ou-create.ps1' / 'ad-ad-object-move.ps1' 静态
//   文件名, 跟 user_/group_ 一样. 这等同把 4 包从 "center-managed package"
//   降级为 "agent-bundled script", 跟 R158.46 (17 个 user_/group_ 命令
//   走静态 PS1) 同一架构风格. ship 时只改 agent dispatcher JS, 不动
//   中心端 (R158.60.10-rollback 状态保持: 中心 0 状态).
//
//   静态副本位置: agent/scripts/ad-ad-ou-create.ps1, 跟 user_/group_ 静态
//   副本 agent/scripts/ad-admin-users.ps1 同目录, 部署时跟 agent.js 一起
//   checkout 即可, 不需中心 publish.
const PACKAGE_COMMAND_MAP = Object.freeze({
  // ou_create → 静态副本 agent/scripts/ad-ad-ou-create.ps1, argv 风格
  //   (--action create --parentDn ... --name ...). 跟 R158.40 R75
  //   fromPackage 路径同款 dispatch (params 平铺 argv, 不写临时文件).
  ou_create:       { script: 'ad-ad-ou-create.ps1', argvStyle: true },
  // object_move → 静态副本 agent/scripts/ad-ad-object-move.ps1, argv 风格
  object_move:     { script: 'ad-ad-object-move.ps1', argvStyle: true }
  // object_delete:  R158.56c 撤回 — see comment above
  // ad_ad_users_write / ad_ad_groups_write / ad_ad_account_quickfix:
  //   R158.56c ship 时注册的"包"实际从未在 R75 pickScript 暴露
  //   (user_create / group_create 等 17 个 commandType 一直走
  //   ad-admin-users.ps1 / ad-admin-groups.ps1 静态路径, PS1 内部 switch
  //   处理). 这 3 个包是 R158.56c 死代码, R158.60.10-rollback 一起下线.
});

// Resolve the default scripts directory. agent/scripts/ lives next to
// agent/src/ — we derive it from this file's location using
// fileURLToPath so it works regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SCRIPTS_DIR = resolve(dirname(__filename), '..', '..', 'scripts');

function pickScript(commandType, scriptsDir) {
  if (typeof commandType !== 'string' || commandType.length === 0) {
    return { error: 'commandType required' };
  }
  if (commandType.startsWith(USER_PREFIX)) {
    return { script: 'ad-admin-users.ps1' };
  }
  if (commandType.startsWith(GROUP_PREFIX)) {
    return { script: 'ad-admin-groups.ps1' };
  }
  // R158.60.10-final (2026-10-09) — ou_create / object_move 走 agent bundle
  //   静态脚本, 跟 user_/group_ 同款 (从 cache 路径改成 DEFAULT_SCRIPTS_DIR
  //   静态文件). 中心端不再 publish 4 个 ad_ad_* 包, 但 R75 dispatchAdCommand
  //   仍能在 agent/scripts/ 找到 ad-ad-ou-create.ps1 / ad-ad-object-move.ps1.
  if (commandType.startsWith(OU_PREFIX) || commandType.startsWith(OBJECT_PREFIX)) {
    const entry = PACKAGE_COMMAND_MAP[commandType];
    if (entry) {
      // 静态路径 + argv 风格 (跟 R158.40 R75 fromPackage 路径同款 dispatch
      //   行为). argvStyle 字段在 dispatchAdCommand 主入口驱动
      //   `usePackageDriver=true` 分支, 让 params 平铺 argv 而不写
      //   -ParamsPath 临时文件. 跟 user_/group_ 走 -CommandType + -ParamsPath
      //   JSON 风格 不一样, 是 ou_create / object_move 命令的 R158.40 协议.
      return { script: entry.script, argvStyle: !!entry.argvStyle };
    }
    return { error: `unsupported R158.40 commandType: ${commandType}` };
  }
  return { error: `unsupported commandType prefix: ${commandType}` };
}

function writeParamsFile(params) {
  const dir = mkdtempSync(join(tmpdir(), 'addash-ad-admin-'));
  const file = join(dir, 'params.json');
  // Stringify with deterministic ordering? Keep it simple — JSON.stringify
  // default is fine because PS1 only consumes it back via ConvertFrom-Json.
  writeFileSync(file, JSON.stringify(params || {}), { encoding: 'utf8' });
  return { dir, file };
}

// R158.40 (2026-10-03) — 把 params 对象平铺成 quickfix 风格的 argv.
// 比如 { parentDn: 'OU=X,DC=corp,DC=local', name: 'TestOU', description: 'd' }
// → ['--action','create','--parentDn','OU=X,DC=corp,DC=local','--name','TestOU','--description','d'].
// 数字自动 toString, null/undefined 跳过. 字符串值含空格或 ' " ' 用单引号包裹.
function flattenParamsToArgs(commandType, params) {
  const out = ['--action', mapActionForCommand(commandType)];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    out.push(`--${k}`, typeof v === 'number' ? String(v) : quoteForPowerShell(String(v)));
  }
  return out;
}

function mapActionForCommand(commandType) {
  // R158.40 — 单一 commandType 单一 action. ou_create → create;
  // object_move → move; object_delete → delete. 跟 collect.ps1 的 switch-case 对齐.
  const m = {
    ou_create:     'create',
    object_move:   'move',
    object_delete: 'delete'
  };
  return m[commandType] || 'unknown';
}

function quoteForPowerShell(s) {
  if (/[\s'"\\]/.test(s)) {
    // 包外层单引号, 内嵌 ' 用 '' 重复
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}

// Execute the picked PS1 script and resolve with a normalized result
// envelope. NEVER throw — any internal error becomes
// { success:false, error, exitCode:2 }.
function executeScript({ scriptPath, commandType, paramsPath, params, timeoutMs, powerShellPath, spawnFn, logger }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // R158.40 — 包驱动命令 (ou_create / object_move / object_delete) 走
    // quickfix 风格的 argv (--action create --parentDn ...). 老 user_/group_
    // 命令走 -CommandType + -ParamsPath JSON 文件风格. pickScript 通过
    // `fromPackage` 字段标识包驱动, dispatcher 自身不感知该字段 — 它只传
    // scriptPath 进来; 区分靠 caller (dispatchAdCommand) 是否传了 params.
    const pickFromCaller = Boolean(params && typeof params === 'object');
    const args = pickFromCaller
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          ...flattenParamsToArgs(commandType, params)
        ]
      : [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-CommandType', commandType,
          '-ParamsPath', paramsPath,
        ];
    let child;
    try {
      child = spawnFn(powerShellPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({
        success: false,
        data: null,
        error: `spawn failed: ${err && err.message ? err.message : String(err)}`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({
        success: false,
        data: null,
        error: `timeout after ${timeoutMs}ms`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      finish({
        success: false,
        data: null,
        error: `process error: ${err && err.message ? err.message : String(err)}`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      // The PS1 script emits the result envelope as a single JSON line
      // on stdout. Parse the last non-empty line.
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine);
          if (parsed && typeof parsed === 'object' && 'success' in parsed) {
            // Trust the PS1 envelope; just normalize exitCode.
            return finish({
              success: !!parsed.success,
              data: parsed.data ?? null,
              error: parsed.error ?? null,
              exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : (parsed.success ? 0 : 1),
              durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : durationMs,
            });
          }
        } catch {
          // fall through to exit-code fallback
        }
      }
      // No parseable envelope — synthesize a failure from exit code.
      if (code === 0) {
        // Exited 0 but no JSON — that's still a failure, but not 5xx-grade.
        logger?.warn({ scriptPath, stdoutPreview: stdout.slice(0, 200) }, 'ad-admin script exited 0 without result envelope');
        return finish({
          success: false,
          data: null,
          error: `script produced no result envelope (exit 0)`,
          exitCode: 1,
          durationMs,
        });
      }
      return finish({
        success: false,
        data: null,
        error: `exit ${code}: ${(stderr || '').trim().slice(0, 500) || 'no stderr'}`,
        exitCode: typeof code === 'number' ? code : 1,
        durationMs,
      });
    });
  });
}

// Main exported entrypoint. Returns a normalized result envelope.
// Always resolves — NEVER throws — so callers (e.g. the ad-commands
// drainer in heartbeat loops) can safely await without try/catch.
export async function dispatchAdCommand({
  commandType,
  params,
  powerShellPath = 'powershell.exe',
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn,
  logger,
} = {}) {
  const startedAt = Date.now();

  const pick = pickScript(commandType, scriptsDir);
  if (pick.error) {
    return {
      success: false,
      data: null,
      error: pick.error,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  // R158.40 — 包驱动命令的 scriptPath 从 package-manager cacheDir 拼.
  // scriptsDir 在包路径场景下被 caller (agent.js drainAdCommands 装配时) 替换为
  // `<agentDataDir>/cache` (跟 package-manager.js 写入路径对齐). 这里
  // 默认兜底: 若 caller 没传, 用 scriptsDir + 相对路径.
  //
  // R158.56c (2026-10-08) — 老 user_/group_ 命令的 scriptsDir 强制用
  // dispatcher 内部 DEFAULT_SCRIPTS_DIR (= `agent/scripts/`, 从 __filename
  // 推导), **不信任 caller 注入的 scriptsDir**. R158.40 caller 注入的
  // scriptsDir 是 cacheDir (`<dataDir>/packages`), 用它拼老命令路径会得到
  // `<dataDir>/packages/ad-admin-users.ps1` — 而老 PS1 实际在
  // `agent/scripts/ad-admin-users.ps1`, 永远 ENOENT.
  // caller 不区分 commandType 把所有 commandType 传同一个 cacheDir,
  // 路径解析必须由 dispatcher 按 pick.fromPackage 分支. 包驱动用 caller
  // 注入的 scriptsDir (即 cacheDir), 老命令用 DEFAULT_SCRIPTS_DIR.
  let scriptPath;
  // R158.60.10-final (2026-10-09) — usePackageDriver 改成由 pick.argvStyle
  //   驱动 (R158.40 时期是 pick.fromPackage 驱动). 现在 ou_create /
  //   object_move 走静态脚本 (无 fromPackage), 但仍 argv 风格 — 所以
  //   argvStyle 才是真 dispatch 协议信号, fromPackage 仅在 R158.40 时期
  //   跟 argvStyle 1:1 绑定. user_/group_ 走 -ParamsPath 临时文件风格,
  //   usePackageDriver 永远 false.
  let usePackageDriver = false;
  if (pick.fromPackage) {
    // R158.40 老路径 (centre publish 时有效) — 当前 BUILTIN 没这 4 个
    //   ad_ad_* 包, listEnabledGlobal 不返, cache removeCache, 不会触发.
    //   保留兜底: 万一 operator 临时把 BUILTIN 加回, 老 33 DC 仍能跑.
    scriptPath = join(scriptsDir, pick.fromPackage, pick.version, pick.script);
    usePackageDriver = true;
  } else if (pick.argvStyle) {
    // R158.60.10-final — 静态脚本但 argv 风格. 走 DEFAULT_SCRIPTS_DIR 拼,
    //   usePackageDriver=true 走 argv 路径 (params 平铺).
    scriptPath = join(DEFAULT_SCRIPTS_DIR, pick.script);
    usePackageDriver = true;
  } else {
    // user_/group_ 老 17 个命令 — 静态脚本, -ParamsPath 临时文件风格.
    scriptPath = join(DEFAULT_SCRIPTS_DIR, pick.script);
  }

  let paramsPath = null;
  let paramsDir = null;
  try {
    // R158.40 — 包驱动命令不写临时文件, params 直接平铺 argv (quickfix 风格).
    // 老 user_/group_ 命令保留 JSON 临时文件路径. R158.60.10-final —
    // argvStyle 路径同上, 静态脚本但 argv 风格 — params 仍平铺 argv.
    let tmp = null;
    if (!usePackageDriver) {
      tmp = writeParamsFile(params);
      paramsPath = tmp.file;
      paramsDir = tmp.dir;
    }

    const result = await executeScript({
      scriptPath,
      commandType,
      paramsPath,
      params: usePackageDriver ? params : null,
      timeoutMs,
      powerShellPath,
      spawnFn: spawnFn || ((pp, args, opts) => spawn(pp, args, opts)),
      logger,
    });
    return result;
  } finally {
    // Best-effort cleanup of the params blob. If the script is still
    // running we leave the dir in place — the OS will reap tmpdir on
    // reboot.
    if (paramsPath) {
      try { unlinkSync(paramsPath); } catch { /* ignore */ }
    }
  }
}

// Convenience helper — same contract as dispatchMockAdCommand in
// center/mock-ad-admin.mjs. Exists so center-side tests / smoke
// drivers can call a single canonical name regardless of mock vs real.
export const dispatchAdAdminCommand = dispatchAdCommand;

export const __testing = {
  pickScript,
  writeParamsFile,
  DEFAULT_SCRIPTS_DIR,
  DEFAULT_TIMEOUT_MS,
  USER_PREFIX,
  GROUP_PREFIX,
};