import type { AdminStore } from "../store/adminStore";
import type { PermLevel } from "./types";

/** everyone < mod < admin. Admins implicitly hold moderator rights in every room (enforced inside AdminStore.isRoomMod). */
export class Permissions {
  #store: AdminStore;

  constructor(store: AdminStore) {
    this.#store = store;
  }

  isAdmin(character: string): boolean {
    return this.#store.isAdmin(character);
  }

  isModerator(character: string, room: string): boolean {
    return this.#store.isRoomMod(room, character);
  }

  check(level: PermLevel, character: string, room?: string): boolean {
    if (level === "everyone") return true;
    if (level === "admin") return this.isAdmin(character);
    // level === "mod"
    if (room === undefined) return this.isAdmin(character);
    return this.isModerator(character, room);
  }
}
