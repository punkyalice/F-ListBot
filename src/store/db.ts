import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import path from "path";

let instance: Database.Database | undefined;

/**
 * Opens (creating if needed) the SQLite database under dataDir and runs pending migrations.
 * `dataDir` is resolved to an absolute path before use - relying on a relative path here
 * would make the actual on-disk location depend on process.cwd() at startup, which is easy
 * to get inconsistent across `npm run dev` vs `npm start` vs a process manager with a
 * different working directory, silently pointing at a different (often empty) database.
 */
export function openDb(dataDir: string): Database.Database {
  if (instance) return instance;

  const resolvedDir = path.resolve(dataDir);
  mkdirSync(resolvedDir, { recursive: true });
  mkdirSync(path.join(resolvedDir, "logs", "rooms"), { recursive: true });

  const dbPath = path.join(resolvedDir, "bot.sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);

  const migrationsDir = path.join(__dirname, "migrations");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name as string));

  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];

  const insertMigration = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    })();
  }

  instance = db;
  return db;
}
