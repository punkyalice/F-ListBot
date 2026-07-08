import { EventEmitter } from "events";

/** Minimal typed wrapper around Node's EventEmitter - avoids pulling in a dependency for this. */
export class TypedEmitter<Events extends Record<string, unknown[]>> {
  #emitter = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): void {
    this.#emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): void {
    this.#emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): void {
    this.#emitter.emit(event, ...args);
  }
}
