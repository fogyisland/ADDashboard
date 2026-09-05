// Force-redirect the user's Chrome tab using Chrome DevTools Protocol.
// Default target is any open tab whose URL points at our dev server; pass
// a `url` arg to redirect to that specific path. Used when Chrome's
// HTTPS-First upgrade silently breaks a plain-HTTP local server.
const WebSocket = require('ws');

(async () => {
  const target = process.argv[2] || 'http://127.0.0.1:8080/login';
  const tabs = await fetch('http://localhost:9222/json').then(r => r.json());
  const tab = tabs.find(t => t.type === 'page' && /127\.0\.0\.1:8080|localhost:8080/.test(t.url || ''));
  if (!tab) { console.error('no dev-server tab found'); process.exit(1); }
  console.log('tab:', tab.id, 'url:', tab.url);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({
    id: 1,
    method: 'Page.navigate',
    params: { url: target }
  }));
  const reply = await new Promise(r => ws.on('message', m => r(JSON.parse(m))));
  console.log('navigate result:', JSON.stringify(reply.result || reply.error));
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
