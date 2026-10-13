import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as schema from './schema.js';
import { getConfig } from '../config.js';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    const { dbPath } = getConfig();
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    _db = drizzle(sqlite, { schema });

    // Run all pending Drizzle migrations from the drizzle/ folder.
    // The migrator tracks applied migrations in __drizzle_migrations and is idempotent.
    const migrationsFolder = join(__dirname, '..', '..', 'drizzle');
    migrate(_db, { migrationsFolder });

    // Post-migration schema patches — safe to re-run (no-ops if already applied)
    const patches = [
      `ALTER TABLE agent_secrets ADD COLUMN requests_per_minute INTEGER`,
      `CREATE TABLE IF NOT EXISTS api_request_log (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        response TEXT NOT NULL DEFAULT '{}',
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ];
    for (const sql of patches) {
      try { sqlite.exec(sql); } catch { /* already exists — OK */ }
    }
  }
  return _db;
}
