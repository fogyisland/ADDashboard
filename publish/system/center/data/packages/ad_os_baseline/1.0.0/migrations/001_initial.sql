CREATE TABLE metrics (
  agent_id   VARCHAR(64)  NOT NULL,
  ts         DATETIME     NOT NULL,
  cpu_pct    DOUBLE NULL,
  memory_pct DOUBLE NULL,
  disk_free  JSON NULL,
  disk_total JSON NULL,
  services   JSON NULL,
  events     JSON NULL
);