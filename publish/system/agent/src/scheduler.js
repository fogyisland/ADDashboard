export function createScheduler({ config, logger, queue, collect, send, sendHeartbeat, runHealth }) {
  let pollTimer = null;
  let healthTimer = null;
  let stopFlag = false;

  async function tick() {
    if (stopFlag) return;
    const r = await collect();
    if (!r.ok) {
      logger.warn({ error: r.error }, 'collect failed');
      await sendHeartbeat({ lastReportStatus: 'failed', lastReportAt: null, pendingQueueSize: queue.count() });
      return;
    }
    queue.enqueue(JSON.stringify(r.snapshot));
    let sent = 0;
    while (!stopFlag) {
      const items = queue.peek(10);
      if (items.length === 0) break;
      for (const it of items) {
        try {
          const snap = JSON.parse(it.payload);
          const res = await send(snap);
          if (!res.ok) {
            await sendHeartbeat({ lastReportStatus: 'failed', lastReportAt: null, pendingQueueSize: queue.count() });
            return;
          }
          queue.delete([it.id]);
          sent++;
        } catch (e) {
          logger.warn({ err: e.message }, 'send failed');
          return;
        }
      }
    }
    const lastReportAt = new Date().toISOString();
    const lastReportStatus = sent > 0 ? 'success' : 'empty';
    await sendHeartbeat({ lastReportStatus, lastReportAt, pendingQueueSize: queue.count() });
    logger.info({ sent, pending: queue.count() }, 'cycle complete');
  }

  function start() {
    const ms = Math.max(1, config.pollingIntervalMinutes) * 60_000;
    pollTimer = setInterval(tick, ms);
    healthTimer = setInterval(async () => {
      const r = await runHealth();
      if (!r.ok) logger.warn({ checks: r.checks }, 'health degraded');
      else logger.info(r.checks, 'health ok');
    }, config.healthCheckIntervalMs);
    tick();
  }

  async function stop() {
    stopFlag = true;
    if (pollTimer) clearInterval(pollTimer);
    if (healthTimer) clearInterval(healthTimer);
  }

  return { start, stop, _tick: tick };
}
