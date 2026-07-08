import pino from "pino";
import type { Config } from "../config/env";

/**
 * Structured app logging (process lifecycle, connection state, plugin load errors etc.).
 * Distinct from roomLogger.ts, which handles the opt-in per-room chat transcript feature
 * (!log on/off) - these are two unrelated concerns that happen to both write to disk-ish
 * places, so keep them in separate files with separate purposes.
 *
 * Secrets are never passed to this logger by design (Config.password is a Secret<string>
 * whose toString()/toJSON() already redact), but pino's own `redact` is layered on top as
 * defense in depth in case a future field name collides with something sensitive.
 */
export function createLogger(logLevel: Config["logLevel"]) {
  const isTTY = process.stdout.isTTY;
  return pino({
    level: logLevel,
    redact: {
      paths: ["password", "*.password", "ticket", "*.ticket", "account", "*.account"],
      censor: "[REDACTED]",
    },
    transport: isTTY
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
