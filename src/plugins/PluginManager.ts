import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { transformSync } from "esbuild";
import type { CommandRegistry } from "../core/commandRegistry";
import type { BotAPI, Plugin, PluginModule } from "./types";
import type { Logger } from "../logging/logger";

interface LoadedPlugin {
  plugin: Plugin;
  dir: string;
  entryPath: string;
}

// Every real plugin id comes from a directory name under plugins/ (readdirSync in
// scanAndLoadAll, never user input). !reload's pluginId argument, by contrast, is
// chat-supplied - without this check, an id like "../../../../etc" would flow straight
// into path.join(pluginDir, id) below and could resolve outside the plugins directory
// entirely. Only admins can run !reload, so this isn't a privilege-escalation path, but
// unsanitized user input reaching a filesystem path is worth closing regardless.
const SAFE_PLUGIN_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface ReloadResult {
  pluginId: string;
  success: boolean;
  error?: string;
}

let tsHookRegistered = false;

/**
 * Registers a require.extensions['.ts'] loader, once per process, that transpiles TS to
 * CJS on the fly via esbuild's transformSync (no type-checking - that's an intentional
 * tradeoff for reload latency; plugin authors should run `tsc --noEmit` separately for
 * type safety). This is what lets `!reload` pick up edits to a plugin's .ts source
 * without a separate build step per plugin.
 */
function registerTsRequireHook(): void {
  if (tsHookRegistered) return;
  tsHookRegistered = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (require as any).extensions[".ts"] = function (mod: any, filename: string) {
    const source = readFileSync(filename, "utf-8");
    const { code } = transformSync(source, {
      loader: "ts",
      format: "cjs",
      target: "node18",
      sourcefile: filename,
    });
    mod._compile(code, filename);
  };
}

/**
 * Scans plugins/, loads each subdirectory as a plugin, and supports hot-reloading via
 * !reload without dropping the websocket connection. A plugin that fails to load
 * (syntax error, throwing onLoad) never crashes the bot process - the failure is caught,
 * logged, and reported back through the reload result; other plugins are unaffected.
 */
export class PluginManager {
  #pluginDir: string;
  #registry: CommandRegistry;
  #makeApi: (pluginId: string) => BotAPI;
  #logger: Logger;
  #loaded = new Map<string, LoadedPlugin>();

  constructor(pluginDir: string, registry: CommandRegistry, makeApi: (pluginId: string) => BotAPI, logger: Logger) {
    // Must be absolute: require()/require.resolve() only treat a path as filesystem-relative
    // when it starts with "./", "../", or "/" - path.join() strips a leading "./" (e.g.
    // "./plugins" + "help" -> "plugins/help"), which Node then interprets as a bare module
    // specifier to search node_modules for, not a path relative to cwd. Resolving once here
    // avoids that trap for every path derived from #pluginDir below.
    this.#pluginDir = path.resolve(pluginDir);
    this.#registry = registry;
    this.#makeApi = makeApi;
    this.#logger = logger;
    registerTsRequireHook();
  }

  async scanAndLoadAll(): Promise<ReloadResult[]> {
    if (!existsSync(this.#pluginDir)) return [];
    const results: ReloadResult[] = [];
    for (const entry of readdirSync(this.#pluginDir)) {
      const dir = path.join(this.#pluginDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      results.push(await this.#tryLoad(entry, dir));
    }
    return results;
  }

  /** !reload entry point. Reloads a single plugin by id, or every currently-loaded plugin if no id is given. */
  async reload(pluginId?: string): Promise<ReloadResult[]> {
    if (pluginId !== undefined && !SAFE_PLUGIN_ID_RE.test(pluginId)) {
      return [{ pluginId, success: false, error: "Invalid plugin id." }];
    }
    const ids = pluginId ? [pluginId] : [...this.#loaded.keys()];
    const results: ReloadResult[] = [];
    for (const id of ids) {
      const existing = this.#loaded.get(id);
      const dir = existing?.dir ?? path.join(this.#pluginDir, id);
      await this.#unload(id);
      results.push(await this.#tryLoad(id, dir));
    }
    return results;
  }

  listLoaded(): string[] {
    return [...this.#loaded.keys()];
  }

  async #tryLoad(id: string, dir: string): Promise<ReloadResult> {
    try {
      await this.#load(id, dir);
      return { pluginId: id, success: true };
    } catch (err) {
      this.#logger.error({ err, pluginId: id }, "Failed to load plugin");
      return { pluginId: id, success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #load(id: string, dir: string): Promise<void> {
    const entryPath = this.#resolveEntry(dir);
    this.#bustCache(entryPath);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entryPath);
    const pluginModule: PluginModule = mod.default ?? mod;
    const api = this.#makeApi(id);
    const plugin = typeof pluginModule === "function" ? pluginModule(api) : pluginModule;

    if (plugin.id !== id) {
      throw new Error(`Plugin at ${dir} declares id "${plugin.id}" but its directory is "${id}" - they must match.`);
    }

    await plugin.onLoad?.(api);

    for (const cmd of plugin.commands ?? []) {
      this.#registry.registerPlugin(id, cmd);
    }

    this.#loaded.set(id, { plugin, dir, entryPath });
  }

  async #unload(id: string): Promise<void> {
    const loaded = this.#loaded.get(id);
    if (!loaded) return;
    try {
      await loaded.plugin.onUnload?.();
    } catch (err) {
      this.#logger.warn({ err, pluginId: id }, "Plugin onUnload threw - continuing unload anyway");
    }
    this.#registry.unregisterPlugin(id);
    this.#bustCache(loaded.entryPath);
    this.#loaded.delete(id);
  }

  #resolveEntry(dir: string): string {
    for (const name of ["plugin.ts", "plugin.js", "index.ts", "index.js"]) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return require.resolve(candidate);
    }
    throw new Error(`No plugin.ts/plugin.js/index.ts/index.js entry file found in ${dir}`);
  }

  /**
   * Deletes require.cache entries for the plugin's entry file and, recursively, any
   * modules it required that live under the plugin's own directory - but stops at
   * node_modules boundaries so shared dependencies (e.g. lodash) aren't reloaded or
   * duplicated. This is the concrete mechanism behind hot-reload actually picking up
   * source changes instead of serving a stale cached module.
   */
  #bustCache(entryPath: string): void {
    let resolved: string;
    try {
      resolved = require.resolve(entryPath);
    } catch {
      return; // never loaded, nothing to bust
    }
    const pluginDirPrefix = path.dirname(resolved) + path.sep;
    const seen = new Set<string>();

    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached = (require as any).cache[id];
      if (!cached) return;
      for (const child of cached.children ?? []) {
        if (child.id.startsWith(pluginDirPrefix) && !child.id.includes(`${path.sep}node_modules${path.sep}`)) {
          walk(child.id);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (require as any).cache[id];
    };
    walk(resolved);
  }
}
