const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/**
 * Decodes the small set of HTML entities F-List text fields commonly contain (profile
 * tags, custom kink descriptions arrive HTML-entity-encoded, e.g. `&quot;Hi!&quot;`).
 * Not a full HTML decoder - just named entities plus numeric (`&#39;`) and hex (`&#x27;`)
 * character references, which covers everything actually seen in practice here.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}
