import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from "fs";
import { readdir, unlink } from "fs/promises";
import { createInterface } from "readline";
import path from "path";
import { slugifyRoomForFilename } from "../protocol/roomCode";
import type { RoomStore } from "../store/roomStore";

interface TranscriptLine {
  ts: string;
  character: string;
  message: string;
  type: "msg" | "lrp";
}

export interface RoomLogEntry {
  /** The room's filesystem slug (see slugifyRoomForFilename) - identical to the room id for ADH- rooms, a sanitized approximation for official channel names. */
  room: string;
  date: string;
  ts: string;
  message: string;
  type: "msg" | "lrp";
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Per-room opt-in chat transcript logger (the !log on/off feature). Intentionally
 * separate from logger.ts's structured app logging - this writes raw JSON-lines chat
 * history, one file per room per UTC day, and only for rooms currently toggled on.
 */
export class RoomLogger {
  #dataDir: string;
  #roomStore: RoomStore;
  #activeRooms = new Set<string>();
  #streams = new Map<string, { stream: WriteStream; date: string }>();

  constructor(dataDir: string, roomStore: RoomStore) {
    this.#dataDir = dataDir;
    this.#roomStore = roomStore;
  }

  /** Called once at startup to resume logging for rooms that had it enabled before a restart. */
  restoreFromStore(rooms: string[]): void {
    for (const room of rooms) {
      if (this.#roomStore.isLoggingEnabled(room)) this.#activeRooms.add(room);
    }
  }

  isEnabled(room: string): boolean {
    return this.#activeRooms.has(room);
  }

  enable(room: string): void {
    this.#activeRooms.add(room);
  }

  disable(room: string): void {
    this.#activeRooms.delete(room);
    this.#closeStream(room);
  }

  record(room: string, character: string, message: string, type: "msg" | "lrp"): void {
    if (!this.#activeRooms.has(room)) return;
    const stream = this.#streamFor(room);
    const line: TranscriptLine = { ts: new Date().toISOString(), character, message, type };
    stream.write(JSON.stringify(line) + "\n");
  }

  closeAll(): void {
    for (const room of [...this.#streams.keys()]) this.#closeStream(room);
  }

  /**
   * !gdpr support: scans every persisted room transcript file for lines belonging to the
   * given character. Reads line-by-line via a stream (not loaded into memory as a whole)
   * to stay memory-friendly even for large log histories. Stops once `limit` matching
   * entries have been found and reports `truncated: true` in that case - a defensive cap
   * against pathological cases, not a normal-case limit.
   */
  async findEntriesForCharacter(character: string, limit: number): Promise<{ entries: RoomLogEntry[]; truncated: boolean }> {
    const roomsDir = path.join(this.#dataDir, "logs", "rooms");
    const entries: RoomLogEntry[] = [];

    for (const roomSlug of await listDirSafe(roomsDir)) {
      const roomDir = path.join(roomsDir, roomSlug);
      const files = (await listDirSafe(roomDir)).filter((f) => f.endsWith(".log")).sort();

      for (const file of files) {
        const date = file.replace(/\.log$/, "");
        const rl = createInterface({ input: createReadStream(path.join(roomDir, file), { encoding: "utf-8" }) });

        for await (const line of rl) {
          if (line.length === 0) continue;
          let parsed: Partial<TranscriptLine>;
          try {
            parsed = JSON.parse(line) as Partial<TranscriptLine>;
          } catch {
            continue;
          }
          if (parsed.character !== character) continue;

          entries.push({ room: roomSlug, date, ts: parsed.ts ?? "", message: parsed.message ?? "", type: parsed.type ?? "msg" });
          if (entries.length >= limit) {
            rl.close();
            return { entries, truncated: true };
          }
        }
      }
    }

    return { entries, truncated: false };
  }

  /**
   * Deletes room-log day-files older than `retentionDays` (measured from the file's date
   * in its name, UTC). Backs the global `!log limit` retention policy. Safe to call
   * regardless of whether any room is currently logging - only ever touches files that are
   * already closed (the currently-open file for a room is always today's, which by
   * definition is never older than any positive retention window).
   */
  async pruneOldLogs(retentionDays: number): Promise<{ deletedFiles: number }> {
    const roomsDir = path.join(this.#dataDir, "logs", "rooms");
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedFiles = 0;

    for (const roomSlug of await listDirSafe(roomsDir)) {
      const roomDir = path.join(roomsDir, roomSlug);
      const files = (await listDirSafe(roomDir)).filter((f) => f.endsWith(".log"));

      for (const file of files) {
        const dateStr = file.replace(/\.log$/, "");
        const fileDate = Date.parse(`${dateStr}T00:00:00Z`);
        if (Number.isNaN(fileDate) || fileDate >= cutoff) continue;

        try {
          await unlink(path.join(roomDir, file));
          deletedFiles++;
        } catch {
          // Best-effort - a file that's already gone or briefly locked isn't worth failing the whole sweep over.
        }
      }
    }

    return { deletedFiles };
  }

  #streamFor(room: string): WriteStream {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.#streams.get(room);
    if (existing && existing.date === today) return existing.stream;
    if (existing) existing.stream.end();

    const slug = slugifyRoomForFilename(room);
    const dir = path.join(this.#dataDir, "logs", "rooms", slug);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${today}.log`);
    const stream = createWriteStream(filePath, { flags: "a" });
    this.#streams.set(room, { stream, date: today });
    return stream;
  }

  #closeStream(room: string): void {
    const existing = this.#streams.get(room);
    if (existing) {
      existing.stream.end();
      this.#streams.delete(room);
    }
  }
}
