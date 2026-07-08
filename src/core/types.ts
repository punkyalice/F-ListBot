export type PermLevel = "everyone" | "mod" | "admin";

export interface CommandContext {
  source: "room" | "pm";
  /** Canonical room identifier, present iff source === "room". */
  room?: string;
  senderCharacter: string;
  rawArgs: string;
  /** Replies in the same context the command was invoked from: MSG if room, PRI if PM. */
  reply(text: string): Promise<void>;
}

export interface CommandDefinition {
  /** Matched against "!name" (case-insensitive), without the leading "!". */
  name: string;
  level: PermLevel;
  /** If true, the dispatcher rejects PM invocations with a clear error before the handler ever runs. */
  requiredRoomContext?: boolean;
  /** If true, the dispatcher rejects room invocations with a clear error before the handler ever runs - use for privacy-sensitive commands that must never reply into a public room. */
  requiredPmContext?: boolean;
  description: string;
  usage: string;
  handler: (ctx: CommandContext) => Promise<void>;
}
