// 抓 raw stdout/stderr 看 repadmin 这次输出
import { spawn } from 'node:child_process';
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\agentInstall\\agent\\data\\packages\\ad_partner_ports_probe\\1.0.0\\collect.ps1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const out = [], err = [];
child.stdout.on('data', (d) => out.push(d));
child.stderr.on('data', (d) => err.push(d));
child.on('exit', (code) => {
  const o = Buffer.concat(out);
  const e = Buffer.concat(err);
  console.log('exit:', code, 'stdout bytes:', o.length, 'stderr bytes:', e.length);
  console.log('--- stdout raw ---');
  console.log(o.toString('utf8'));
  console.log('--- stderr raw ---');
  console.log(e.toString('utf8'));
});