// Example plugin: a more involved one than plugins/dice - demonstrates a persisted global
// setting (via storage with a sentinel "owner"), reacting to room-join events, and taking
// a moderation action (kicking a character).
//
// IMPORTANT - read before relying on this in production:
//   - Kicking requires the *F-List server* to consider this bot's character a channel op
//     (or owner) of the room. That's a separate permission system from this bot's own
//     admin/mod concept and entirely outside this bot's control - if the bot isn't a
//     channel op in a given room, the kick will silently fail server-side.
//   - Age/Apparent Age are free-text profile tags, not a verified field. Treat this as a
//     best-effort filter for characters who *do* state an age below your minimum, not a
//     guarantee that every underage-stated character will be caught (a character with no
//     age tags set, or a non-numeric one like "Ageless", is left alone - see
//     extractYoungestStatedAge below) or that the stated age is accurate.
//   - This checks every room the bot is in once a minimum age is set - there is currently
//     no per-room opt-out.
import type { BotAPI, CommandContext, CommandDefinition, Plugin } from "../../src/plugins/types";

// storage.get/set require an "owner" - there's no real character that owns a bot-wide
// setting, so this sentinel is used consistently for that purpose. Not a valid F-List
// character name, so it can never collide with a real one.
const CONFIG_OWNER = "__checkage_config__";
const MIN_AGE_KEY = "minAge";

function getMinAge(api: BotAPI): number | null {
  const raw = api.storage.get(null, CONFIG_OWNER, MIN_AGE_KEY);
  // storage has no delete - an empty string is the explicit "disabled" sentinel written by
  // setMinAge(api, null), distinct from `raw === null` (key never set at all).
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function setMinAge(api: BotAPI, minAge: number | null): void {
  api.storage.set(null, CONFIG_OWNER, MIN_AGE_KEY, minAge === null ? "" : String(minAge));
}

/** Pulls the first run of digits out of a profile tag value, e.g. "25", "Adult (25)", "500 (dragon)" -> the number; "Ageless"/"N/A"/unset -> null. */
function parseAge(value: string | undefined): number | null {
  if (!value) return null;
  const match = /\d+/.exec(value);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Takes the *lower* of "Age" and "Apparent Age" when both are present and parseable - the
 * conservative choice for a minimum-age filter (a character stated as an adult but
 * appearing younger still trips it). Returns null - meaning "don't enforce, can't tell" -
 * if neither tag is set or parseable, rather than guessing.
 */
function extractYoungestStatedAge(profileTags: Record<string, string>): number | null {
  const candidates = [parseAge(profileTags["Age"]), parseAge(profileTags["Apparent Age"])].filter((n): n is number => n !== null);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function createCheckageCommand(api: BotAPI): CommandDefinition {
  return {
    name: "checkage",
    level: "admin",
    description: "Shows or sets the minimum age enforced on room join (checks the 'Age'/'Apparent Age' profile tags). Admins/mods are always exempt.",
    usage: "!checkage [minAge|off]",
    async handler(ctx: CommandContext) {
      const arg = ctx.rawArgs.trim();

      if (arg.length === 0) {
        const current = getMinAge(api);
        await ctx.reply(`Current minimum age: ${current === null ? "not set (no enforcement)" : current}.`);
        return;
      }

      if (arg.toLowerCase() === "off") {
        setMinAge(api, null);
        await ctx.reply("Minimum age check disabled.");
        return;
      }

      const minAge = Number(arg);
      if (!Number.isFinite(minAge) || minAge <= 0) {
        await ctx.reply("Usage: !checkage [minAge|off], e.g. !checkage 18");
        return;
      }

      setMinAge(api, minAge);
      await ctx.reply(`Minimum age set to ${minAge}. Characters below this (via Age/Apparent Age) will be kicked on join unless they're a bot admin/mod.`);
    },
  };
}

const checkagePlugin = (api: BotAPI): Plugin => {
  let unsubscribe: (() => void) | undefined;

  return {
    id: "checkage",
    name: "Minimum Age Check",
    version: "1.0.0",
    commands: [createCheckageCommand(api)],
    onLoad() {
      unsubscribe = api.onRoomEvent("join", (room, character) => {
        void handleJoin(api, room, character);
      });
    },
    onUnload() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
};

async function handleJoin(api: BotAPI, room: string, character: string): Promise<void> {
  if (character === api.getBotCharacter()) return; // ignore the bot's own joins

  const minAge = getMinAge(api);
  if (minAge === null) return; // no check configured

  if (api.isAdmin(character) || api.isModerator(character, room)) return; // exempt

  let age: number | null;
  try {
    const info = await api.getUserInfo(character);
    age = extractYoungestStatedAge(info.profileTags);
  } catch (err) {
    api.log.warn("checkage: failed to look up joining character's profile", { err, character, room });
    return; // can't determine age - fail open, don't kick on a lookup failure
  }

  if (age === null || age >= minAge) return;

  api.log.info("checkage: kicking underage character", { character, room, age, minAge });
  try {
    await api.kickFromRoom(room, character);
  } catch (err) {
    api.log.warn("checkage: kick failed (is the bot a channel op in this room?)", { err, character, room });
    return;
  }

  await api
    .sendPM(
      character,
      `You were removed from a room because it requires a minimum age of ${minAge}, and your profile states an age of ${age}. If that's inaccurate, please update your profile.`
    )
    .catch(() => {}); // best-effort courtesy notice - a failure here shouldn't be treated as the kick itself failing
}

export default checkagePlugin;
