// 找 getPackagesRuns 的所有调用位置 + 数据消费方式
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');
const fn = 'getPackagesRuns';
let out = [];
let idx = 0;
let n = 0;
while ((idx = src.indexOf(fn, idx + 1)) >= 0) {
  n++;
  out.push(`idx=${idx}\n${src.slice(Math.max(0, idx - 50), idx + 400)}\n---`);
  if (n > 5) break;
}
writeFileSync('C:\\agentInstall\\agent\\data\\pkgruns-consumer.txt', out.join('\n'));