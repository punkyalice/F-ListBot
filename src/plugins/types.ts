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
  /** The bot's own character name - use this to ignore events about the bot itself (e.g. its own room joins). */
  getBotCharacter(): string;
  /**
   * Subscribes to room membership changes across every room the bot is in (not filtered
   * by a future per-room plugin-activation setting, if one is ever added - this fires for
   * *every* join/leave the bot observes). Returns an unsubscribe function - call it from
   * your plugin's `onUnload`, or `!reload` will leave a duplicate listener registered on
   * every reload. Fires for the bot's own joins/leaves too - check against
   * `getBotCharacter()` if you need to ignore those.
   */
  onRoomEvent(event: "join" | "leave", callback: (room: string, character: string) => void): () => void;
  /**
   * Removes a character from a room (sends CKU). Requires the *F-List server* to consider
   * the bot's character a channel op (or owner) of that room - this is a separate
   * permission system from this bot's own admin/mod concept, and entirely outside this
   * bot's control. If the bot isn't a channel op there, the server will reject the kick;
   * this resolves once the command has been sent, not once the server has confirmed it
   * (the protocol has no reliable success/failure acknowledgement for CKU - check the
   * room, or bot logs, to confirm it actually worked).
   */
  kickFromRoom(room: string, character: string): Promise<void>;
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
