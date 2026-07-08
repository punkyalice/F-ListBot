// Example/test plugin: demonstrates registering commands, using ctx.reply(), checking
// permissions implicitly via `level`, and calling the user-info capability (PRO/KIN).
// See ../README.md for the plugin-authoring guide this file is the working example for.
import type { BotAPI, CommandContext, CommandDefinition, Plugin } from "../../src/plugins/types";

// Conservative, hardcoded byte cap for a single [spoiler] block - safely under F-Chat's
// default 4096-byte room-message limit (BotAPI doesn't expose the live server-provided
// limit, so this errs on the safe side rather than reaching into bot internals for it -
// plugins are meant to stay within the BotAPI surface).
const MAX_SPOILER_BYTES = 3500;

/** Splits text on line boundaries into chunks that each fit under maxBytes (UTF-8). */
function chunkText(text: string, maxBytes: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (Buffer.byteLength(candidate, "utf-8") > maxBytes && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Formats one whois section (profile tags / custom kinks / standard kinks) as one or more `[spoiler]`-wrapped reply messages. */
function formatSpoilerSection(label: string, lines: string[]): string[] {
  if (lines.length === 0) return [`0 ${label}.`];
  const chunks = chunkText(lines.join("\n"), MAX_SPOILER_BYTES);
  return chunks.map((chunk, i) => {
    const countLabel = chunks.length > 1 ? `${lines.length} ${label} [${i + 1}/${chunks.length}]` : `${lines.length} ${label}`;
    return `${countLabel}: [spoiler]${chunk}[/spoiler]`;
  });
}

/** Where a command can be invoked from, derived from its requiredRoomContext/requiredPmContext flags. */
function whereLabel(def: CommandDefinition): string {
  if (def.requiredRoomContext) return "room only";
  if (def.requiredPmContext) return "PM only";
  return "anywhere";
}

function formatCommand(c: CommandDefinition): string {
  // `usage` already contains "!name" (plus any args), so don't repeat the bare name
  // in front of it too - that read as a duplicate (e.g. "!gdpr (PM only): !gdpr - ...").
  return `${c.usage} (${whereLabel(c)}) - ${c.description}`;
}

function createHelpCommand(api: BotAPI, name: string): CommandDefinition {
  return {
    name,
    level: "everyone",
    description: "Explains the bot's commands, filtered to what you're allowed to use.",
    usage: `!${name}`,
    async handler(ctx: CommandContext) {
      const isAdmin = api.isAdmin(ctx.senderCharacter);
      // Room-mod visibility: if invoked in a room, check that room specifically; if
      // invoked via PM (no room in context), fall back to "moderates at least one room
      // somewhere" so mod commands aren't hidden just because the request came via PM.
      const isModHere = ctx.room !== undefined && api.isModerator(ctx.senderCharacter, ctx.room);
      const modsAnywhere = api.getModeratedRooms(ctx.senderCharacter).length > 0;
      const canSeeMod = isAdmin || isModHere || modsAnywhere;
      const canSeeAdmin = isAdmin;

      const all = api.listCommands().slice().sort((a, b) => a.name.localeCompare(b.name));
      const everyone = all.filter((c) => c.level === "everyone");
      const mod = all.filter((c) => c.level === "mod");
      const admin = all.filter((c) => c.level === "admin");

      const lines: string[] = ["--- Commands ---", ...everyone.map(formatCommand)];

      if (canSeeMod && mod.length > 0) {
        lines.push("--- Moderator commands ---", ...mod.map(formatCommand));
      }
      if (canSeeAdmin && admin.length > 0) {
        lines.push("--- Admin commands ---", ...admin.map(formatCommand));
      }

      const hidden: string[] = [];
      if (!canSeeMod) hidden.push("moderator commands (you don't moderate any room the bot is in)");
      if (!canSeeAdmin) hidden.push("admin commands (you're not a bot admin)");
      if (hidden.length > 0) lines.push(`\nHidden: ${hidden.join(", ")}.`);

      await ctx.reply(lines.join("\n"));
    },
  };
}

function createWhoisCommand(api: BotAPI): CommandDefinition {
  return {
    name: "whois",
    level: "everyone",
    description: "Looks up a character's profile info. Full details are sent in spoiler-blocks.",
    usage: "!whois <character>",
    async handler(ctx: CommandContext) {
      const character = ctx.rawArgs.trim();
      if (character.length === 0) {
        await ctx.reply("Usage: !whois <character>");
        return;
      }
      try {
        const info = await api.getUserInfo(character);

        const tagLines = Object.entries(info.profileTags).map(([k, v]) => `${k}: ${v}`);
        const customLines = info.customKinks.map((k) => `${k.name}: ${k.description}`);
        const standardLines = info.standardKinks.map((k) => `${k.name} (${k.rating})`);

        // Standard (master-list) kinks come from a separate HTTP API call and are
        // best-effort - F-Chat's realtime KIN/KID command only ever returns *custom*
        // (free-text) kinks (confirmed against the F-Chat server source: KIN's handler
        // literally sends "Custom kinks of <name>" / "End of custom kinks."). An empty
        // list can mean either "none set" or "the HTTP lookup failed" - check the bot's
        // debug logs if this looks wrong for a character you know has standard kinks set.
        const standardLabel = "standard kink(s)" + (info.standardKinks.length === 0 ? " (or the HTTP lookup failed - check debug logs)" : "");

        const messages = [
          `${character}:`,
          ...formatSpoilerSection("profile tag(s)", tagLines),
          ...formatSpoilerSection("custom kink(s)", customLines),
          ...formatSpoilerSection(standardLabel, standardLines),
        ];

        for (const msg of messages) {
          await ctx.reply(msg);
        }
      } catch (err) {
        await ctx.reply(`Couldn't look up ${character}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

const helpPlugin = (api: BotAPI): Plugin => ({
  id: "help",
  name: "Help & Whois",
  version: "1.0.0",
  commands: [createHelpCommand(api, "help"), createHelpCommand(api, "commands"), createWhoisCommand(api)],
});

export default helpPlugin;
