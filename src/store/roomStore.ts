import type Database from "better-sqlite3";

export interface RoomRecord {
  room: string;
  autoRejoin: boolean;
  loggingEnabled: boolean;
}

/** Which rooms the bot has joined (for auto-rejoin after reconnect/restart) and per-room logging flags. */
export class RoomStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  add(room: string): void {
    this.#db
      .prepare("INSERT INTO rooms (room, auto_rejoin, logging_enabled) VALUES (?, 1, 0) ON CONFLICT(room) DO UPDATE SET auto_rejoin = 1")
      .run(room);
  }

  remove(room: string): void {
    this.#db.prepare("DELETE FROM rooms WHERE room = ?").run(room);
  }

  setLogging(room: string, enabled: boolean): void {
    this.#db
      .prepare("INSERT INTO rooms (room, auto_rejoin, logging_enabled) VALUES (?, 1, ?) ON CONFLICT(room) DO UPDATE SET logging_enabled = ?")
      .run(room, enabled ? 1 : 0, enabled ? 1 : 0);
  }

  isLoggingEnabled(room: string): boolean {
    const row = this.#db.prepare("SELECT logging_enabled FROM rooms WHERE room = ?").get(room) as { logging_enabled: number } | undefined;
    return row?.logging_enabled === 1;
  }

  /** Whether the bot currently considers itself present in this room (has a row in `rooms` at all). */
  isKnown(room: string): boolean {
    const row = this.#db.prepare("SELECT 1 FROM rooms WHERE room = ?").get(room);
    return row !== undefined;
  }

  listAutoRejoin(): RoomRecord[] {
    const rows = this.#db.prepare("SELECT room, auto_rejoin, logging_enabled FROM rooms WHERE auto_rejoin = 1").all() as {
      room: string;
      auto_rejoin: number;
      logging_enabled: number;
    }[];
    return rows.map((r) => ({ room: r.room, autoRejoin: r.auto_rejoin === 1, loggingEnabled: r.logging_enabled === 1 }));
  }
}
