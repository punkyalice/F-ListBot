export class BotError extends Error {}

/** Thrown by the dispatcher when a sender lacks the required permission level for a command. */
export class PermissionError extends BotError {
  constructor(message = "You don't have permission to use that command.") {
    super(message);
  }
}

/** Thrown when a command requiring a room (e.g. !log, !addmod, !leave) is invoked via PM. */
export class RoomContextRequiredError extends BotError {
  constructor(commandName: string) {
    super(`!${commandName} can only be used inside a room, not in a private message.`);
  }
}

/** Thrown when a privacy-sensitive command (e.g. !gdpr) is invoked inside a room instead of via PM. */
export class PmContextRequiredError extends BotError {
  constructor(commandName: string) {
    super(`!${commandName} can only be used via private message, not inside a room.`);
  }
}

/** Thrown by outgoingQueue when a payload exceeds the server's byte limit for its class. */
export class MessageTooLongError extends BotError {
  constructor(maxBytes: number) {
    super(`Message exceeds the maximum length of ${maxBytes} bytes.`);
  }
}
