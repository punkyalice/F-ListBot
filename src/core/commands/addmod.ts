import type { AdminStore } from "../../store/adminStore";
import type { CommandDefinition } from "../types";

// admin-only by design: granting moderator power is itself an admin-level action, and a
// room mod should not be able to mint further mods (confirmed with the bot owner).
export function createAddModCommand(adminStore: AdminStore): CommandDefinition {
  return {
    name: "addmod",
    level: "admin",
    requiredRoomContext: true,
    description: "Grants a character moderator rights scoped to the room this command is run in.",
    usage: "!addmod <character>",
    async handler(ctx) {
      const character = ctx.rawArgs.trim();
      if (character.length === 0) {
        await ctx.reply("Usage: !addmod <character>");
        return;
      }
      adminStore.addRoomMod(ctx.room!, character, ctx.senderCharacter);
      await ctx.reply(`${character} is now a moderator for this room.`);
    },
  };
}
