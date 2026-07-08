import type { FChatConnection } from "../connection/FChatConnection";
import type { ServerEvent } from "../protocol/messages";
import type { CommandRegistry } from "./commandRegistry";
import type { Permissions } from "./permissions";
import type { PluginConfigStore } from "../store/pluginConfigStore";
import type { Messenger } from "./messenger";
import type { CommandContext } from "./types";
import { PermissionError, RoomContextRequiredError, PmContextRequiredError } from "../util/errors";
import type { Logger } from "../logging/logger";

/**
 * Listens to MSG/PRI server events, parses "!command args" (only when the FIRST character
 * is "!" - no fuzzy matching), and dispatches to the matching core or plugin command.
 * Unknown "!"-prefixed text is silently ignored on purpose: replying "unknown command" to
 * every incidental "!" in roleplay chat would be far noisier than useful.
 */
export class Dispatcher {
  #connection: FChatConnection;
  #registry: CommandRegistry;
  #permissions: Permissions;
  #pluginConfig: PluginConfigStore;
  #messenger: Messenger;
  #logger: Logger;
  #botCharacter: string;

  constructor(
    connection: FChatConnection,
    registry: CommandRegistry,
    permissions: Permissions,
    pluginConfig: PluginConfigStore,
    messenger: Messenger,
    logger: Logger,
    botCharacter: string
  ) {
    this.#connection = connection;
    this.#registry = registry;
    this.#permissions = permissions;
    this.#pluginConfig = pluginConfig;
    this.#messenger = messenger;
    this.#logger = logger;
    this.#botCharacter = botCharacter;

    connection.on("event", (evt) => this.#handleEvent(evt));
  }

  #handleEvent(evt: ServerEvent): void {
    if (evt.code === "MSG") {
      void this.#handleIncoming(evt.message, evt.character, "room", evt.channel);
    } else if (evt.code === "PRI") {
      void this.#handleIncoming(evt.message, evt.character, "pm", undefined);
    }
  }

  async #handleIncoming(message: string, sender: string, source: "room" | "pm", room: string | undefined): Promise<void> {
    if (sender === this.#botCharacter) return; // ignore the bot's own messages
    if (message.length === 0 || message[0] !== "!") return;

    const spaceIdx = message.indexOf(" ");
    const name = (spaceIdx === -1 ? message.slice(1) : message.slice(1, spaceIdx)).trim();
    const rawArgs = spaceIdx === -1 ? "" : message.slice(spaceIdx + 1).trim();
    if (name.length === 0) return;

    const def = this.#registry.resolve(name);
    if (!def) return; // unknown command - ignore silently

    const messenger = this.#messenger;
    const ctx: CommandContext = {
      source,
      room,
      senderCharacter: sender,
      rawArgs,
      reply: async (text: string) => {
        if (source === "room" && room) await messenger.sendRoomMessage(room, text);
        else await messenger.sendPM(sender, text);
      },
    };

    try {
      if (def.requiredRoomContext && source !== "room") {
        throw new RoomContextRequiredError(def.name);
      }

      if (def.requiredPmContext && source !== "pm") {
        throw new PmContextRequiredError(def.name);
      }

      const pluginId = this.#registry.pluginOwning(def.name);
      if (pluginId && !this.#pluginConfig.isActiveInRoom(pluginId, room)) {
        return; // plugin disabled, or not activated for this room - treat like an unknown command
      }

      if (!this.#permissions.check(def.level, sender, room)) {
        throw new PermissionError();
      }

      await def.handler(ctx);
    } catch (err) {
      if (err instanceof RoomContextRequiredError || err instanceof PmContextRequiredError || err instanceof PermissionError) {
        await ctx.reply(err.message).catch(() => {});
      } else {
        this.#logger.error({ err, command: def.name }, "Command handler threw");
        await ctx.reply("Something went wrong running that command.").catch(() => {});
      }
    }
  }
}
