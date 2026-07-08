import type Database from "better-sqlite3";

export interface PluginConfig {
  pluginId: string;
  enabled: boolean;
  /** null = active in all rooms (the default for every plugin, no admin command changes this yet). */
  roomScope: string[] | null;
}

/**
 * Per-plugin enable flag and room-activation scope. `roomScope` exists now so that
 * room-specific plugin activation is a config change later (write to an existing column
 * + one new admin command) rather than a rearchitecture - there is no command yet that
 * changes it away from its NULL/"all rooms" default.
 */
export class PluginConfigStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  get(pluginId: string): PluginConfig {
    const row = this.#db.prepare("SELECT enabled, room_scope FROM plugin_config WHERE plugin_id = ?").get(pluginId) as
      | { enabled: number; room_scope: string | null }
      | undefined;
    if (!row) return { pluginId, enabled: true, roomScope: null };
    return {
      pluginId,
      enabled: row.enabled === 1,
      roomScope: row.room_scope ? (JSON.parse(row.room_scope) as string[]) : null,
    };
  }

  isActiveInRoom(pluginId: string, room: string | undefined): boolean {
    const cfg = this.get(pluginId);
    if (!cfg.enabled) return false;
    if (cfg.roomScope === null) return true;
    return room !== undefined && cfg.roomScope.includes(room);
  }

  setRoomScope(pluginId: string, roomScope: string[] | null): void {
    this.#db
      .prepare(
        "INSERT INTO plugin_config (plugin_id, enabled, room_scope) VALUES (?, 1, ?) " +
          "ON CONFLICT(plugin_id) DO UPDATE SET room_scope = ?"
      )
      .run(pluginId, roomScope ? JSON.stringify(roomScope) : null, roomScope ? JSON.stringify(roomScope) : null);
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.#db
      .prepare("INSERT INTO plugin_config (plugin_id, enabled, room_scope) VALUES (?, ?, NULL) ON CONFLICT(plugin_id) DO UPDATE SET enabled = ?")
      .run(pluginId, enabled ? 1 : 0, enabled ? 1 : 0);
  }
}
