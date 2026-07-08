import type { FChatConnection } from "../connection/FChatConnection";
import type { OutgoingQueue } from "../connection/outgoingQueue";
import type { ServerEvent } from "../protocol/messages";

// Generous enough to tolerate a backlog in the "other" rate-limit bucket (e.g. several
// rooms queued for auto-rejoin, or an admin issuing multiple !join commands in quick
// succession, each ~1.1s apart) without a false "timed out" result while the JCH is still
// just queued, not yet sent.
const JOIN_CONFIRMATION_TIMEOUT_MS = 15_000;

export type JoinOutcome =
  | { ok: true }
  | { ok: false; message: string; permanent: boolean };

/**
 * Sends JCH (rate-limited via the "other" bucket - see outgoingQueue.ts) and waits for
 * either the bot's own JCH echo (success) or an ERR (failure) before the caller persists
 * or removes the room. Shared between the !join command and Bot.ts's auto-rejoin on
 * startup/reconnect - auto-rejoin used to fire-and-forget this with zero feedback, which
 * meant a room that had been deleted/lost server-side (e.g. a private room the server
 * destroyed for being empty) would silently fail to rejoin forever with nothing in the
 * logs to explain why.
 *
 * `permanent` on failure distinguishes "the room is genuinely gone/inaccessible" (channel
 * not found, banned, invite-only and not invited) from "ambiguous, could just be a slow
 * response" (timeout) - callers should only stop retrying/remove persisted state for
 * `permanent: true` failures.
 */
export function attemptJoin(connection: FChatConnection, outgoingQueue: OutgoingQueue, room: string, botCharacter: string): Promise<JoinOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    const onEvent = (evt: ServerEvent) => {
      if (settled) return;
      if (evt.code === "JCH" && evt.channel === room && evt.character?.identity === botCharacter) {
        settled = true;
        cleanup();
        resolve({ ok: true });
      } else if (evt.code === "ERR" && (evt.number === 26 || evt.number === 28 || evt.number === 44 || evt.number === 48)) {
        settled = true;
        cleanup();
        if (evt.number === 28) {
          resolve({ ok: true }); // already in the channel - treat as success
        } else {
          // 26 = channel not found, 44 = invite-only and not invited, 48 = banned - all permanent for this bot right now.
          resolve({ ok: false, message: evt.message, permanent: true });
        }
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, message: "Timed out waiting for the server to confirm the join.", permanent: false });
    }, JOIN_CONFIRMATION_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      connection.off("event", onEvent);
    }

    connection.on("event", onEvent);
    void outgoingQueue.enqueueOther(() => connection.send("JCH", { channel: room }));
  });
}
