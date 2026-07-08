import type { FChatConnection } from "../../connection/FChatConnection";
import type { OutgoingQueue } from "../../connection/outgoingQueue";
import type { RoomStore } from "../../store/roomStore";
import { parseRoomCode } from "../../protocol/roomCode";
import { attemptJoin } from "../joinRoom";
import type { CommandDefinition } from "../types";

export function createJoinCommand(connection: FChatConnection, outgoingQueue: OutgoingQueue, roomStore: RoomStore, botCharacter: string): CommandDefinition {
  return {
    name: "join",
    level: "admin",
    description: "Makes the bot join a room. The room is remembered and rejoined automatically after a restart.",
    usage: "!join <room-code-or-name>",
    async handler(ctx) {
      const room = parseRoomCode(ctx.rawArgs);
      if (!room) {
        await ctx.reply(`Usage: !join <room-code-or-name>`);
        return;
      }
      const outcome = await attemptJoin(connection, outgoingQueue, room, botCharacter);
      if (outcome.ok) {
        roomStore.add(room);
        await ctx.reply(`Joined ${room}.`);
      } else {
        await ctx.reply(`Failed to join ${room}: ${outcome.message}`);
      }
    },
  };
}
