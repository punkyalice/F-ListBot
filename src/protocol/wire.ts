// Encodes/decodes the F-Chat wire format: a three-character uppercase command code,
// optionally followed by a space and a JSON payload. E.g. `MSG {"channel":"Frontpage"}`
// or a bare `PIN` with no payload at all (no trailing space).

export interface RawCommand {
  code: string;
  payload: unknown;
}

export function encode(code: string, payload?: object): string {
  if (payload === undefined) return code;
  return `${code} ${JSON.stringify(payload)}`;
}

/**
 * Decodes a raw inbound frame. Returns null (rather than throwing) on malformed input -
 * a bad frame from the server must never take the whole process down; callers should log
 * and drop it.
 */
export function decode(raw: string): RawCommand | null {
  if (raw.length < 3) return null;

  const spaceIndex = raw.indexOf(" ");
  const code = spaceIndex === -1 ? raw : raw.slice(0, spaceIndex);
  if (!/^[A-Z]{3}$/.test(code)) return null;

  if (spaceIndex === -1) {
    return { code, payload: undefined };
  }

  const jsonPart = raw.slice(spaceIndex + 1);
  try {
    return { code, payload: JSON.parse(jsonPart) };
  } catch {
    return null;
  }
}
