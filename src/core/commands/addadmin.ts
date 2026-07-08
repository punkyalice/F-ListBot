import type { AdminStore } from "../../store/adminStore";
import type { CommandDefinition } from "../types";

export function createAddAdminCommand(adminStore: AdminStore): CommandDefinition {
  return {
    name: "addadmin",
    level: "admin",
    description: "Grants a character global admin rights over the bot.",
    usage: "!addadmin <character>",
    async handler(ctx) {
      const character = ctx.rawArgs.trim();
      if (character.length === 0) {
        await ctx.reply("Usage: !addadmin <character>");
        return;
      }
      adminStore.addAdmin(character, ctx.senderCharacter);
      await ctx.reply(`${character} is now a bot admin.`);
    },
  };
}
