import type { RoomLogger } from "../../logging/roomLogger";
import type { RoomStore } from "../../store/roomStore";
import type { CommandDefinition } from "../types";

export function createLogCommand(roomLogger: RoomLogger, roomStore: RoomStore): CommandDefinition {
  return {
    name: "log",
    level: "mod",
    requiredRoomContext: true,
    description: "Toggles a chat transcript log for the current room.",
    usage: "!log on|off",
    async handler(ctx) {
      const room = ctx.room!;
      const arg = ctx.rawArgs.trim().toLowerCase();
      if (arg === "on") {
        roomLogger.enable(room);
        roomStore.setLogging(room, true);
        await ctx.reply(`Logging enabled for this room.`);
      } else if (arg === "off") {
        roomLogger.disable(room);
        roomStore.setLogging(room, false);
        await ctx.reply(`Logging disabled for this room.`);
      } else {
        await ctx.reply(`Usage: !log on|off`);
      }
    },
  };
}
