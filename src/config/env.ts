import "dotenv/config";
import { z } from "zod";

/**
 * Wraps a secret string so it can never be accidentally logged: `String(secret)`,
 * template-literal interpolation, and `JSON.stringify` all yield "[REDACTED]" instead of
 * the real value. Call `.reveal()` explicitly at the one or two call sites that actually
 * need the raw value (the ticket HTTP request).
 */
export class Secret<T extends string = string> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toString(): string {
    return "[REDACTED]";
  }
  toJSON(): string {
    return "[REDACTED]";
  }
}

const envSchema = z.object({
  FLIST_ACCOUNT: z.string().min(1, "FLIST_ACCOUNT is required"),
  FLIST_PASSWORD: z.string().min(1, "FLIST_PASSWORD is required"),
  FLIST_CHARACTER: z.string().min(1, "FLIST_CHARACTER is required"),
  CLIENT_NAME: z.string().default("FChatBot"),
  CLIENT_VERSION: z.string().default("0.1.0"),
  BOOTSTRAP_ADMINS: z.string().default(""),
  BOOTSTRAP_MODS: z.string().default(""),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATA_DIR: z.string().default("./data"),
  PLUGIN_DIR: z.string().default("./plugins"),
});

export interface Config {
  account: string;
  password: Secret;
  character: string;
  clientName: string;
  clientVersion: string;
  bootstrapAdminsRaw: string;
  bootstrapModsRaw: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  dataDir: string;
  pluginDir: string;
}

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration in .env:\n${issues}`);
  }
  const env = parsed.data;
  return {
    account: env.FLIST_ACCOUNT,
    password: new Secret(env.FLIST_PASSWORD),
    character: env.FLIST_CHARACTER,
    clientName: env.CLIENT_NAME,
    clientVersion: env.CLIENT_VERSION,
    bootstrapAdminsRaw: env.BOOTSTRAP_ADMINS,
    bootstrapModsRaw: env.BOOTSTRAP_MODS,
    logLevel: env.LOG_LEVEL,
    dataDir: env.DATA_DIR,
    pluginDir: env.PLUGIN_DIR,
  };
}
