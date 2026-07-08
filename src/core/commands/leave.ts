import type { FChatConnection } from "../../connection/FChatConnection";
import type { OutgoingQueue } from "../../connection/outgoingQueue";
import type { RoomStore } from "../../store/roomStore";
import type { CommandDefinition } from "../types";

export function createLeaveCommand(connection: FChatConnection, outgoingQueue: OutgoingQueue, roomStore: RoomStore): CommandDefinition {
  return {
    name: "leave",
    level: "mod",
    requiredRoomContext: true,
    description: "Makes the bot leave the current room and stop auto-rejoining it.",
    usage: "!leave",
    async handler(ctx) {
      const room = ctx.room!; // dispatcher guarantees this via requiredRoomContext
      await outgoingQueue.enqueueOther(() => connection.send("LCH", { channel: room }));
      roomStore.remove(room);
      await ctx.reply(`Left ${room}.`);
    },
  };
}
