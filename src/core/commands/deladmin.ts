import type { AdminStore } from "../../store/adminStore";
import type { CommandDefinition } from "../types";

export function createDelAdminCommand(adminStore: AdminStore): CommandDefinition {
  return {
    name: "deladmin",
    level: "admin",
    description: "Revokes a character's global admin rights. Cannot remove admins granted via BOOTSTRAP_ADMINS in .env.",
    usage: "!deladmin <character>",
    async handler(ctx) {
      const character = ctx.rawArgs.trim();
      if (character.length === 0) {
        await ctx.reply("Usage: !deladmin <character>");
        return;
      }
      const removed = adminStore.removeAdmin(character);
      if (adminStore.isBootstrapAdmin(character)) {
        await ctx.reply(
          `${character} is still a bot admin because they're listed in BOOTSTRAP_ADMINS in .env - remove them there and restart the bot to fully revoke.`
        );
      } else if (removed) {
        await ctx.reply(`${character} is no longer a bot admin.`);
      } else {
        await ctx.reply(`${character} wasn't a bot admin.`);
      }
    },
  };
}
