// SQL helpers for the four metric_* tables: gauge, counter, timeseries, status.
//
// Layout:
//   metric_gauge    — point-in-time gauges, UNIQUE(agent_id, metric_id), upsert
//   metric_counter  — cumulative counters, UNIQUE(agent_id, metric_id), upsert
//   metric_status   — health status (OK/WARN/CRIT/...), UNIQUE(agent_id, metric_id), upsert
//   metric_timeseries — append-only time series (no UNIQUE), plain INSERT
//
// Pattern matches portStatus (dual-dialect, ? placeholders only, MERGE for MSSQL).
// All timestamps are UTC (DATETIME for MySQL, DATETIMEOFFSET for MSSQL).

// ----- gauge -----
const GAUGE_UPSERT_MYSQL = `INSERT INTO metric_gauge
  (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    ts = VALUES(ts),
    value = VALUES(value),
    unit = VALUES(unit),
    threshold_warn = VALUES(threshold_warn),
    threshold_crit = VALUES(threshold_crit)`;

const GAUGE_UPSERT_MSSQL = `MERGE INTO metric_gauge AS t
  USING (SELECT
    ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS unit,
    ? AS threshold_warn, ? AS threshold_crit
  ) AS s
  ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
  WHEN MATCHED THEN UPDATE SET
    ts = s.ts,
    value = s.value,
    unit = s.unit,
    threshold_warn = s.threshold_warn,
    threshold_crit = s.threshold_crit
  WHEN NOT MATCHED THEN INSERT
    (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
    VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.unit, s.threshold_warn, s.threshold_crit)`;

const GAUGE_LIST_MYSQL = (metricId) =>
  metricId
    ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
    : `SELECT * FROM metric_gauge WHERE agent_id = ?`;
const GAUGE_LIST_MSSQL = (metricId) =>
  metricId
    ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
    : `SELECT * FROM metric_gauge WHERE agent_id = ?`;

// ----- counter -----
const COUNTER_UPSERT_MYSQL = `INSERT INTO metric_counter
  (agent_id, metric_id, ts, value, delta, unit)
  VALUES (?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    ts = VALUES(ts),
    value = VALUES(value),
    delta = VALUES(delta),
    unit = VALUES(unit)`;

const COUNTER_UPSERT_MSSQL = `MERGE INTO metric_counter AS t
  USING (SELECT
    ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS delta, ? AS unit
  ) AS s
  ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
  WHEN MATCHED THEN UPDATE SET
    ts = s.ts,
    value = s.value,
    delta = s.delta,
    unit = s.unit
  WHEN NOT MATCHED THEN INSERT
    (agent_id, metric_id, ts, value, delta, unit)
    VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.delta, s.unit)`;

const COUNTER_LIST_MYSQL = (metricId) =>
  metricId
    ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
    : `SELECT * FROM metric_counter WHERE agent_id = ?`;
const COUNTER_LIST_MSSQL = (metricId) =>
  metricId
    ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
    : `SELECT * FROM metric_counter WHERE agent_id = ?`;

// ----- timeseries (append-only, no UNIQUE) -----
const TIMESERIES_APPEND_MYSQL = `INSERT INTO metric_timeseries
  (agent_id, metric_id, ts, value, tags_json, unit)
  VALUES (?, ?, ?, ?, ?, ?)`;
const TIMESERIES_APPEND_MSSQL = `INSERT INTO metric_timeseries
  (agent_id, metric_id, ts, value, tags_json, unit)
  VALUES (?, ?, ?, ?, ?, ?)`;

const TIMESERIES_LIST_MYSQL = ({ from, to }) => {
  // For list-range queries the bound params are pushed in order:
  //   [agent_id, metric_id] + (from?) + (to?)
  // The conditional WHERE clauses are built here; the caller appends
  // the matching params in the same order.
  const where = ['agent_id = ?', 'metric_id = ?'];
  if (from) where.push('ts >= ?');
  if (to) where.push('ts <= ?');
  return `SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
};
const TIMESERIES_LIST_MSSQL = TIMESERIES_LIST_MYSQL;

// ----- status -----
const STATUS_UPSERT_MYSQL = `INSERT INTO metric_status
  (agent_id, metric_id, ts, status, message)
  VALUES (?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    ts = VALUES(ts),
    status = VALUES(status),
    message = VALUES(message)`;

const STATUS_UPSERT_MSSQL = `MERGE INTO metric_status AS t
  USING (SELECT
    ? AS agent_id, ? AS metric_id, ? AS ts, ? AS status, ? AS message
  ) AS s
  ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
  WHEN MATCHED THEN UPDATE SET
    ts = s.ts,
    status = s.status,
    message = s.message
  WHEN NOT MATCHED THEN INSERT
    (agent_id, metric_id, ts, status, message)
    VALUES (s.agent_id, s.metric_id, s.ts, s.status, s.message)`;

const STATUS_LIST_MYSQL = (metricId) =>
  metricId
    ? `SELECT * FROM metric_status WHERE agent_id = ? AND metric_id = ?`
    : `SELECT * FROM metric_status WHERE agent_id = ?`;
const STATUS_LIST_MSSQL = STATUS_LIST_MYSQL;

// Raw SQL registry — re-exported via sql.js for direct use by services
// that already do their own marshaling.
export const metricStoreSql = {
  gauge: {
    upsert: { mysql: GAUGE_UPSERT_MYSQL, mssql: GAUGE_UPSERT_MSSQL },
    list: { mysql: GAUGE_LIST_MYSQL, mssql: GAUGE_LIST_MSSQL }
  },
  counter: {
    upsert: { mysql: COUNTER_UPSERT_MYSQL, mssql: COUNTER_UPSERT_MSSQL },
    list: { mysql: COUNTER_LIST_MYSQL, mssql: COUNTER_LIST_MSSQL }
  },
  timeseries: {
    append: { mysql: TIMESERIES_APPEND_MYSQL, mssql: TIMESERIES_APPEND_MSSQL },
    list: { mysql: TIMESERIES_LIST_MYSQL, mssql: TIMESERIES_LIST_MSSQL }
  },
  status: {
    upsert: { mysql: STATUS_UPSERT_MYSQL, mssql: STATUS_UPSERT_MSSQL },
    list: { mysql: STATUS_LIST_MYSQL, mssql: STATUS_LIST_MSSQL }
  }
};

// Function-style helper API.
export const metricGauge = {
  async upsertLatest(db, { agentId, metricId, ts, value, unit, thresholdWarn, thresholdCrit }) {
    const sql = db.dialect === 'mssql' ? GAUGE_UPSERT_MSSQL : GAUGE_UPSERT_MYSQL;
    await db.execute(sql, [
      agentId,
      metricId,
      ts,
      value,
      unit ?? null,
      thresholdWarn ?? null,
      thresholdCrit ?? null
    ]);
  },
  async listByAgent(db, agentId, { metricId } = {}) {
    const sql = db.dialect === 'mssql' ? GAUGE_LIST_MSSQL(metricId) : GAUGE_LIST_MYSQL(metricId);
    const params = metricId ? [agentId, metricId] : [agentId];
    const { rows } = await db.execute(sql, params);
    return rows;
  }
};

export const metricCounter = {
  async upsertLatest(db, { agentId, metricId, ts, value, delta, unit }) {
    const sql = db.dialect === 'mssql' ? COUNTER_UPSERT_MSSQL : COUNTER_UPSERT_MYSQL;
    await db.execute(sql, [
      agentId,
      metricId,
      ts,
      value,
      delta,
      unit ?? null
    ]);
  },
  async listByAgent(db, agentId, { metricId } = {}) {
    const sql = db.dialect === 'mssql' ? COUNTER_LIST_MSSQL(metricId) : COUNTER_LIST_MYSQL(metricId);
    const params = metricId ? [agentId, metricId] : [agentId];
    const { rows } = await db.execute(sql, params);
    return rows;
  }
};

export const metricTimeseries = {
  async append(db, { agentId, metricId, ts, value, tags, unit }) {
    const sql = db.dialect === 'mssql' ? TIMESERIES_APPEND_MSSQL : TIMESERIES_APPEND_MYSQL;
    await db.execute(sql, [
      agentId,
      metricId,
      ts,
      value,
      tags == null ? null : JSON.stringify(tags),
      unit ?? null
    ]);
  },
  async list(db, { agentId, metricId, from, to } = {}) {
    if (!agentId || !metricId) {
      throw new Error('metricTimeseries.list: agentId and metricId are required');
    }
    const sql = db.dialect === 'mssql' ? TIMESERIES_LIST_MSSQL({ from, to }) : TIMESERIES_LIST_MYSQL({ from, to });
    const params = [agentId, metricId];
    if (from) params.push(from);
    if (to) params.push(to);
    const { rows } = await db.execute(sql, params);
    return rows.map((row) => ({
      ...row,
      tags: row.tags_json == null ? null : JSON.parse(row.tags_json)
    }));
  }
};

export const metricStatus = {
  async upsertLatest(db, { agentId, metricId, ts, status, message }) {
    const sql = db.dialect === 'mssql' ? STATUS_UPSERT_MSSQL : STATUS_UPSERT_MYSQL;
    await db.execute(sql, [
      agentId,
      metricId,
      ts,
      status,
      message ?? null
    ]);
  },
  async listByAgent(db, agentId, { metricId } = {}) {
    const sql = db.dialect === 'mssql' ? STATUS_LIST_MSSQL(metricId) : STATUS_LIST_MYSQL(metricId);
    const params = metricId ? [agentId, metricId] : [agentId];
    const { rows } = await db.execute(sql, params);
    return rows;
  }
};
