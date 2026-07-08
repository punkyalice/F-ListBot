// Typed catalog of the F-Chat protocol surface this bot uses. `ServerEvent` is a
// discriminated union (tag = `code`) so a `switch` on `.code` gives exhaustive,
// correctly-narrowed types downstream - in particular JCH and LCH deliberately carry
// different `character` shapes (object vs. bare string) and are NOT normalized to look
// the same, so using the wrong shape is a compile error, not a runtime `undefined`.

import type { RawCommand } from "./wire";
import { parseRoomCode } from "./roomCode";

export type RoomMode = "ads" | "chat" | "both";
export type OnlineStatus = "online" | "looking" | "busy" | "dnd" | "idle" | "away" | "crown";
export type TypingStatus = "clear" | "paused" | "typing";

export interface LisCharacterTuple {
  name: string;
  gender: string;
  status: string;
  statusMessage: string;
}

export type ServerEvent =
  | { code: "IDN"; character: string }
  | { code: "CON"; count: number }
  | { code: "LIS"; characters: LisCharacterTuple[] }
  | { code: "FRL"; characters: string[] }
  | { code: "ADL"; ops: string[] }
  | { code: "JCH"; channel: string; character?: { identity: string }; title?: string }
  | { code: "ICH"; channel: string; users: { identity: string }[]; mode: RoomMode }
  | { code: "CDS"; channel: string; description: string }
  | { code: "LCH"; channel: string; character: string }
  | { code: "MSG"; channel: string; character: string; message: string }
  | { code: "LRP"; channel: string; character: string; message: string }
  | { code: "PRI"; character: string; message: string }
  | { code: "NLN"; identity: string; gender: string; status: string }
  | { code: "FLN"; character: string }
  | { code: "PIN" }
  | { code: "VAR"; variable: string; value: number | string | string[] }
  | { code: "PRD"; type: "start" | "info" | "select" | "end"; message?: string; key?: string; value?: string }
  // NOTE: the wiki documents key/value as "[int]" (arrays of ints), but that's wrong -
  // confirmed against a live server: a "custom" KID event carries a single string key
  // (the custom kink's name) and a single string value (its free-text description), one
  // pair per event - not arrays, not numbers.
  | { code: "KID"; type: "start" | "custom" | "end"; message?: string; key?: string; value?: string }
  | { code: "TPN"; character: string; status: TypingStatus }
  | { code: "STA"; character: string; status: OnlineStatus; statusmsg: string }
  | { code: "SYS"; message: string; channel?: string }
  | { code: "ERR"; number: number; message: string }
  | { code: "UPT"; time: number; starttime: number; startstring: string; accepted: number; channels: number; users: number; maxusers: number };

/**
 * Canonicalizes a channel identifier the same way parseRoomCode() does for user-typed
 * input. Critical: the server's own echoed channel casing isn't guaranteed to match what
 * we sent (it reflects however the room was originally created/stored server-side) - if
 * this weren't applied here, `ctx.room` from a live MSG/JCH event could end up a
 * differently-cased string than what !join persisted for the same physical room, causing
 * every room-keyed table (rooms, room_mods, plugin_config, kv_store) to silently split
 * into duplicate rows depending on whether a room reference came from typed input or from
 * a server event. Applying it once here, for every inbound channel field, means every
 * consumer downstream always sees the same canonical form regardless of source.
 */
function normalizeChannel(channel: string): string {
  return parseRoomCode(channel) ?? channel;
}

/**
 * Maps a decoded raw wire frame into a typed ServerEvent. Returns null for codes we don't
 * model (there are many admin/moderation server commands not needed by this bot yet) or
 * for payloads that don't match the expected shape - callers should log at debug and
 * ignore, never throw, since an unrecognized-but-harmless server message must not crash
 * the bot.
 */
export function toServerEvent(raw: RawCommand): ServerEvent | null {
  const p = raw.payload as Record<string, unknown> | undefined;

  switch (raw.code) {
    case "IDN":
      return typeof p?.character === "string" ? { code: "IDN", character: p.character } : null;
    case "CON":
      return typeof p?.count === "number" ? { code: "CON", count: p.count } : null;
    case "LIS": {
      const raw_chars = p?.characters;
      if (!Array.isArray(raw_chars)) return null;
      const characters: LisCharacterTuple[] = raw_chars
        .filter((t): t is unknown[] => Array.isArray(t) && t.length >= 4)
        .map((t) => ({
          name: String(t[0]),
          gender: String(t[1]),
          status: String(t[2]),
          statusMessage: String(t[3]),
        }));
      return { code: "LIS", characters };
    }
    case "FRL":
      return Array.isArray(p?.characters) ? { code: "FRL", characters: p.characters as string[] } : null;
    case "ADL":
      return Array.isArray(p?.ops) ? { code: "ADL", ops: p.ops as string[] } : null;
    case "JCH":
      return typeof p?.channel === "string"
        ? {
            code: "JCH",
            channel: normalizeChannel(p.channel),
            character: p.character as { identity: string } | undefined,
            title: p.title as string | undefined,
          }
        : null;
    case "ICH":
      return typeof p?.channel === "string" && Array.isArray(p?.users)
        ? { code: "ICH", channel: normalizeChannel(p.channel), users: p.users as { identity: string }[], mode: p.mode as RoomMode }
        : null;
    case "CDS":
      return typeof p?.channel === "string" && typeof p?.description === "string"
        ? { code: "CDS", channel: normalizeChannel(p.channel), description: p.description }
        : null;
    case "LCH":
      return typeof p?.channel === "string" && typeof p?.character === "string"
        ? { code: "LCH", channel: normalizeChannel(p.channel), character: p.character }
        : null;
    case "MSG":
      return typeof p?.channel === "string" && typeof p?.character === "string" && typeof p?.message === "string"
        ? { code: "MSG", channel: normalizeChannel(p.channel), character: p.character, message: p.message }
        : null;
    case "LRP":
      return typeof p?.channel === "string" && typeof p?.character === "string" && typeof p?.message === "string"
        ? { code: "LRP", channel: normalizeChannel(p.channel), character: p.character, message: p.message }
        : null;
    case "PRI":
      return typeof p?.character === "string" && typeof p?.message === "string"
        ? { code: "PRI", character: p.character, message: p.message }
        : null;
    case "NLN":
      return typeof p?.identity === "string"
        ? { code: "NLN", identity: p.identity, gender: String(p.gender), status: String(p.status) }
        : null;
    case "FLN":
      return typeof p?.character === "string" ? { code: "FLN", character: p.character } : null;
    case "PIN":
      return { code: "PIN" };
    case "VAR":
      return typeof p?.variable === "string" ? { code: "VAR", variable: p.variable, value: p.value as number | string | string[] } : null;
    case "PRD":
      return typeof p?.type === "string"
        ? { code: "PRD", type: p.type as "start" | "info" | "select" | "end", message: p.message as string | undefined, key: p.key as string | undefined, value: p.value as string | undefined }
        : null;
    case "KID":
      return typeof p?.type === "string"
        ? { code: "KID", type: p.type as "start" | "custom" | "end", message: p.message as string | undefined, key: p.key as string | undefined, value: p.value as string | undefined }
        : null;
    case "TPN":
      return typeof p?.character === "string" && typeof p?.status === "string"
        ? { code: "TPN", character: p.character, status: p.status as TypingStatus }
        : null;
    case "STA":
      return typeof p?.character === "string"
        ? { code: "STA", character: p.character, status: p.status as OnlineStatus, statusmsg: String(p.statusmsg ?? "") }
        : null;
    case "SYS":
      return typeof p?.message === "string"
        ? { code: "SYS", message: p.message, channel: typeof p.channel === "string" ? normalizeChannel(p.channel) : undefined }
        : null;
    case "ERR":
      return typeof p?.number === "number" && typeof p?.message === "string"
        ? { code: "ERR", number: p.number, message: p.message }
        : null;
    case "UPT":
      return typeof p?.time === "number"
        ? {
            code: "UPT",
            time: p.time,
            starttime: Number(p.starttime),
            startstring: String(p.startstring),
            accepted: Number(p.accepted),
            channels: Number(p.channels),
            users: Number(p.users),
            maxusers: Number(p.maxusers),
          }
        : null;
    default:
      return null;
  }
}
