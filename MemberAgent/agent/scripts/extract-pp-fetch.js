// 在 bundle 里找 "partner-port-health/all" 周围 fetch 调用
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', 'utf8');
const idx = src.indexOf('partner-port-health/all');
const start = Math.max(0, idx - 800);
const end = Math.min(src.length, idx + 200);
writeFileSync('C:\\agentInstall\\agent\\data\\pp-fetch.txt', src.slice(start, end));