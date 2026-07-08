import type { CommandContext, CommandDefinition } from "../core/types";
import type { UserInfo, ResolvedStandardKink } from "../userinfo/UserInfoClient";

export type { CommandContext, CommandDefinition, UserInfo, ResolvedStandardKink };

/**
 * The API surface exposed to plugins. Notably: `storage` has no method that takes an
 * arbitrary owner with no caller-known key and returns cross-owner data - every read
 * requires already knowing the (room, owner, key) tuple. `getOwn`/`setOwn` are the
 * recommended default (always scoped to the invoking character, safe by construction);
 * `get`/`set` with an explicit owner exist for cases where a plugin legitimately needs to
 * read another character's data (e.g. a moderation command) - the CALLER is responsible
 * for checking isAdmin/isModerator before doing that. See plugins/README.md.
 */
export interface BotAPI {
  sendRoomMessage(room: string, text: string): Promise<void>;
  sendPM(character: string, text: string): Promise<void>;
  sendRoomAd(room: string, text: string): Promise<void>;
  getUserInfo(character: string): Promise<UserInfo>;
  isAdmin(character: string): boolean;
  isModerator(character: string, room: string): boolean;
  /** Every room the given character moderates (bootstrap or persisted) - useful for permission-aware output (e.g. !help) when there's no current room, like in a PM. */
  getModeratedRooms(character: string): string[];
  listCoreCommands(): CommandDefinition[];
  /** Every registered command, core and plugin alike. */
  listCommands(): CommandDefinition[];
  storage: {
    getOwn(ctx: CommandContext, key: string): string | null;
    setOwn(ctx: CommandContext, key: string, value: string): void;
    get(room: string | null, owner: string, key: string): string | null;
    set(room: string | null, owner: string, key: string, value: string): void;
  };
  log: {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    error(msg: string, meta?: object): void;
  };
}

export interface Plugin {
  /** Stable identifier - used for command-registry namespacing, kv_store namespace, and log tags. Must match the plugin's directory name. */
  id: string;
  name: string;
  version: string;
  commands?: CommandDefinition[];
  onLoad?(api: BotAPI): Promise<void> | void;
  onUnload?(): Promise<void> | void;
}

/** A plugin file's default export must be a Plugin, or a factory that builds one from the BotAPI. */
export type PluginModule = Plugin | ((api: BotAPI) => Plugin);
