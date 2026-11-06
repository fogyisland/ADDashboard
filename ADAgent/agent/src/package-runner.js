import { spawn as defaultSpawn } from 'node:child_process';
import { basename, dirname } from 'node:path';

// Runs a package's PowerShell collect script with the JSON config piped on
// stdin. The script's expected output is zero or more lines of text followed
// by a final line containing JSON `{"metrics":{...}}` — anything before the
// JSON line is treated as free-form log output and discarded.
//
// `spawnFn` is injectable so tests can stub the child process without
// requiring PowerShell on PATH.
//
// 2026-09-27 — buffer raw stdout/stderr bytes instead of decoding each
// chunk as utf8. PowerShell 5.1's pipe stdout follows the system console
// codepage (zh-CN -> CP936 / GBK), so Chinese characters in the script's
// free-form text or in PS exception messages arrive as 2-byte GBK sequences.
// Decoding per-chunk with utf8 turns them into U+FFFD replacement chars,
// which then propagate through JSON.stringify as the EF BF BD bytes that
// downstream metricstore parsers surface as 锟斤拷-style mojibake. We now
// collect raw bytes and run a BOM-aware best-effort decode at the end so
// scripts that explicitly set [Console]::OutputEncoding = UTF8 (and emit
// a UTF-8 BOM) keep that encoding end-to-end, while scripts that emit
// pure GBK (or a mix) are decoded as GBK.
export function runPackageScript({
  scriptPath,
  params,
  timeoutMs = 30000,
  logger,
  spawnFn,
  powerShellPath = 'powershell.exe',
  env = null,   // 2026-09-27 — env vars to inject into the spawned PowerShell.
                // Scripts that read $env:CENTER_URL / $env:AGENT_AUTH_TOKEN etc.
                // (e.g. ad_partner_ports_probe which calls centre's
                // /api/agent/replication-partners) need the agent to forward
                // these so the script can authenticate. Without this, the
                // script falls back to its "no env" branch and emits empty
                // peers[] — exactly what was seen in 14:13 / 14:18 cycles.
}) {
  const spawn = spawnFn || defaultSpawn;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // Merge: agent process's full env (PATH, SystemRoot, etc. PS still
    // needs these) + caller-supplied overrides. spawn() with
    // options.env=undefined inherits the parent env, but if we pass env
    // at all we MUST include everything PS needs (PATH etc.) — that's
    // why we start from process.env and shallow-merge caller overrides.
    const childEnv = env
      ? { ...process.env, ...env }
      : process.env;
    const child = spawn(powerShellPath, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], { windowsHide: true, env: childEnv });

    // 2026-09-27 — raw byte buffers; decode once at the end. See header
    // comment for why utf8-per-chunk was wrong.
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const decodeBestEffort = (buf) => {
      if (!buf || buf.length === 0) return '';
      // BOM sniffing — script may have set [Console]::OutputEncoding = UTF8
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString('utf8');
      }
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.subarray(2).toString('utf16le');
      }
      // Strict UTF-8 first; if no replacement chars, keep it.
      try {
        const strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return strict;
      } catch { /* fall through */ }
      // Fall back to GBK (zh-CN PowerShell pipe default for Chinese scripts)
      try {
        return new TextDecoder('gbk', { fatal: false }).decode(buf);
      } catch { /* fall through */ }
      // Last resort: lossy UTF-8 (introduces U+FFFD but never throws)
      return buf.toString('utf8');
    };

    const timer = setTimeout(() => {
      logger?.warn({ scriptPath, timeoutMs }, 'package script timeout');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      const stdoutB = Buffer.concat(stdoutChunks);
      const stderrB = Buffer.concat(stderrChunks);
      const stdout = decodeBestEffort(stdoutB);
      const stderr = decodeBestEffort(stderrB);
      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: -1,
        metrics: null,
        error: `timeout after ${timeoutMs}ms`,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdoutChunks.push(d); });
    child.stderr.on('data', (d) => { stderrChunks.push(d); });

    // Pipe config on stdin: { name, params }. The PS script reads via
    // [Console]::In.ReadToEnd() and parses with ConvertFrom-Json.
    try {
      const name = basename(dirname(scriptPath));
      child.stdin.write(JSON.stringify({ name, params: params || {} }));
      child.stdin.end();
    } catch {
      // stdin may already be closed if the process errored before we wrote
    }

    child.on('error', (err) => {
      const stdoutB = Buffer.concat(stdoutChunks);
      const stderrB = Buffer.concat(stderrChunks);
      const stdout = decodeBestEffort(stdoutB);
      const stderr = decodeBestEffort(stderrB);
      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: -1,
        metrics: null,
        error: err.message,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
      });
    });

    child.on('exit', (code) => {
      const stdoutB = Buffer.concat(stdoutChunks);
      const stderrB = Buffer.concat(stderrChunks);
      const stdout = decodeBestEffort(stdoutB);
      const stderr = decodeBestEffort(stderrB);

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      let metrics = null;
      let parsed = null;
      let parseError = null;
      if (lastLine) {
        try {
          parsed = JSON.parse(lastLine);
          metrics = parsed && typeof parsed === 'object' ? (parsed.metrics ?? null) : null;
        } catch (e) {
          parseError = `stdout does not end with valid JSON: ${lastLine.slice(0, 200)}`;
        }
      } else {
        // R158.50.7 (2026-10-07) — PowerShell parse error 写到 stderr 不是 stdout
        // (本机 GBK codepage 反向解析 UTF-8 中文导致 ParserError), 但旧 reporter
        // 直接说 "no stdout produced" 把诊断信息丢了. 现在从 stderr 提 file:line
        // + FullyQualifiedErrorId + 错误消息, 让 operator 在 /packages-runs 失败
        // 行直接看到 "PS parse-error at <file>:<line>: <fqid>" + 一行 raw 错误.
        // 例: "ps parse-error at D:\...\collect.ps1:216 UnexpectedToken | ..."
        const stderrText = stderr || '';
        // 匹配 file:line + FullyQualifiedErrorId — 不依赖 "字符" 这种本地化词,
        // 因为 CN/EN PS 输出格式不同 (中文 PS 用 "字符:" + 中文消息, 英文 PS 用
        // "char:" + EN 消息). 用 .ps1:NN 这种 ASCII 边界 + FullyQualifiedErrorId
        // 锚定, 两者都是 PS 固定输出.
        const peMatch = stderrText.match(/(?:^|\s)([A-Za-z]:[^\r\n:]+?\.ps1):(\d+)[\s\S]+?FullyQualifiedErrorId\s*:\s*(\S+)/);
        if (peMatch) {
          const file = peMatch[1];
          const line = peMatch[2];
          const fqid = peMatch[3];
          // 取 ASCII 错误消息行 — 跳过前导 '+ xxx' 指示行, 找首个不 '+ ' 开头的行
          const lines2 = stderrText.split(/\r?\n/);
          let errLine = '';
          for (const ln of lines2) {
            const t = ln.trim();
            if (!t) continue;
            if (t.startsWith('+') || t.startsWith('~')) continue;
            if (t.startsWith('At')) continue;
            if (t.startsWith('+ CategoryInfo') || t.startsWith('+ FullyQualifiedErrorId')) continue;
            errLine = t;
            break;
          }
          parseError = `ps parse-error at ${file}:${line}: ${fqid} | ${errLine.replace(/\s+/g, ' ').slice(0, 200)}`;
        } else if (stderrText.trim()) {
          // 任意 stderr 非空 (runtime exception / 模块缺失 / Get-WinEvent 真异常)
          // 取首非空行作为 hint
          const firstLine = stderrText.split(/\r?\n/).find(l => l.trim()) || '';
          parseError = `ps stderr: ${firstLine.replace(/\s+/g, ' ').slice(0, 400)}`;
        } else {
          parseError = 'no stdout produced (ps exited with no output; likely killed before any code ran)';
        }
      }

      // R158.50.6 (2026-10-07) — PS1 内部异常写到 stdout JSON `error` 字段。
      // PS1 try/catch 抓异常 + exit 0 → exit code 干净, 旧版 reporter 看
      // `metrics.error_code` 也只标 boolean, 不进 r.error. 现把 `parsed.error`
      // 显式覆盖 r.error, 让 centre runner.js:586 status='failed' 真生效.
      // 优先级: parsed.error (PS1 显式) > parseError (stdout 不是 JSON) >
      // exit non-zero (spawn 层). parsed 必须 truthy 且 error 必须非空字符串.
      // R158.50.7c (2026-10-07) — PS1 顶层 `error` 字段改成非空占位符
      // (`'ok'` for normal / 异常 message for catch). 'ok' 不进 r.error(避免
      // DB `error` 列被 'ok' 字符串污染, 也避免 status='failed' 误判),
      // 真异常等 mode 仍 `ps1: <msg>` → centre runner.js:586 status='failed'.
      let ps1Error = null;
      if (parsed && typeof parsed === 'object' && parsed.error != null) {
        const s = String(parsed.error).trim();
        if (s.length > 0 && s !== 'ok') ps1Error = s.slice(0, 500);
      }

      let error = null;
      if (ps1Error)        error = `ps1: ${ps1Error}`;
      else if (parseError) error = parseError;
      else if (code !== 0) error = `exit ${code}: ${stderr.slice(0, 200)}`;

      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: code,
        metrics,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
        // R158.50.7c (2026-10-07) — finish() 加 `stderr` 字段 (完整文本,
        // 不止 2048 截断). centre runner.js:545 `run.stderr ? ... : null`
        // 期望这个字段, 之前永远 undefined → DB stderr_preview 只剩
        // R158.11.2 agent_cache banner + R158.25 ingest trace, 真 catch 文本
        // 看不到. 改完后真 stderr 进 DB, operator 在 /packages-runs L2 能
        // 看到 catch 行.
        stderr,
        error,
      });
    });
  });
}
