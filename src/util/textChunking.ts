/** Splits text on line boundaries into chunks that each fit under maxBytes (UTF-8), for sending as multiple chat messages. */
export function chunkText(text: string, maxBytes: number): string[] {
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
