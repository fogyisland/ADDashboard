// 从 SPA bundle 抽出所有 fetch 路径
import { readFileSync } from 'node:fs';

const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');
// 提取所有看起来像 URL path 的字符串: /api/... 或 /admin/...
const re = /["'`]\/?((?:api|admin|config|partner|packages|runs|heartbeat|report|discover|ports|replication|file-push|ad-commands|member-commands)\/[a-zA-Z0-9_\-/{}.:?&=%]+)["'`]/g;
const seen = new Set();
let m;
while ((m = re.exec(src)) !== null) {
  const p = m[1];
  if (!seen.has(p)) {
    seen.add(p);
    console.log(p);
  }
}