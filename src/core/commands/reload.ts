import type { PluginManager } from "../../plugins/PluginManager";
import type { CommandDefinition } from "../types";

export function createReloadCommand(pluginManager: PluginManager): CommandDefinition {
  return {
    name: "reload",
    level: "admin",
    description: "Hot-reloads plugin(s) without dropping the connection. Optionally give a plugin id to reload just that one.",
    usage: "!reload [pluginId]",
    async handler(ctx) {
      const pluginId = ctx.rawArgs.trim() || undefined;
      const results = await pluginManager.reload(pluginId);
      if (results.length === 0) {
        await ctx.reply(pluginId ? `No loaded plugin named "${pluginId}".` : "No plugins to reload.");
        return;
      }
      const summary = results.map((r) => (r.success ? `${r.pluginId}: ok` : `${r.pluginId}: FAILED (${r.error})`)).join(", ");
      await ctx.reply(`Reload complete - ${summary}`);
    },
  };
}
