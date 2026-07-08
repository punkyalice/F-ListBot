import type { RoomLogger } from "../../logging/roomLogger";
import type { RoomStore } from "../../store/roomStore";
import type { AdminStore } from "../../store/adminStore";
import type { BotSettingsStore } from "../../store/botSettingsStore";
import type { CommandDefinition } from "../types";

/** Accepts "30", "30d" (case-insensitive) - always interpreted as days, matching the one-file-per-day log layout. */
function parseDurationDays(input: string): number | null {
  const digits = /^(\d+)\s*d?$/i.exec(input.trim())?.[1];
  if (digits === undefined) return null;
  const days = Number(digits);
  return Number.isFinite(days) && days > 0 ? days : null;
}

function formatRetention(days: number | null): string {
  return days === null ? "unlimited (kept indefinitely)" : `${days} day(s)`;
}

/**
 * !log on|off toggles the current room's transcript log (mod, room-only). !log limit is a
 * separate, global, admin-only concern layered onto the same command name per the bot
 * owner's preference - since a single CommandDefinition has one level/room-requirement,
 * the room-context check for on/off and the elevated permission check for limit both live
 * inside the handler rather than in the dispatcher's usual per-command gating.
 */
export function createLogCommand(roomLogger: RoomLogger, roomStore: RoomStore, adminStore: AdminStore, botSettingsStore: BotSettingsStore): CommandDefinition {
  return {
    name: "log",
    level: "mod",
    description: "!log on|off toggles this room's chat transcript log. !log limit <Nd> sets how long room logs are kept globally (admin only).",
    usage: "!log on|off|limit <Nd|off>",
    async handler(ctx) {
      const [subRaw, ...rest] = ctx.rawArgs.trim().split(/\s+/);
      const sub = subRaw?.toLowerCase();

      if (sub === "limit") {
        if (!adminStore.isAdmin(ctx.senderCharacter)) {
          await ctx.reply("!log limit requires bot admin rights.");
          return;
        }

        const value = rest.join(" ").trim();
        if (value.length === 0) {
          await ctx.reply(`Current log retention: ${formatRetention(botSettingsStore.getLogRetentionDays())}. Usage: !log limit <Nd>|off`);
          return;
        }

        if (value.toLowerCase() === "off" || value.toLowerCase() === "none" || value === "0") {
          botSettingsStore.setLogRetentionDays(null);
          await ctx.reply("Log retention limit removed - room logs are now kept indefinitely.");
          return;
        }

        const days = parseDurationDays(value);
        if (days === null) {
          await ctx.reply("Usage: !log limit <Nd> (e.g. !log limit 30d), or !log limit off to disable the limit.");
          return;
        }

        botSettingsStore.setLogRetentionDays(days);
        await ctx.reply(`Log retention limit set to ${days} day(s). Older room-log files are deleted automatically (checked daily).`);
        return;
      }

      if (sub !== "on" && sub !== "off") {
        await ctx.reply("Usage: !log on|off|limit <Nd|off>");
        return;
      }

      if (ctx.source !== "room" || !ctx.room) {
        await ctx.reply("!log on/off can only be used inside a room, not in a private message.");
        return;
      }

      const room = ctx.room;
      if (sub === "on") {
        roomLogger.enable(room);
        roomStore.setLogging(room, true);
        await ctx.reply("Logging enabled for this room.");
      } else {
        roomLogger.disable(room);
        roomStore.setLogging(room, false);
        await ctx.reply("Logging disabled for this room.");
      }
    },
  };
}
