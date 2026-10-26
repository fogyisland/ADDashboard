// 直接 GET 前端 dashboard 用的 partner-port-health endpoint，看里面到底有没有数据
import http from 'node:http';

const get = (url) => new Promise((resolve) => {
  const u = new URL(url);
  const req = http.request({
    method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { 'Accept': 'application/json' },
  }, (res) => {
    let buf = '';
    res.on('data', c => buf += c);
    res.on('end', () => resolve({ status: res.statusCode, body: buf }));
  });
  req.end();
});

const base = 'http://10.170.140.23:8080';

const urls = [
  '/api/dashboard/partner-port-health/all',
  '/api/dashboard/partner-port-health/all?hostname=KDLWXOFADSRV1',
  '/api/dashboard/partner-port-health/KDLWXOFADSRV1',
  '/api/dashboard/partner-port-health',
  '/api/dashboard/packages-runs',
  '/api/dashboard/packages-runs?hostname=KDLWXOFADSRV1',
  '/api/dashboard/packages-runs?hostname=KDLWXOFADSRV1&packageName=ad_partner_ports_probe',
];

for (const u of urls) {
  const r = await get(base + u);
  console.log(`\n${r.status} ${u}`);
  console.log(r.body.slice(0, 1500));
}