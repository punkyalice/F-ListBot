import WebSocket from "ws";
import { encode, decode } from "../protocol/wire";
import { toServerEvent, type ServerEvent } from "../protocol/messages";
import { TypedEmitter } from "./typedEmitter";
import { getTicket } from "./ticketClient";
import { computeBackoffMs } from "../util/backoff";
import type { Secret } from "../config/env";
import type { Logger } from "../logging/logger";

const WS_URL = "wss://chat.f-list.net/chat2";
const IDLE_TIMEOUT_MS = 100_000; // safety margin past the spec'd ~90s/3-missed-ping disconnect
const IDENTIFY_TIMEOUT_MS = 15_000;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAILURE_THRESHOLD = 3;
// F-List's bot/client rules require staggering reconnect attempts with a 10-second
// minimum timeout. RECONNECT_BASE_MS is a hard floor (see backoff.ts - jitter only adds,
// never subtracts), and the cap keeps a persistently-failing connection from hammering
// the server more than once every 5 minutes.
const RECONNECT_BASE_MS = 10_000;
const RECONNECT_CAP_MS = 300_000;
// F-List's JSON API docs state tickets are valid for 30 minutes from issue. The websocket
// session itself doesn't need re-authentication after the initial IDN handshake succeeds,
// so it can (and does) stay open far longer than that - but getCurrentTicket() is also
// used for independent HTTP API calls (character-data.php etc, see flistHttpApi.ts), which
// would start failing with "Invalid ticket" after 30 minutes on a long-lived connection if
// nothing ever refreshed it. Refresh with a safety margin under the true expiry.
const TICKET_REFRESH_INTERVAL_MS = 25 * 60 * 1000;

export type FatalReason = "auth_failed" | "banned" | "kicked_elsewhere";

export interface ConnectionCredentials {
  account: string;
  password: Secret;
  character: string;
  clientName: string;
  clientVersion: string;
}

interface ConnectionEvents extends Record<string, unknown[]> {
  event: [ServerEvent];
  disconnected: [];
  reconnecting: [attempt: number, waitMs: number];
  reconnected: [];
  fatal: [reason: FatalReason, message: string];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the F-Chat websocket's full lifecycle: connecting, the IDN handshake, replying to
 * server-driven PIN keepalives (and only ever replying - see #handleFrame), idle
 * detection, and reconnect-with-backoff. Auth-fatal server errors (bad credentials,
 * banned, kicked for logging in elsewhere) get a crash-loop guard: after
 * AUTH_FAILURE_THRESHOLD occurrences within AUTH_FAILURE_WINDOW_MS, this stops
 * reconnecting entirely and emits 'fatal' instead of hammering F-List's server with
 * doomed retries.
 */
export class FChatConnection extends TypedEmitter<ConnectionEvents> {
  #credentials: ConnectionCredentials;
  #logger: Logger;
  #ws: WebSocket | undefined;
  #lastActivityAt = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #ticketRefreshTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #deliberateClose = false;
  #authFailureTimestamps: number[] = [];
  #identified = false;
  #currentTicket: string | undefined;

  constructor(credentials: ConnectionCredentials, logger: Logger) {
    super();
    this.#credentials = credentials;
    this.#logger = logger;
  }

  /** Connects and identifies, retrying with backoff on failure until success or a fatal auth condition is hit. */
  async connect(): Promise<void> {
    this.#deliberateClose = false;
    await this.#connectWithRetry();
  }

  async #connectWithRetry(): Promise<void> {
    for (;;) {
      try {
        await this.#openSocket();
        this.#reconnectAttempt = 0;
        this.#startIdleWatch();
        this.#startTicketRefresh();
        return;
      } catch (err) {
        if (this.#deliberateClose) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        const attempt = this.#reconnectAttempt++;
        const waitMs = computeBackoffMs(attempt, RECONNECT_BASE_MS, RECONNECT_CAP_MS);
        this.#logger.warn({ err, attempt, waitMs }, "F-Chat connection attempt failed, backing off before retry");
        this.emit("reconnecting", attempt, waitMs);
        await sleep(waitMs);
      }
    }
  }

  async #openSocket(): Promise<void> {
    const { ticket } = await getTicket(this.#credentials.account, this.#credentials.password);
    this.#currentTicket = ticket;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.#ws = ws;
      this.#identified = false;
      let settled = false;

      const identifyTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new Error("Timed out waiting for IDN confirmation from server."));
        }
      }, IDENTIFY_TIMEOUT_MS);

      ws.on("open", () => {
        this.#touchActivity();
        this.#sendRaw("IDN", {
          method: "ticket",
          account: this.#credentials.account,
          ticket,
          character: this.#credentials.character,
          cname: this.#credentials.clientName,
          cversion: this.#credentials.clientVersion,
        });
      });

      ws.on("message", (data) => {
        this.#touchActivity();
        this.#handleFrame(Buffer.isBuffer(data) ? data.toString("utf-8") : String(data));
        if (!settled && this.#identified) {
          settled = true;
          clearTimeout(identifyTimeout);
          resolve();
        }
      });

      ws.on("close", () => {
        clearTimeout(identifyTimeout);
        this.#stopIdleWatch();
        if (!settled) {
          settled = true;
          reject(new Error("Connection closed before identification completed."));
          return;
        }
        // Was fully identified and running - this is an unexpected mid-session drop.
        this.emit("disconnected");
        if (!this.#deliberateClose) {
          this.#connectWithRetry()
            .then(() => this.emit("reconnected"))
            .catch((err) => {
              this.#logger.error({ err }, "Gave up reconnecting to F-Chat");
            });
        }
      });

      ws.on("error", (err: Error) => {
        this.#logger.warn({ err }, "F-Chat websocket error");
      });
    });
  }

  #handleFrame(raw: string): void {
    const decoded = decode(raw);
    if (!decoded) {
      this.#logger.warn({ raw }, "Dropped malformed frame from server");
      return;
    }

    if (decoded.code === "PIN") {
      // Only ever reply here - never expose a way to send PIN from elsewhere. Sending an
      // unsolicited PIN (or replying more than once per ~10s) gets the client disconnected.
      this.#sendRaw("PIN");
      return;
    }

    const event = toServerEvent(decoded);
    if (!event) {
      this.#logger.debug({ code: decoded.code }, "Unrecognized or malformed server command, ignoring");
      return;
    }

    if (event.code === "IDN") {
      this.#identified = true;
    }

    if (event.code === "ERR") {
      this.#handlePotentialAuthFatal(event.number, event.message);
    }

    this.emit("event", event);
  }

  #handlePotentialAuthFatal(errorNumber: number, message: string): void {
    let reason: FatalReason | undefined;
    if (errorNumber === 4) reason = "auth_failed";
    else if (errorNumber === 9) reason = "banned";
    else if (errorNumber === 31) reason = "kicked_elsewhere";
    if (!reason) return;

    const now = Date.now();
    this.#authFailureTimestamps.push(now);
    this.#authFailureTimestamps = this.#authFailureTimestamps.filter((t) => now - t < AUTH_FAILURE_WINDOW_MS);

    if (this.#authFailureTimestamps.length >= AUTH_FAILURE_THRESHOLD) {
      this.#deliberateClose = true; // stop the retry loop from continuing after this
      this.emit("fatal", reason, message);
    }
  }

  /** Sends a command directly, bypassing flood-control queuing (used for JCH/LCH/PRO/KIN etc, which aren't flood-limited). */
  send(code: string, payload?: object): void {
    this.#sendRaw(code, payload);
  }

  /**
   * The account+ticket pair currently used for the websocket login is also valid for
   * F-List's authenticated HTTP JSON API (e.g. character-data.php) - exposed here so
   * other components (UserInfoClient) can reuse it instead of fetching a second ticket.
   * Undefined until the first successful connection.
   */
  getCurrentTicket(): string | undefined {
    return this.#currentTicket;
  }

  #sendRaw(code: string, payload?: object): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      this.#logger.warn({ code }, "Dropped outgoing command - socket not open");
      return;
    }
    this.#ws.send(encode(code, payload));
  }

  async close(): Promise<void> {
    this.#deliberateClose = true;
    this.#stopIdleWatch();
    this.#stopTicketRefresh();
    const ws = this.#ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        ws.once("close", done);
        ws.close();
        setTimeout(done, 3000); // don't hang shutdown forever on a stuck close
      });
    }
  }

  #touchActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  #startIdleWatch(): void {
    this.#stopIdleWatch();
    this.#idleTimer = setInterval(() => {
      if (Date.now() - this.#lastActivityAt > IDLE_TIMEOUT_MS) {
        this.#logger.warn("No server activity within idle timeout - assuming dead connection, forcing reconnect");
        this.#ws?.terminate();
      }
    }, 10_000);
  }

  #stopIdleWatch(): void {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #startTicketRefresh(): void {
    this.#stopTicketRefresh();
    this.#ticketRefreshTimer = setInterval(() => {
      void getTicket(this.#credentials.account, this.#credentials.password)
        .then((result) => {
          this.#currentTicket = result.ticket;
          this.#logger.debug("Refreshed HTTP API ticket");
        })
        .catch((err) => {
          // Not fatal - the websocket session is unaffected. HTTP API calls will just keep
          // failing with the stale ticket until the next successful refresh.
          this.#logger.warn({ err }, "Failed to refresh HTTP API ticket - will retry on the next interval");
        });
    }, TICKET_REFRESH_INTERVAL_MS);
  }

  #stopTicketRefresh(): void {
    if (this.#ticketRefreshTimer) {
      clearInterval(this.#ticketRefreshTimer);
      this.#ticketRefreshTimer = undefined;
    }
  }
}
