import type { Secret } from "../config/env";

export interface TicketResult {
  ticket: string;
}

interface RawTicketResponse {
  ticket?: string;
  error?: string;
}

/**
 * Fetches a short-lived auth ticket from F-List's ticket endpoint (verified against the
 * public python-flist reference client: POST account+password, get back a ticket used in
 * the IDN handshake). Tickets expire, so this is called once at startup and again before
 * every reconnect. The password is only ever read via `.reveal()` here, at the single
 * call site that legitimately needs the raw value.
 */
export async function getTicket(account: string, password: Secret): Promise<TicketResult> {
  const body = new URLSearchParams({
    account,
    password: password.reveal(),
    no_characters: "true",
    no_friends: "true",
    no_bookmarks: "true",
  });

  const response = await fetch("https://www.f-list.net/json/getApiTicket.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Ticket request failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as RawTicketResponse;
  if (data.error) {
    throw new Error(`Ticket request rejected: ${data.error}`);
  }
  if (!data.ticket) {
    throw new Error("Ticket request succeeded but no ticket was returned.");
  }

  return { ticket: data.ticket };
}
