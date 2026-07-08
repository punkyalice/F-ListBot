// The only place in the codebase that parses/normalizes F-Chat room identifiers.
// Every other module (join/leave/addmod commands, .env bootstrap parsing, the room
// logger's filename slugifier) must go through parseRoomCode() rather than growing
// its own ad-hoc regex - room codes show up wrapped in BBCode, in mixed case, and
// need to compare equal regardless of source.

const SESSION_BBCODE_RE = /\[session=[^\]]*\]([^[]*)\[\/session\]/i;
const ADH_RE = /^adh-[0-9a-f]{20}$/i;

/**
 * Parses a room identifier from arbitrary user input. Accepts:
 *  - a raw ADH- room code, any case: "adh-1234567890abcdef1234"
 *  - the same wrapped in F-Chat session BBCode: "[session=Example Room]adh-1234567890abcdef1234[/session]"
 *  - an official channel name (no ADH- prefix at all), returned trimmed and unchanged
 *
 * Returns the canonical form (uppercase "ADH-" prefix + lowercase hex) for ADH- codes,
 * or the trimmed original string for official channel names. Returns null for empty input.
 */
export function parseRoomCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const bbcodeMatch = SESSION_BBCODE_RE.exec(trimmed);
  const candidate = (bbcodeMatch?.[1] ?? trimmed).trim();
  if (candidate.length === 0) return null;

  if (ADH_RE.test(candidate)) {
    const hex = candidate.slice(4).toLowerCase();
    return `ADH-${hex}`;
  }

  return candidate;
}

/**
 * Converts a canonical room identifier into a filesystem-safe path segment.
 * Allow-lists characters rather than block-listing them: official channel names are
 * arbitrary strings (spaces, punctuation, potentially "../" if something upstream ever
 * lets a raw title through) and must never be used as a path segment directly.
 */
export function slugifyRoomForFilename(room: string): string {
  const slug = room.replace(/[^a-zA-Z0-9_-]/g, "_");
  return slug.length > 0 ? slug : "_";
}
