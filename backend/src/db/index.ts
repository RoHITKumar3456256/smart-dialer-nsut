import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const isTest = process.env.NODE_ENV === 'test';
const DB_PATH = isTest ? ':memory:' : path.join(__dirname, '../../data/smartdialer.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    // WAL mode: allows concurrent reads while one writer is active
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('progressive','predictive')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
      max_oversubscription REAL NOT NULL DEFAULT 1.5,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE' 
        CHECK(status IN ('OFFLINE','AVAILABLE','RESERVED','DIALING','CONNECTED','WRAP_UP','PAUSED')),
      worker_id TEXT,
      reserved_at INTEGER,
      connected_at INTEGER,
      wrap_up_started_at INTEGER,
      last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS borrowers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','called','done','failed')),
      reserved_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      agent_id TEXT REFERENCES agents(id),
      borrower_id TEXT REFERENCES borrowers(id),
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK(status IN ('QUEUED','RESERVED','INITIATED','RINGING','ANSWERED','CONNECTED','COMPLETED','FAILED','CANCELLED')),
      worker_id TEXT,
      idempotency_key TEXT UNIQUE,
      initiated_at INTEGER,
      ringing_at INTEGER,
      answered_at INTEGER,
      connected_at INTEGER,
      completed_at INTEGER,
      failed_reason TEXT,
      last_heartbeat INTEGER,
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES calls(id),
      event_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      payload TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      received_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS pacing_decisions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      mode TEXT NOT NULL,
      requested_calls INTEGER NOT NULL,
      approved_calls INTEGER NOT NULL,
      safety_action TEXT NOT NULL,
      available_agents INTEGER NOT NULL,
      connected_calls INTEGER NOT NULL,
      ringing_calls INTEGER NOT NULL,
      answer_rate REAL,
      provider_health REAL,
      reasoning TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      ts INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
      agents_available INTEGER NOT NULL DEFAULT 0,
      agents_reserved INTEGER NOT NULL DEFAULT 0,
      agents_connected INTEGER NOT NULL DEFAULT 0,
      agents_wrap_up INTEGER NOT NULL DEFAULT 0,
      calls_ringing INTEGER NOT NULL DEFAULT 0,
      calls_connected INTEGER NOT NULL DEFAULT 0,
      calls_completed INTEGER NOT NULL DEFAULT 0,
      calls_failed INTEGER NOT NULL DEFAULT 0,
      agent_utilization REAL NOT NULL DEFAULT 0,
      answer_rate REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
    CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_borrowers_campaign_status ON borrowers(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_pacing_campaign ON pacing_decisions(campaign_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_metrics_campaign ON metrics(campaign_id, ts);
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
