import path from "path";
import type { Config } from "../config/env";
import { parseBootstrap } from "../config/bootstrap";
import { createLogger, type Logger } from "../logging/logger";
import { openDb } from "../store/db";
import { AdminStore } from "../store/adminStore";
import { RoomStore } from "../store/roomStore";
import { PluginConfigStore } from "../store/pluginConfigStore";
import { KvStore } from "../store/kvStore";
import { BotSettingsStore } from "../store/botSettingsStore";
import { FChatConnection } from "../connection/FChatConnection";
import { OutgoingQueue } from "../connection/outgoingQueue";
import { Messenger } from "./messenger";
import { UserInfoClient } from "../userinfo/UserInfoClient";
import { RoomLogger } from "../logging/roomLogger";
import { CommandRegistry } from "./commandRegistry";
import { Permissions } from "./permissions";
import { Dispatcher } from "./dispatcher";
import { PluginManager } from "../plugins/PluginManager";
import type { BotAPI } from "../plugins/types";
import { createJoinCommand } from "./commands/join";
import { createLeaveCommand } from "./commands/leave";
import { createLogCommand } from "./commands/log";
import { createAddAdminCommand } from "./commands/addadmin";
import { createAddModCommand } from "./commands/addmod";
import { createDelAdminCommand } from "./commands/deladmin";
import { createDelModCommand } from "./commands/delmod";
import { createReloadCommand } from "./commands/reload";
import { createRestartCommand } from "./commands/restart";
import { createSettingsCommand } from "./commands/settings";
import { createGdprCommand } from "./commands/gdpr";
import { attemptJoin } from "./joinRoom";

export const EXIT_CLEAN = 0;
export const EXIT_RESTART = 75;
export const EXIT_AUTH_FATAL = 78;

// Once a day is plenty for a retention sweep measured in whole days - no need for finer granularity.
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type ShutdownMode = "restart" | "auth_fatal" | "clean";

/**
 * Top-level orchestrator wiring the connection, dispatcher, plugin manager, and stores
 * together. See README.md / the plan document for the full startup sequence this
 * implements.
 */
export class Bot {
  #config: Config;
  #logger: Logger;
  #db: ReturnType<typeof openDb>;
  #adminStore: AdminStore;
  #roomStore: RoomStore;
  #pluginConfigStore: PluginConfigStore;
  #kvStore: KvStore;
  #botSettingsStore: BotSettingsStore;
  #connection: FChatConnection;
  #outgoingQueue: OutgoingQueue;
  #messenger: Messenger;
  #userInfoClient: UserInfoClient;
  #roomLogger: RoomLogger;
  #registry: CommandRegistry;
  #permissions: Permissions;
  #dispatcher: Dispatcher;
  #pluginManager: PluginManager;
  #shuttingDown = false;

  constructor(config: Config) {
    this.#config = config;
    this.#logger = createLogger(config.logLevel);

    const bootstrap = parseBootstrap(config);

    // Resolved once, to an absolute path, and used for both the DB and the room logger -
    // a relative DATA_DIR would otherwise depend on process.cwd() at startup, which can
    // silently differ between `npm run dev`, `npm start`, and however a process manager
    // invokes the built output, pointing at a different (often empty) data directory.
    const dataDir = path.resolve(config.dataDir);
    this.#logger.info({ dataDir }, "Using data directory");

    this.#db = openDb(dataDir);
    this.#adminStore = new AdminStore(this.#db, bootstrap);
    this.#roomStore = new RoomStore(this.#db);
    this.#pluginConfigStore = new PluginConfigStore(this.#db);
    this.#kvStore = new KvStore(this.#db);
    this.#botSettingsStore = new BotSettingsStore(this.#db);

    this.#connection = new FChatConnection(
      {
        account: config.account,
        password: config.password,
        character: config.character,
        clientName: config.clientName,
        clientVersion: config.clientVersion,
      },
      this.#logger
    );

    this.#outgoingQueue = new OutgoingQueue();
    this.#messenger = new Messenger(this.#connection, this.#outgoingQueue);
    this.#userInfoClient = new UserInfoClient(this.#connection, this.#outgoingQueue, config.account, this.#logger);
    this.#roomLogger = new RoomLogger(dataDir, this.#roomStore);

    this.#registry = new CommandRegistry();
    this.#permissions = new Permissions(this.#adminStore);
    this.#dispatcher = new Dispatcher(
      this.#connection,
      this.#registry,
      this.#permissions,
      this.#pluginConfigStore,
      this.#messenger,
      this.#logger,
      config.character
    );

    const pluginDir = path.resolve(config.pluginDir);
    this.#logger.info({ pluginDir }, "Using plugin directory");
    this.#pluginManager = new PluginManager(pluginDir, this.#registry, (pluginId) => this.#makeApi(pluginId), this.#logger);

    this.#registerCoreCommands();
    this.#wireConnectionEvents();
    this.#startRetentionSweep();
  }

  async start(): Promise<void> {
    this.#logger.info("Connecting to F-Chat...");
    await this.#connection.connect();
    this.#logger.info({ character: this.#config.character }, "Identified with F-Chat");

    await this.#settle();

    const rooms = this.#roomStore.listAutoRejoin();
    this.#roomLogger.restoreFromStore(rooms.map((r) => r.room));
    if (rooms.length > 0) {
      this.#logger.info({ count: rooms.length, rooms: rooms.map((r) => r.room) }, "Auto-rejoining persisted rooms");
    }
    // Fire-and-forget: the "other" bucket's drain loop staggers the underlying JCH sends
    // at otherIntervalMs regardless of whether we await here, and awaiting would block
    // plugin loading behind however many rooms need rejoining. #rejoinRoom logs its own
    // outcome per room, so failures are never silent (see joinRoom.ts's doc comment for
    // why that matters - a room the server destroyed for being empty would otherwise fail
    // to rejoin forever with no trace of why).
    for (const r of rooms) {
      void this.#rejoinRoom(r.room);
    }

    const results = await this.#pluginManager.scanAndLoadAll();
    for (const r of results) {
      if (r.success) this.#logger.info({ pluginId: r.pluginId }, "Plugin loaded");
      else this.#logger.error({ pluginId: r.pluginId, error: r.error }, "Plugin failed to load");
    }

    this.#logger.info("Bot ready.");
  }

  async shutdown(mode: ShutdownMode): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#logger.info({ mode }, "Shutting down");
    this.#roomLogger.closeAll();
    await this.#connection.close();
    const code = mode === "restart" ? EXIT_RESTART : mode === "auth_fatal" ? EXIT_AUTH_FATAL : EXIT_CLEAN;
    process.exit(code);
  }

  /** Practical startup-readiness signal: resolves after 2s of inbound quiet following IDN, capped at 10s total. */
  async #settle(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let quietTimer: NodeJS.Timeout;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(ceiling);
        this.#connection.off("event", onEvent);
        resolve();
      };
      const onEvent = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 2000);
      };

      quietTimer = setTimeout(finish, 2000);
      const ceiling = setTimeout(finish, 10_000);
      this.#connection.on("event", onEvent);
    });
  }

  #wireConnectionEvents(): void {
    this.#connection.on("event", (evt) => {
      if (evt.code === "VAR") {
        this.#applyVar(evt.variable, evt.value);
      } else if (evt.code === "MSG") {
        this.#roomLogger.record(evt.channel, evt.character, evt.message, "msg");
      } else if (evt.code === "LRP") {
        this.#roomLogger.record(evt.channel, evt.character, evt.message, "lrp");
      }
    });

    this.#connection.on("fatal", (reason, message) => {
      this.#logger.error({ reason, message }, "Fatal connection error - giving up and exiting rather than crash-looping");
      void this.shutdown("auth_fatal");
    });

    this.#connection.on("reconnecting", (attempt, waitMs) => {
      this.#logger.warn({ attempt, waitMs }, "Reconnecting to F-Chat");
    });

    this.#connection.on("disconnected", () => {
      this.#logger.warn("Disconnected from F-Chat");
    });

    this.#connection.on("reconnected", () => {
      const rooms = this.#roomStore.listAutoRejoin();
      this.#logger.info({ count: rooms.length, rooms: rooms.map((r) => r.room) }, "Reconnected to F-Chat - rejoining rooms");
      for (const r of rooms) {
        void this.#rejoinRoom(r.room);
      }
    });
  }

  /** Joins a persisted room with full success/failure logging - see joinRoom.ts's doc comment for why this matters over a bare fire-and-forget JCH. */
  async #rejoinRoom(room: string): Promise<void> {
    const outcome = await attemptJoin(this.#connection, this.#outgoingQueue, room, this.#config.character);
    if (outcome.ok) {
      this.#logger.info({ room }, "Rejoined room");
      return;
    }
    this.#logger.warn({ room, message: outcome.message, permanent: outcome.permanent }, "Failed to rejoin room");
    if (outcome.permanent) {
      this.#roomStore.remove(room);
      this.#logger.warn({ room }, "Room appears to no longer exist or be accessible - removed from auto-rejoin list");
    }
  }

  /** Enforces the global `!log limit` retention window (if any) by deleting old room-log day-files, once at startup and then daily. Picks up changes to the limit on its next run without needing a restart. */
  #startRetentionSweep(): void {
    const run = async () => {
      const retentionDays = this.#botSettingsStore.getLogRetentionDays();
      if (retentionDays === null) return;
      try {
        const { deletedFiles } = await this.#roomLogger.pruneOldLogs(retentionDays);
        if (deletedFiles > 0) this.#logger.info({ deletedFiles, retentionDays }, "Pruned old room log files");
      } catch (err) {
        this.#logger.warn({ err }, "Failed to prune old room log files");
      }
    };
    void run();
    setInterval(() => void run(), RETENTION_SWEEP_INTERVAL_MS);
  }

  #applyVar(variable: string, value: number | string | string[]): void {
    if (typeof value !== "number") return;
    switch (variable) {
      case "chat_max":
        this.#outgoingQueue.updateLimits({ chatMaxBytes: value });
        break;
      case "priv_max":
        this.#outgoingQueue.updateLimits({ privMaxBytes: value });
        break;
      case "lfrp_max":
        this.#outgoingQueue.updateLimits({ lfrpMaxBytes: value });
        break;
      case "msg_flood":
        this.#outgoingQueue.updateLimits({ msgIntervalMs: Math.ceil(value * 1000) + 100 });
        break;
      case "lfrp_flood":
        this.#outgoingQueue.updateLimits({ lrpIntervalMs: Math.ceil(value * 1000) + 100 });
        break;
    }
  }

  #registerCoreCommands(): void {
    this.#registry.registerCore(createJoinCommand(this.#connection, this.#outgoingQueue, this.#roomStore, this.#config.character));
    this.#registry.registerCore(createLeaveCommand(this.#connection, this.#outgoingQueue, this.#roomStore));
    this.#registry.registerCore(createLogCommand(this.#roomLogger, this.#roomStore, this.#adminStore, this.#botSettingsStore));
    this.#registry.registerCore(createAddAdminCommand(this.#adminStore));
    this.#registry.registerCore(createAddModCommand(this.#adminStore));
    this.#registry.registerCore(createDelAdminCommand(this.#adminStore));
    this.#registry.registerCore(createDelModCommand(this.#adminStore));
    this.#registry.registerCore(createReloadCommand(this.#pluginManager));
    this.#registry.registerCore(createRestartCommand(() => void this.shutdown("restart")));
    this.#registry.registerCore(createSettingsCommand(this.#pluginManager, this.#pluginConfigStore, this.#roomStore, this.#botSettingsStore));
    this.#registry.registerCore(createGdprCommand(this.#adminStore, this.#kvStore, this.#roomLogger, this.#botSettingsStore, this.#messenger));
  }

  #makeApi(pluginId: string): BotAPI {
    return {
      sendRoomMessage: (room, text) => this.#messenger.sendRoomMessage(room, text),
      sendPM: (character, text) => this.#messenger.sendPM(character, text),
      sendRoomAd: (room, text) => this.#messenger.sendRoomAd(room, text),
      getUserInfo: (character) => this.#userInfoClient.getUserInfo(character),
      isAdmin: (character) => this.#permissions.isAdmin(character),
      isModerator: (character, room) => this.#permissions.isModerator(character, room),
      getModeratedRooms: (character) => this.#adminStore.listRoomsModeratedBy(character).map((m) => m.room),
      listCoreCommands: () => this.#registry.listCore(),
      listCommands: () => this.#registry.list(),
      storage: {
        getOwn: (ctx, key) => this.#kvStore.get(pluginId, ctx.room ?? null, ctx.senderCharacter, key),
        setOwn: (ctx, key, value) => this.#kvStore.set(pluginId, ctx.room ?? null, ctx.senderCharacter, key, value),
        get: (room, owner, key) => this.#kvStore.get(pluginId, room, owner, key),
        set: (room, owner, key, value) => this.#kvStore.set(pluginId, room, owner, key, value),
      },
      log: {
        info: (msg, meta) => this.#logger.info({ plugin: pluginId, ...meta }, msg),
        warn: (msg, meta) => this.#logger.warn({ plugin: pluginId, ...meta }, msg),
        error: (msg, meta) => this.#logger.error({ plugin: pluginId, ...meta }, msg),
      },
    };
  }
}
