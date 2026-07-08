import type { CommandDefinition } from "../types";

export function createRestartCommand(requestRestart: () => void): CommandDefinition {
  return {
    name: "restart",
    level: "admin",
    description: "Cleanly shuts down the bot process. An external process manager (pm2/systemd/Docker) must restart it - the bot does not respawn itself.",
    usage: "!restart",
    async handler(ctx) {
      await ctx.reply("Restarting...");
      requestRestart();
    },
  };
}
