import type Database from "better-sqlite3";

const LOG_RETENTION_KEY = "log_retention_days";

/**
 * Small generic key-value table for global, bot-wide settings that don't fit any other
 * store (not per-room, not per-plugin, not per-admin). Starts with just the room-log
 * retention window (`!log limit`), but the table is deliberately generic so future global
 * settings don't each need their own migration + table.
 */
export class BotSettingsStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /** Days of room-log history to keep before automatic deletion, or null if logs are kept indefinitely (the default). */
  getLogRetentionDays(): number | null {
    const row = this.#db.prepare("SELECT value FROM bot_settings WHERE key = ?").get(LOG_RETENTION_KEY) as { value: string } | undefined;
    if (!row) return null;
    const days = Number(row.value);
    return Number.isFinite(days) && days > 0 ? days : null;
  }

  /** Pass null to remove the limit (logs kept indefinitely again). */
  setLogRetentionDays(days: number | null): void {
    if (days === null) {
      this.#db.prepare("DELETE FROM bot_settings WHERE key = ?").run(LOG_RETENTION_KEY);
      return;
    }
    this.#db
      .prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(LOG_RETENTION_KEY, String(days), String(days));
  }
}
