import type Database from "better-sqlite3";

// SQLite treats NULL specially in composite primary keys (two NULLs don't collide), so
// "no room" (a PM-context or global value) is represented by the empty string sentinel
// rather than NULL - keeps the (namespace, room, owner_character, key) primary key doing
// real uniqueness enforcement.
const NO_ROOM = "";

/**
 * Generic namespaced key/value storage for plugins, scoped by (namespace=pluginId, room,
 * owner_character). This composite structure is what makes "a user's data isn't readable
 * by other users" a storage-layer property, not just a convention: every read requires
 * already knowing the exact (room, owner, key) tuple - there is no "list all owners" or
 * "get for any owner" query exposed anywhere in this class or through BotAPI.
 */
export class KvStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  get(namespace: string, room: string | null, owner: string, key: string): string | null {
    const row = this.#db
      .prepare("SELECT value FROM kv_store WHERE namespace = ? AND room = ? AND owner_character = ? AND key = ?")
      .get(namespace, room ?? NO_ROOM, owner, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(namespace: string, room: string | null, owner: string, key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO kv_store (namespace, room, owner_character, key, value) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(namespace, room, owner_character, key) DO UPDATE SET value = ?"
      )
      .run(namespace, room ?? NO_ROOM, owner, key, value, value);
  }

  /** !gdpr support: every entry stored under any namespace/room for the given owner. */
  listForOwner(owner: string): { namespace: string; room: string | null; key: string; value: string }[] {
    const rows = this.#db
      .prepare("SELECT namespace, room, key, value FROM kv_store WHERE owner_character = ? ORDER BY namespace, room, key")
      .all(owner) as { namespace: string; room: string; key: string; value: string }[];
    return rows.map((r) => ({ namespace: r.namespace, room: r.room === NO_ROOM ? null : r.room, key: r.key, value: r.value }));
  }
}
