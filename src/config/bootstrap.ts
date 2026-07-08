import { parseRoomCode } from "../protocol/roomCode";
import type { Config } from "./env";

export interface BootstrapRoomMod {
  room: string;
  character: string;
}

export interface Bootstrap {
  admins: Set<string>;
  mods: BootstrapRoomMod[];
}

/**
 * Parses BOOTSTRAP_ADMINS ("CharA,CharB") and BOOTSTRAP_MODS ("room:Char,room2:Char2")
 * from config, normalizing every room token through the same parseRoomCode() used
 * everywhere else so a bootstrap entry compares equal to a room joined at runtime
 * regardless of case or BBCode wrapping.
 */
export function parseBootstrap(config: Pick<Config, "bootstrapAdminsRaw" | "bootstrapModsRaw">): Bootstrap {
  const admins = new Set(
    config.bootstrapAdminsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );

  const mods: BootstrapRoomMod[] = [];
  for (const entry of config.bootstrapModsRaw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const sepIndex = trimmed.indexOf(":");
    if (sepIndex === -1) continue;
    const roomRaw = trimmed.slice(0, sepIndex);
    const character = trimmed.slice(sepIndex + 1).trim();
    const room = parseRoomCode(roomRaw);
    if (room && character.length > 0) {
      mods.push({ room, character });
    }
  }

  return { admins, mods };
}
