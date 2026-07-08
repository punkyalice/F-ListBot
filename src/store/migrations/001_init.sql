CREATE TABLE IF NOT EXISTS admins (
  character TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_mods (
  room TEXT NOT NULL,
  character TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (room, character)
);

CREATE TABLE IF NOT EXISTS rooms (
  room TEXT PRIMARY KEY,
  auto_rejoin INTEGER NOT NULL DEFAULT 1,
  logging_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plugin_config (
  plugin_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  room_scope TEXT
);

CREATE TABLE IF NOT EXISTS kv_store (
  namespace TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  owner_character TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, room, owner_character, key)
);
