// 从 SPA bundle 找 packages-runs / partner-port-health 的响应处理
import { readFileSync } from 'node:fs';

const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');

// 找 packages-runs 周围 500 字符的上下文
const idx1 = src.indexOf('packages-runs');
const idx2 = src.indexOf('partner-port-health');

const showAround = (label, idx) => {
  if (idx < 0) { console.log(`\n=== ${label} not found ===`); return; }
  // 找最近的 .metrics / .peers / partner_port
  for (const kw of ['peers', 'partner_port', 'metrics', 'destDc', 'dest_dc', 'PartnerPortStatus', 'partnerPortStatus', 'sourceDc']) {
    const i = src.indexOf(kw, Math.max(0, idx - 1000));
    if (i > 0 && i < idx + 2000) {
      console.log(`\n=== ${label} :: ${kw} @ ${i} ===`);
      console.log(src.slice(Math.max(0, i - 100), i + 300));
      console.log('---');
    }
  }
};

showAround('packages-runs', idx1);
showAround('partner-port-health', idx2);