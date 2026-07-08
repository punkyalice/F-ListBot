import type { PluginManager } from "../../plugins/PluginManager";
import type { PluginConfigStore } from "../../store/pluginConfigStore";
import type { RoomStore } from "../../store/roomStore";
import { parseRoomCode } from "../../protocol/roomCode";
import type { CommandDefinition } from "../types";

/**
 * Available via PM (no implicit room - a room-code argument is required there) and inside
 * a room (defaults to the current room when no argument is given). Not privacy-sensitive,
 * so unlike !gdpr there's no reason to restrict where it can be used.
 */
export function createSettingsCommand(pluginManager: PluginManager, pluginConfigStore: PluginConfigStore, roomStore: RoomStore): CommandDefinition {
  function summarize(room: string): string {
    const presenceNote = roomStore.isKnown(room) ? "" : " (bot is not currently in this room)";
    const logging = roomStore.isLoggingEnabled(room) ? "on" : "off";
    const activePlugins = pluginManager.listLoaded().filter((id) => pluginConfigStore.isActiveInRoom(id, room));
    const pluginList = activePlugins.length > 0 ? activePlugins.join(", ") : "(none)";
    return `${room}${presenceNote} - logging: ${logging}, active plugins: ${pluginList}`;
  }

  return {
    name: "settings",
    level: "everyone",
    description: "Shows a room's current settings: which plugins are active and whether chat logging is on.",
    usage: "!settings [room-code-or-name]",
    async handler(ctx) {
      const argRoom = ctx.rawArgs.trim().length > 0 ? parseRoomCode(ctx.rawArgs) : null;
      const room = argRoom ?? ctx.room;

      if (!room) {
        const rooms = roomStore.listAutoRejoin();
        if (rooms.length === 0) {
          await ctx.reply("The bot isn't in any rooms yet. Usage: !settings <room-code-or-name>");
          return;
        }
        await ctx.reply(`Settings by room:\n${rooms.map((r) => summarize(r.room)).join("\n")}`);
        return;
      }

      await ctx.reply(summarize(room));
    },
  };
}
