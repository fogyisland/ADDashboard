// 找 getPartnerPortHealthAll 被调用的位置（看返回数据怎么被消费）
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');
const fn = 'getPartnerPortHealthAll';
let out = [];
let idx = 0;
while ((idx = src.indexOf(fn, idx + 1)) >= 0) {
  out.push(`idx=${idx}\n${src.slice(Math.max(0, idx - 50), idx + 200)}\n---`);
}
writeFileSync('C:\\agentInstall\\agent\\data\\pp-consumer.txt', out.join('\n'));