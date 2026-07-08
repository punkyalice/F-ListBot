import type { FChatConnection } from "../connection/FChatConnection";
import type { OutgoingQueue } from "../connection/outgoingQueue";
import type { ServerEvent } from "../protocol/messages";
import type { Logger } from "../logging/logger";
import { fetchKinkList, fetchCharacterKinks, type KinkListEntry, type StandardKinkRating } from "../connection/flistHttpApi";
import { decodeHtmlEntities } from "../util/htmlEntities";

export interface ResolvedStandardKink {
  kinkId: number;
  name: string;
  rating: string;
}

export interface CustomKink {
  name: string;
  description: string;
}

export interface UserInfo {
  character: string;
  profileTags: Record<string, string>;
  /** Custom (free-text) kinks only - see the module doc comment on why standard kinks are separate. */
  customKinks: CustomKink[];
  /**
   * Standard (master-list) kink ratings, resolved to names via the site-wide kink
   * dictionary. Best-effort: if the HTTP API call fails (network issue, unexpected
   * response shape, no ticket available yet), this is an empty array rather than failing
   * the whole getUserInfo() call - profile tags and custom kinks are still returned.
   */
  standardKinks: ResolvedStandardKink[];
}

interface PendingRequest {
  character: string;
  resolve: (info: UserInfo) => void;
  reject: (err: Error) => void;
  profileTags: Record<string, string>;
  customKinks: CustomKink[];
  stage: "profile" | "kinks";
  timeout: NodeJS.Timeout;
}

interface QueuedRequest {
  character: string;
  resolve: (info: UserInfo) => void;
  reject: (err: Error) => void;
}

const REQUEST_TIMEOUT_MS = 15_000;
// Conservative interpretation of the spec's separate "10s between profile requests" (ERR 7)
// and "10s between kink requests" (ERR 13) throttles: treat PRO+KIN together as one 10s
// cooldown per character-lookup rather than trying to track two independent windows -
// cheaper to implement, never risks hitting either error code. The standard-kinks HTTP
// fetch that follows isn't part of F-Chat's websocket flood control at all, but happens
// within the same per-lookup slot anyway since it's part of the same logical request.
const MIN_GAP_MS = 10_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps PRO (profile) + KIN (kinks) requests. Critically, the server's PRD/KID responses
 * do NOT echo back which character they're for - so only one request can be in flight at
 * a time system-wide, and this class enforces that via a single global queue rather than
 * per-character tracking. Exposed to plugins through BotAPI.getUserInfo().
 *
 * Also fetches standard (master-list) kink ratings via F-List's HTTP JSON API, since the
 * realtime KIN/KID websocket command only ever returns *custom* kinks (confirmed against
 * the F-Chat server's own source: event.KIN's handler literally sends "Custom kinks of X"
 * / "End of custom kinks." and nothing else). See connection/flistHttpApi.ts for details
 * and caveats on that API.
 */
export class UserInfoClient {
  #connection: FChatConnection;
  #outgoingQueue: OutgoingQueue;
  #logger: Logger;
  #account: string;
  #queue: QueuedRequest[] = [];
  #current: PendingRequest | undefined;
  #lastRequestStartedAt = 0;
  #draining = false;
  #kinkListCache: Promise<Map<number, KinkListEntry>> | undefined;

  constructor(connection: FChatConnection, outgoingQueue: OutgoingQueue, account: string, logger: Logger) {
    this.#connection = connection;
    this.#outgoingQueue = outgoingQueue;
    this.#account = account;
    this.#logger = logger;
    connection.on("event", (evt) => this.#handleEvent(evt));
  }

  getUserInfo(character: string): Promise<UserInfo> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ character, resolve, reject });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#current) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#current) {
        const next = this.#queue.shift()!;
        const wait = Math.max(0, MIN_GAP_MS - (Date.now() - this.#lastRequestStartedAt));
        if (wait > 0) await sleep(wait);
        this.#startRequest(next);
      }
    } finally {
      this.#draining = false;
    }
  }

  #startRequest(req: QueuedRequest): void {
    this.#lastRequestStartedAt = Date.now();
    this.#current = {
      character: req.character,
      resolve: req.resolve,
      reject: req.reject,
      profileTags: {},
      customKinks: [],
      stage: "profile",
      timeout: setTimeout(() => this.#failCurrent(new Error(`Timed out waiting for profile info on "${req.character}".`)), REQUEST_TIMEOUT_MS),
    };
    void this.#outgoingQueue.enqueueOther(() => this.#connection.send("PRO", { character: req.character }));
  }

  #handleEvent(evt: ServerEvent): void {
    const current = this.#current;
    if (!current) return;

    if (evt.code === "PRD" && current.stage === "profile") {
      if (evt.type === "info" || evt.type === "select") {
        if (evt.key !== undefined) current.profileTags[evt.key] = decodeHtmlEntities(evt.value ?? "");
      } else if (evt.type === "end") {
        current.stage = "kinks";
        void this.#outgoingQueue.enqueueOther(() => this.#connection.send("KIN", { character: current.character }));
      }
      return;
    }

    if (evt.code === "KID" && current.stage === "kinks") {
      if (evt.type === "custom") {
        // Confirmed against a live server: key = the custom kink's name, value = its
        // free-text description, one scalar string pair per event - despite the wiki
        // documenting these as "[int]" arrays, which is simply wrong.
        if (evt.key !== undefined && evt.value !== undefined) {
          current.customKinks.push({ name: decodeHtmlEntities(evt.key), description: decodeHtmlEntities(evt.value) });
        }
      } else if (evt.type === "end") {
        void this.#finishWithStandardKinks(current);
      }
      return;
    }

    if (evt.code === "ERR" && evt.number === 6) {
      // Character not found. PRD/KID responses don't correlate to a request, so this is a
      // best-effort heuristic: if we have a request in flight, assume it's the culprit.
      this.#failCurrent(new Error(`Character "${current.character}" was not found.`));
    }
  }

  /** Best-effort standard-kinks lookup via HTTP, layered on top of the already-complete profile+custom-kinks data. */
  async #finishWithStandardKinks(current: PendingRequest): Promise<void> {
    const standardKinks = await this.#tryFetchStandardKinks(current.character);
    // The request could theoretically have been failed out from under us (timeout) while
    // the HTTP call was in flight - only resolve if it's still the current one.
    if (this.#current !== current) return;
    this.#resolveCurrent(standardKinks);
  }

  async #tryFetchStandardKinks(character: string): Promise<ResolvedStandardKink[]> {
    const ticket = this.#connection.getCurrentTicket();
    if (!ticket) {
      this.#logger.debug("No ticket available yet - skipping standard-kinks lookup for this request");
      return [];
    }

    try {
      const [kinkList, ratings] = await Promise.all([this.#getKinkList(), this.#fetchRatings(character, ticket)]);
      if (ratings === null) {
        this.#logger.warn({ character }, "Standard-kinks HTTP lookup skipped - hourly rate limit reached");
        return [];
      }
      const resolved: ResolvedStandardKink[] = [];
      for (const r of ratings) {
        const entry = kinkList.get(r.kinkId);
        resolved.push({ kinkId: r.kinkId, name: entry?.name ?? `#${r.kinkId}`, rating: r.rating });
      }
      return resolved;
    } catch (err) {
      this.#logger.warn({ err, character }, "Standard-kinks HTTP lookup failed - continuing without them");
      return [];
    }
  }

  #fetchRatings(character: string, ticket: string): Promise<StandardKinkRating[] | null> {
    return fetchCharacterKinks(this.#account, ticket, character, (msg, meta) => this.#logger.debug(meta ?? {}, msg));
  }

  /** Site-wide kink dictionary - static data, fetched once and cached for the process lifetime. */
  #getKinkList(): Promise<Map<number, KinkListEntry>> {
    if (!this.#kinkListCache) {
      this.#kinkListCache = fetchKinkList((msg, meta) => this.#logger.debug(meta ?? {}, msg)).catch((err) => {
        this.#kinkListCache = undefined; // allow retrying on a later call rather than caching a permanent failure
        throw err;
      });
    }
    return this.#kinkListCache;
  }

  #resolveCurrent(standardKinks: ResolvedStandardKink[]): void {
    const current = this.#current;
    if (!current) return;
    clearTimeout(current.timeout);
    this.#current = undefined;
    current.resolve({ character: current.character, profileTags: current.profileTags, customKinks: current.customKinks, standardKinks });
    void this.#drain();
  }

  #failCurrent(err: Error): void {
    const current = this.#current;
    if (!current) return;
    clearTimeout(current.timeout);
    this.#current = undefined;
    this.#logger.warn({ err, character: current.character }, "User info request failed");
    current.reject(err);
    void this.#drain();
  }
}
