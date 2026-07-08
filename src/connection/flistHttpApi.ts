// F-List's authenticated HTTP JSON API (distinct from the chat websocket protocol).
// Endpoint list and rules confirmed against the official docs at
// https://wiki.f-list.net/Json_endpoints:
//   - All endpoints are POST. Most need "account"+"ticket" form fields (the SAME ticket
//     used for the websocket IDN handshake - no separate login needed); kink-list.php and
//     info-list.php are explicitly exempt from that requirement.
//   - Policy: "Limit requests to one per second and character data requests to less than
//     200 per hour." The 1/sec-overall part is already satisfied naturally (getUserInfo()
//     calls are serialized ~10.5s apart, see UserInfoClient), but the character-data.php
//     hourly cap needs its own tracking here (see HourlyRateLimiter below).
//
// This exists because the realtime KIN/KID websocket command only ever returns a
// character's *custom* kinks (confirmed against the F-Chat server's own source -
// event.KIN sends "Custom kinks of X" / "End of custom kinks.", nothing else, and against
// a live server via manual testing). A character's *standard* (master-list) kink ratings
// are only available through this HTTP API - character-data.php, resolved against the
// site-wide kink dictionary from kink-list.php.
//
// Both shapes below are confirmed against live responses:
//   - character-data.php: { kinks: { "<kinkId>": "no"|"maybe"|"yes"|"fave", ... }, custom_kinks: {...}, ... } -
//     only "kinks" is used here (custom kinks are already obtained more cheaply via the
//     websocket, see UserInfoClient).
//   - kink-list.php: { kinks: { "<groupId>": { group: "<group name>", items: [{ kink_id, name, description }, ...] }, ... } } -
//     grouped by category, NOT a flat kinkId -> entry map (an earlier version of this file
//     assumed flat and silently resolved zero names as a result - every top-level value is
//     a *group*, the actual kinks are one level deeper in each group's `items` array).

import { decodeHtmlEntities } from "../util/htmlEntities";

const API_BASE = "https://www.f-list.net/json/api";

interface RawApiResponse {
  error?: string;
  [key: string]: unknown;
}

async function callFlistApi(functionName: string, params: Record<string, string>): Promise<RawApiResponse> {
  const body = new URLSearchParams(params);
  const response = await fetch(`${API_BASE}/${functionName}.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`F-List API call to ${functionName} failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as RawApiResponse;
  if (data.error) {
    throw new Error(`F-List API call to ${functionName} rejected: ${data.error}`);
  }
  return data;
}

/**
 * Enforces F-List's documented "<200 character-data requests per hour" policy with a
 * sliding 1-hour window. Capped at 180 (not 200) for a safety margin. A denied request
 * should be treated as "temporarily unavailable", not an error - callers skip the
 * standard-kinks lookup gracefully and log a warning (see UserInfoClient).
 */
class HourlyRateLimiter {
  #timestamps: number[] = [];
  #limit: number;
  #windowMs = 60 * 60 * 1000;

  constructor(limit: number) {
    this.#limit = limit;
  }

  tryAcquire(): boolean {
    const now = Date.now();
    this.#timestamps = this.#timestamps.filter((t) => now - t < this.#windowMs);
    if (this.#timestamps.length >= this.#limit) return false;
    this.#timestamps.push(now);
    return true;
  }
}

const characterDataLimiter = new HourlyRateLimiter(180);

export interface KinkListEntry {
  id: number;
  name: string;
  description?: string;
}

/**
 * Fetches the site-wide kink ID -> name/description dictionary. Does not require
 * account/ticket per the API docs. This is static, shared data (not per-character) -
 * callers should fetch it once and cache it for the process lifetime rather than
 * refetching per lookup (see UserInfoClient's cache).
 */
export async function fetchKinkList(logDebug: (msg: string, meta?: object) => void): Promise<Map<number, KinkListEntry>> {
  const data = await callFlistApi("kink-list", {});
  logDebug("Raw kink-list.php response", { data });

  const map = new Map<number, KinkListEntry>();
  const rawGroups = data["kinks"];

  const addEntry = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    const id = Number(entry["kink_id"] ?? entry["id"]);
    const name = entry["name"];
    if (!Number.isNaN(id) && typeof name === "string") {
      map.set(id, {
        id,
        name: decodeHtmlEntities(name),
        description: typeof entry["description"] === "string" ? decodeHtmlEntities(entry["description"]) : undefined,
      });
    }
  };

  // Confirmed shape (live response): { kinks: { "<groupId>": { group: "<name>", items: [{ kink_id, name, description }, ...] }, ... } }
  // Grouped by category - every top-level value under "kinks" is a *group*, not a kink itself.
  if (rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)) {
    for (const groupValue of Object.values(rawGroups as Record<string, unknown>)) {
      if (!groupValue || typeof groupValue !== "object") continue;
      const items = (groupValue as Record<string, unknown>)["items"];
      if (!Array.isArray(items)) continue;
      for (const item of items) addEntry(item);
    }
  } else if (Array.isArray(rawGroups)) {
    // Fallback: a flat array of kink entries, in case the API ever changes shape.
    for (const item of rawGroups) addEntry(item);
  }

  return map;
}

export interface StandardKinkRating {
  kinkId: number;
  /** Rating string as returned by the API: "fave" | "yes" | "maybe" | "no" - confirmed against a live character-data.php response. */
  rating: string;
}

/**
 * Fetches a character's full data via character-data.php and extracts the STANDARD
 * (master-list) kink ratings - separate from KIN/KID's custom-only kinks. character-data.php
 * also returns description, infotags, custom kinks, images etc., all ignored here since
 * profile tags and custom kinks are already obtained more cheaply via the websocket
 * PRO/KIN commands (which don't count against this endpoint's hourly rate limit).
 *
 * Returns `null` (not an error) if the hourly rate limit has been reached - callers should
 * treat that as "temporarily unavailable" and skip gracefully.
 */
export async function fetchCharacterKinks(
  account: string,
  ticket: string,
  name: string,
  logDebug: (msg: string, meta?: object) => void
): Promise<StandardKinkRating[] | null> {
  if (!characterDataLimiter.tryAcquire()) {
    return null;
  }

  const data = await callFlistApi("character-data", { account, ticket, name });
  logDebug("Raw character-data.php response", { data });

  const rawKinks = data["kinks"];
  const results: StandardKinkRating[] = [];

  // Confirmed shape (live response): { kinks: { "<id>": "fave" | "yes" | "maybe" | "no", ... } }
  if (rawKinks && typeof rawKinks === "object" && !Array.isArray(rawKinks)) {
    for (const [idStr, value] of Object.entries(rawKinks as Record<string, unknown>)) {
      const id = Number(idStr);
      if (!Number.isNaN(id) && typeof value === "string") {
        results.push({ kinkId: id, rating: value });
      }
    }
  } else if (Array.isArray(rawKinks)) {
    // Fallback shape: { kinks: [{ id/kink_id, choice/rating }, ...] }
    for (const value of rawKinks) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const idRaw = entry["id"] ?? entry["kink_id"];
      const id = Number(idRaw);
      const rating = entry["choice"] ?? entry["rating"];
      if (!Number.isNaN(id) && typeof rating === "string") {
        results.push({ kinkId: id, rating });
      }
    }
  }

  return results;
}
