import type { CommandDefinition } from "./types";

interface RegisteredCommand {
  def: CommandDefinition;
  pluginId: string | null; // null = core command
}

/**
 * Single flat namespace shared by core and plugin commands. Core commands are registered
 * once at startup and are immutable; a plugin trying to register a name that collides
 * with a core command fails loudly at load time rather than silently shadowing it - core
 * commands always win by construction (registered first, and registerPlugin explicitly
 * rejects collisions).
 */
export class CommandRegistry {
  #commands = new Map<string, RegisteredCommand>();

  registerCore(def: CommandDefinition): void {
    const key = def.name.toLowerCase();
    if (this.#commands.has(key)) {
      throw new Error(`Core command "${def.name}" is already registered.`);
    }
    this.#commands.set(key, { def, pluginId: null });
  }

  registerPlugin(pluginId: string, def: CommandDefinition): void {
    const key = def.name.toLowerCase();
    const existing = this.#commands.get(key);
    if (existing && existing.pluginId === null) {
      throw new Error(`Plugin "${pluginId}" cannot register "!${def.name}" - it collides with a core command.`);
    }
    if (existing) {
      throw new Error(`Plugin "${pluginId}" cannot register "!${def.name}" - it collides with a command from plugin "${existing.pluginId}".`);
    }
    this.#commands.set(key, { def, pluginId });
  }

  unregisterPlugin(pluginId: string): void {
    for (const [key, cmd] of this.#commands) {
      if (cmd.pluginId === pluginId) this.#commands.delete(key);
    }
  }

  resolve(name: string): CommandDefinition | undefined {
    return this.#commands.get(name.toLowerCase())?.def;
  }

  list(): CommandDefinition[] {
    return [...this.#commands.values()].map((c) => c.def);
  }

  listCore(): CommandDefinition[] {
    return [...this.#commands.values()].filter((c) => c.pluginId === null).map((c) => c.def);
  }

  /** Which plugin (if any) owns the command at this name - used by the dispatcher's room-scope check. */
  pluginOwning(name: string): string | null | undefined {
    const cmd = this.#commands.get(name.toLowerCase());
    return cmd?.pluginId;
  }
}
