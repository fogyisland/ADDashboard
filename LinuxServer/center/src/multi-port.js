// multi-port.js — start N http.Server instances, one per role. Dedupes by port
// (overlapping ports collapse to one server; the first entry wins). On any
// listen failure, closes already-open peer servers before rejecting.

import { createServer } from 'node:http';

export async function startServers({ logger, roleAppPortList }) {
  // Dedupe by port. First entry wins; later entries with the same port are
  // silently dropped — their routes are NOT mounted on the surviving server
  // (the caller is responsible for combining apps before passing them in if
  // they want shared-port behavior).
  const seen = new Set();
  const deduped = roleAppPortList.filter((entry) => {
    if (seen.has(entry.port)) return false;
    seen.add(entry.port);
    return true;
  });

  const results = [];
  const tried = [];

  try {
    for (const { role, app, port } of deduped) {
      const srv = createServer(app);
      tried.push(srv);
      const bound = await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, () => {
          const actualPort = srv.address().port;
          logger.info({ port: actualPort, role }, `${role} server listening`);
          resolve(actualPort);
        });
      });
      results.push({ srv, role, port: bound });
    }
    return results;
  } catch (err) {
    // Close any servers we managed to open before the failing one.
    await Promise.all(tried.map((srv) => new Promise((res) => srv.close(() => res()))));
    throw err;
  }
}

export async function closeAll(servers, logger) {
  await Promise.all(servers.map(({ srv, role }) =>
    new Promise((resolve) => {
      srv.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          logger.warn({ err: err.message, role }, 'server close error');
        }
        resolve();
      });
    })
  ));
}