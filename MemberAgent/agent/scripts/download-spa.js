// 下载 SPA bundle，grep 出 frontend 实际 fetch 的 URL
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const url = 'http://10.170.140.23:8080/assets/index-mfJz1FcD.js';
const u = new URL(url);
http.request({
  method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname,
}, (res) => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    writeFileSync('C:\\agentInstall\\agent\\data\\spa-bundle.js', buf);
    console.log('saved, bytes:', buf.length);
  });
}).end();