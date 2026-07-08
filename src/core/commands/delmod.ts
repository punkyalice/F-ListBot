import type { AdminStore } from "../../store/adminStore";
import type { CommandDefinition } from "../types";

// admin-only, mirroring !addmod: a room mod cannot revoke another mod's status.
export function createDelModCommand(adminStore: AdminStore): CommandDefinition {
  return {
    name: "delmod",
    level: "admin",
    requiredRoomContext: true,
    description: "Revokes a character's moderator rights for the current room. Cannot remove mods granted via BOOTSTRAP_MODS in .env.",
    usage: "!delmod <character>",
    async handler(ctx) {
      const character = ctx.rawArgs.trim();
      if (character.length === 0) {
        await ctx.reply("Usage: !delmod <character>");
        return;
      }
      const room = ctx.room!; // dispatcher guarantees this via requiredRoomContext
      const removed = adminStore.removeRoomMod(room, character);
      if (adminStore.isBootstrapRoomMod(room, character)) {
        await ctx.reply(
          `${character} is still a moderator here because they're listed in BOOTSTRAP_MODS in .env - remove them there and restart the bot to fully revoke.`
        );
      } else if (removed) {
        await ctx.reply(`${character} is no longer a moderator for this room.`);
      } else {
        await ctx.reply(`${character} wasn't a moderator for this room.`);
      }
    },
  };
}
