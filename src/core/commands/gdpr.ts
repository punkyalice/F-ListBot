import type { AdminStore } from "../../store/adminStore";
import type { KvStore } from "../../store/kvStore";
import type { RoomLogger } from "../../logging/roomLogger";
import type { BotSettingsStore } from "../../store/botSettingsStore";
import type { Messenger } from "../messenger";
import type { CommandDefinition } from "../types";
import { chunkText } from "../../util/textChunking";

// Defensive cap against pathological cases (a bot running for years in many active,
// logged rooms) - not a normal-case limit. See RoomLogger.findEntriesForCharacter.
const LOG_ENTRY_LIMIT = 2000;

/**
 * !gdpr always operates on the sender's own character - it takes no target argument at
 * all, by construction, so there is no way to query another character's data through this
 * command. PM-only (requiredPmContext) so a full data export can never be replied into a
 * public room, even accidentally.
 */
export function createGdprCommand(
  adminStore: AdminStore,
  kvStore: KvStore,
  roomLogger: RoomLogger,
  botSettingsStore: BotSettingsStore,
  messenger: Messenger
): CommandDefinition {
  return {
    name: "gdpr",
    level: "everyone",
    requiredPmContext: true,
    description: "Shows everything the bot has stored about you: admin/mod status, plugin data, and chat log entries. Always your own character only.",
    usage: "!gdpr",
    async handler(ctx) {
      const character = ctx.senderCharacter;
      const lines: string[] = [`=== Data on file for ${character} ===`];

      const isAdmin = adminStore.isAdmin(character);
      lines.push(`Bot admin: ${isAdmin ? "yes" : "no"}`);

      const modRooms = adminStore.listRoomsModeratedBy(character);
      lines.push(`Room moderator in: ${modRooms.length === 0 ? "none" : modRooms.map((m) => `${m.room} (${m.source})`).join(", ")}`);

      const kvEntries = kvStore.listForOwner(character);
      lines.push(`\nStored plugin data (${kvEntries.length} entr${kvEntries.length === 1 ? "y" : "ies"}):`);
      if (kvEntries.length === 0) {
        lines.push("(none)");
      } else {
        for (const e of kvEntries) {
          lines.push(`- [${e.namespace}]${e.room ? ` room=${e.room}` : ""} ${e.key} = ${e.value}`);
        }
      }

      const retentionDays = botSettingsStore.getLogRetentionDays();
      const { entries: logEntries, truncated } = await roomLogger.findEntriesForCharacter(character, LOG_ENTRY_LIMIT);
      lines.push(
        `\nChat log entries (${logEntries.length}${truncated ? "+, internal limit reached - contact the operator for a complete export" : ""}):`
      );
      lines.push(`Log retention policy: ${retentionDays === null ? "kept indefinitely (no automatic deletion)" : `entries older than ${retentionDays} day(s) are deleted automatically`}.`);
      if (logEntries.length === 0) {
        lines.push("(none)");
      } else {
        for (const e of logEntries) {
          lines.push(`- [${e.room}] ${e.date} ${e.ts} (${e.type}): ${e.message}`);
        }
      }

      lines.push(`\n=== End of data export ===`);

      const fullText = lines.join("\n");
      const maxBytes = Math.max(messenger.getLimits().privMaxBytes - 200, 500); // safety margin for framing
      const chunks = chunkText(fullText, maxBytes);

      for (const [i, chunk] of chunks.entries()) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
        await messenger.sendPM(character, prefix + chunk);
      }
    },
  };
}
