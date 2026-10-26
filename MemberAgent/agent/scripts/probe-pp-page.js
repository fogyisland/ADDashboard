// 用 node http 直接拿 admin/partner-ports 的 raw body，看是 HTML 还是 JSON
import http from 'node:http';

const url = new URL('http://10.170.140.23:8080/admin/partner-ports');
const req = http.request({
  method: 'GET', hostname: url.hostname, port: url.port,
  path: url.pathname, headers: { 'Accept': 'text/html,*/*' },
}, (res) => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    console.log('status:', res.statusCode);
    console.log('content-type:', res.headers['content-type']);
    console.log('body:', buf.slice(0, 3000));
  });
});
req.end();