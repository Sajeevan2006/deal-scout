import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AllResult, Database, PreparedStatement, RunResult, SqlValue } from "../core/ports/database";

// Local stand in for D1 behind the Database port
// TODO(integration): on Cloudflare, env.DB (D1) replaces this adapter and wrangler applies migrations/
export interface SqliteDatabase extends Database {
  close(): void;
}

function wrapStatement(statement: BetterSqlite3.Statement, boundValues: SqlValue[]): PreparedStatement {
  return {
    bind(...values: SqlValue[]) {
      return wrapStatement(statement, values);
    },
    // D1 returns null from first() on statements without rows, better-sqlite3 throws, so smooth that over
    async first<Row = Record<string, unknown>>(): Promise<Row | null> {
      if (!statement.reader) {
        statement.run(...boundValues);
        return null;
      }
      const row = statement.get(...boundValues) as Row | undefined;
      if (row === undefined) {
        return null;
      }
      return row;
    },
    async all<Row = Record<string, unknown>>(): Promise<AllResult<Row>> {
      if (!statement.reader) {
        statement.run(...boundValues);
        return { results: [], success: true };
      }
      const rows = statement.all(...boundValues) as Row[];
      return { results: rows, success: true };
    },
    async run(): Promise<RunResult> {
      const info = statement.run(...boundValues);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    },
  };
}

function runMigrations(connection: BetterSqlite3.Database, migrationsDir: string): void {
  connection.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const alreadyApplied = connection.prepare("SELECT 1 FROM _migrations WHERE name = ?");
  const markApplied = connection.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const migrationFiles: string[] = [];
  for (const fileName of readdirSync(migrationsDir)) {
    if (fileName.endsWith(".sql")) {
      migrationFiles.push(fileName);
    }
  }
  migrationFiles.sort();
  for (const fileName of migrationFiles) {
    if (alreadyApplied.get(fileName)) {
      continue;
    }
    const migrationSql = readFileSync(path.join(migrationsDir, fileName), "utf8");
    const applyMigration = connection.transaction(() => {
      connection.exec(migrationSql);
      markApplied.run(fileName, new Date().toISOString());
    });
    applyMigration();
  }
}

// Pass ":memory:" for throwaway databases in tests
export function openSqliteDatabase(filePath: string, migrationsDir: string): SqliteDatabase {
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const connection = new BetterSqlite3(filePath);
  connection.pragma("foreign_keys = ON");
  if (filePath !== ":memory:") {
    connection.pragma("journal_mode = WAL");
  }
  runMigrations(connection, migrationsDir);
  return {
    prepare(sql: string) {
      return wrapStatement(connection.prepare(sql), []);
    },
    close() {
      connection.close();
    },
  };
}
