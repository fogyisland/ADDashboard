// 在 SPA bundle 里找 partner-port-health/all 数据渲染逻辑
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');
const idx = src.indexOf('getPartnerPortHealthAll');
if (idx < 0) { writeFileSync('C:\\agentInstall\\agent\\data\\pp-render.txt', 'not found'); process.exit(0); }
// 找下一个 1000 字符，看怎么用返回的数据
const slice = src.slice(idx, idx + 2500);
writeFileSync('C:\\agentInstall\\agent\\data\\pp-render.txt', slice);