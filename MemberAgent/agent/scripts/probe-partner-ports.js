// 直接调用 runPackageScript 跑 ad_partner_ports_probe，看 stdout + stderr
import { runPackageScript } from '../src/package-runner.js';

const scriptPath = 'C:\\agentInstall\\agent\\data\\packages\\ad_partner_ports_probe\\1.0.0\\collect.ps1';
const params = {};

const result = await runPackageScript({ scriptPath, params, timeoutMs: 60000 });
console.log('exitCode:', result.exitCode);
console.log('error:', result.error);
console.log('metrics:', JSON.stringify(result.metrics, null, 2));
console.log('\n=== stderrPreview (first 800) ===');
console.log(result.stderrPreview?.slice(0, 800));
console.log('\n=== stdoutPreview (first 800) ===');
console.log(result.stdoutPreview?.slice(0, 800));