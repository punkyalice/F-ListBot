import type Database from "better-sqlite3";
import type { Bootstrap } from "../config/bootstrap";

export type AdminSource = "bootstrap" | "persisted";

export interface AdminEntry {
  character: string;
  source: AdminSource;
}

/**
 * Global admins and per-room moderators. Merge semantics: bootstrap (from .env, held in
 * memory, never written to the DB) union persisted (from !addadmin/!addmod, written to
 * SQLite). Bootstrap entries can never be removed at runtime - `removeAdmin`/`removeRoomMod`
 * only ever delete *persisted* rows, never suppress a bootstrap entry. This keeps .env an
 * unconditional recovery mechanism: you can never be permanently locked out via chat commands.
 */
export class AdminStore {
  #db: Database.Database;
  #bootstrapAdmins: Set<string>;
  #bootstrapMods: Map<string, Set<string>>; // room -> characters

  constructor(db: Database.Database, bootstrap: Bootstrap) {
    this.#db = db;
    this.#bootstrapAdmins = bootstrap.admins;
    this.#bootstrapMods = new Map();
    for (const { room, character } of bootstrap.mods) {
      const set = this.#bootstrapMods.get(room) ?? new Set();
      set.add(character);
      this.#bootstrapMods.set(room, set);
    }
  }

  isAdmin(character: string): boolean {
    if (this.#bootstrapAdmins.has(character)) return true;
    const row = this.#db.prepare("SELECT 1 FROM admins WHERE character = ?").get(character);
    return row !== undefined;
  }

  isRoomMod(room: string, character: string): boolean {
    if (this.isAdmin(character)) return true; // admins implicitly hold moderator rights everywhere
    if (this.#bootstrapMods.get(room)?.has(character)) return true;
    const row = this.#db.prepare("SELECT 1 FROM room_mods WHERE room = ? AND character = ?").get(room, character);
    return row !== undefined;
  }

  /** True if `character` is an admin via BOOTSTRAP_ADMINS specifically (removeAdmin() can never revoke this). */
  isBootstrapAdmin(character: string): boolean {
    return this.#bootstrapAdmins.has(character);
  }

  /** True if `character` is a mod of `room` via BOOTSTRAP_MODS specifically (removeRoomMod() can never revoke this). */
  isBootstrapRoomMod(room: string, character: string): boolean {
    return this.#bootstrapMods.get(room)?.has(character) ?? false;
  }

  addAdmin(character: string, addedBy: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO admins (character, added_by, added_at) VALUES (?, ?, ?)")
      .run(character, addedBy, Date.now());
  }

  addRoomMod(room: string, character: string, addedBy: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO room_mods (room, character, added_by, added_at) VALUES (?, ?, ?, ?)")
      .run(room, character, addedBy, Date.now());
  }

  /** Removes a persisted admin grant. Never affects BOOTSTRAP_ADMINS - see isBootstrapAdmin(). Returns whether a row was actually deleted. */
  removeAdmin(character: string): boolean {
    const result = this.#db.prepare("DELETE FROM admins WHERE character = ?").run(character);
    return result.changes > 0;
  }

  /** Removes a persisted room-mod grant. Never affects BOOTSTRAP_MODS - see isBootstrapRoomMod(). Returns whether a row was actually deleted. */
  removeRoomMod(room: string, character: string): boolean {
    const result = this.#db.prepare("DELETE FROM room_mods WHERE room = ? AND character = ?").run(room, character);
    return result.changes > 0;
  }

  listAdmins(): AdminEntry[] {
    const persisted = this.#db.prepare("SELECT character FROM admins").all() as { character: string }[];
    const persistedSet = new Set(persisted.map((r) => r.character));
    const entries: AdminEntry[] = [];
    for (const character of this.#bootstrapAdmins) entries.push({ character, source: "bootstrap" });
    for (const character of persistedSet) {
      if (!this.#bootstrapAdmins.has(character)) entries.push({ character, source: "persisted" });
    }
    return entries;
  }

  listRoomMods(room: string): AdminEntry[] {
    const persisted = this.#db.prepare("SELECT character FROM room_mods WHERE room = ?").all(room) as { character: string }[];
    const persistedSet = new Set(persisted.map((r) => r.character));
    const bootstrapSet = this.#bootstrapMods.get(room) ?? new Set<string>();
    const entries: AdminEntry[] = [];
    for (const character of bootstrapSet) entries.push({ character, source: "bootstrap" });
    for (const character of persistedSet) {
      if (!bootstrapSet.has(character)) entries.push({ character, source: "persisted" });
    }
    return entries;
  }

  /** Reverse lookup for !gdpr: every room the given character is a moderator of (bootstrap or persisted). */
  listRoomsModeratedBy(character: string): { room: string; source: AdminSource }[] {
    const results: { room: string; source: AdminSource }[] = [];
    const bootstrapRooms = new Set<string>();
    for (const [room, chars] of this.#bootstrapMods) {
      if (chars.has(character)) {
        bootstrapRooms.add(room);
        results.push({ room, source: "bootstrap" });
      }
    }
    const persisted = this.#db.prepare("SELECT room FROM room_mods WHERE character = ?").all(character) as { room: string }[];
    for (const { room } of persisted) {
      if (!bootstrapRooms.has(room)) results.push({ room, source: "persisted" });
    }
    return results;
  }
}
