import type { FChatConnection } from "../connection/FChatConnection";
import type { FloodLimits, OutgoingQueue } from "../connection/outgoingQueue";

/** Flood-control-aware send helpers, shared by the dispatcher's ctx.reply() and BotAPI. */
export class Messenger {
  #connection: FChatConnection;
  #queue: OutgoingQueue;

  constructor(connection: FChatConnection, queue: OutgoingQueue) {
    this.#connection = connection;
    this.#queue = queue;
  }

  async sendRoomMessage(room: string, text: string): Promise<void> {
    const limits = this.#queue.getLimits();
    await this.#queue.enqueue("message", text, limits.chatMaxBytes, () =>
      this.#connection.send("MSG", { channel: room, message: text })
    );
  }

  async sendPM(character: string, text: string): Promise<void> {
    const limits = this.#queue.getLimits();
    await this.#queue.enqueue("message", text, limits.privMaxBytes, () =>
      this.#connection.send("PRI", { recipient: character, message: text })
    );
  }

  async sendRoomAd(room: string, text: string): Promise<void> {
    const limits = this.#queue.getLimits();
    await this.#queue.enqueue("lrp", text, limits.lfrpMaxBytes, () =>
      this.#connection.send("LRP", { channel: room, message: text })
    );
  }

  /** Current flood-control limits (server-provided via VAR once known) - used to size chunked replies like !gdpr's export. */
  getLimits(): FloodLimits {
    return this.#queue.getLimits();
  }
}
