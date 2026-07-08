# Writing a plugin

Each plugin is a folder under `plugins/` containing a `plugin.ts` (or `plugin.js` /
`index.ts` / `index.js`) entry file. The folder name **must match** the `id` your plugin
declares - the loader checks this and refuses to load a mismatch.

```
plugins/
  help/
    plugin.ts   <- entry file, see below
```

Three working examples to copy from, roughly in order of complexity:
- `plugins/dice/plugin.ts` - a single simple command (`!dice <X>d<Y>`), the smallest
  possible plugin. Start here if you just want to add one command.
- `plugins/help/plugin.ts` - multiple commands (`!help`, `!commands`, `!whois`) and the
  reference implementation for permission-aware output and `getUserInfo()`.
- `plugins/checkage/plugin.ts` - a persisted global setting, reacting to room-join events,
  and taking a moderation action. Start here if you need event hooks or config that
  survives a restart.

## The Plugin interface

```ts
interface Plugin {
  id: string;       // must match the folder name
  name: string;      // display name
  version: string;
  commands?: CommandDefinition[];
  onLoad?(api: BotAPI): Promise<void> | void;   // called once after load - set up timers, warm caches, etc.
  onUnload?(): Promise<void> | void;            // called before unload/reload - MUST clear anything onLoad set up (timers etc.)
}
```

Your entry file's default export must be either a `Plugin` object directly, or a factory
function `(api: BotAPI) => Plugin` - use the factory form whenever your commands need to
call the bot API (which is almost always), since it lets your command handlers close over
`api`.

## Commands

```ts
interface CommandDefinition {
  name: string;                 // matched against "!name", case-insensitive
  level: "everyone" | "mod" | "admin";
  requiredRoomContext?: boolean; // true if the command only makes sense inside a room (not PM)
  requiredPmContext?: boolean;   // true if the command must never reply into a public room (e.g. a privacy-sensitive data export)
  description: string;
  usage: string;
  handler: (ctx: CommandContext) => Promise<void>;
}
```

`level` is enforced by the bot before your handler ever runs - you don't need to check
permissions yourself for the command as a whole. `mod` means "admin, or a moderator of the
room the command was run in"; if you also need finer-grained checks inside a handler (e.g.
"only the target character or an admin/mod can view this"), use `api.isAdmin()` /
`api.isModerator()` explicitly. `requiredRoomContext` and `requiredPmContext` are mutually
exclusive - set at most one.

Command names share **one flat namespace** with the eleven core commands
(`!reload`, `!restart`, `!join`, `!leave`, `!log`, `!addadmin`, `!addmod`, `!deladmin`,
`!delmod`, `!settings`, `!gdpr`). If your plugin tries to register a name that collides with
a core command, or another plugin's command, loading fails loudly with an error - it will
never silently shadow an existing command.

## The BotAPI

```ts
interface BotAPI {
  sendRoomMessage(room: string, text: string): Promise<void>;
  sendPM(character: string, text: string): Promise<void>;
  sendRoomAd(room: string, text: string): Promise<void>;   // LRP - a chat ad, not a regular message
  getUserInfo(character: string): Promise<UserInfo>;       // profile tags + custom kinks (websocket) + standard kinks (HTTP), throttled automatically
  isAdmin(character: string): boolean;
  isModerator(character: string, room: string): boolean;
  getModeratedRooms(character: string): string[];          // every room this character moderates - handy when there's no current room (a PM)
  listCoreCommands(): CommandDefinition[];                  // core commands only
  listCommands(): CommandDefinition[];                      // core + every loaded plugin's commands - what !help actually uses
  getBotCharacter(): string;                                // the bot's own character name - use to ignore events about the bot itself
  onRoomEvent(event: "join" | "leave", callback: (room: string, character: string) => void): () => void;
  kickFromRoom(room: string, character: string): Promise<void>;
  storage: { getOwn, setOwn, get, set };
  log: { info, warn, error };
}
```

`plugins/help/plugin.ts`'s `!help` command is the reference implementation for permission-
aware, self-documenting output: it calls `listCommands()`, filters by `level` against
`isAdmin()`/`isModerator()`/`getModeratedRooms()`, and labels each command "anywhere",
"room only", or "PM only" from its `requiredRoomContext`/`requiredPmContext` flags. Worth
reading if you're adding commands of your own - they'll show up there automatically.
`!whois` in the same file is the reference implementation for `getUserInfo()`.

### `getUserInfo()` and kinks

```ts
interface UserInfo {
  character: string;
  profileTags: Record<string, string>;
  customKinks: { name: string; description: string }[];              // from the realtime KIN/KID command
  standardKinks: { kinkId: number; name: string; rating: string }[]; // from an HTTP API call, see below
}
```

F-Chat's realtime `KIN`/`KID` websocket command only ever returns a character's **custom**
(free-text) kinks - confirmed against the F-Chat server's own source (`event.KIN`'s handler
sends "Custom kinks of X" / "End of custom kinks." and nothing else) and against a live
server. Note the wiki documents each `KID` "custom" event's `key`/`value` as `[int]` (arrays
of numbers) - that's wrong; they're a single string pair per event (`key` = the custom
kink's name, `value` = its free-text description), which is what `customKinks` reflects.

Standard (master-list, checkbox) kinks aren't available through the chat protocol at all;
`getUserInfo()` fetches them separately via F-List's authenticated HTTP JSON API
(`character-data.php` + `kink-list.php` for name resolution - endpoint list and rules
confirmed against the official docs at
[wiki.f-list.net/Json_endpoints](https://wiki.f-list.net/Json_endpoints)), reusing the same
account+ticket already used for the websocket login - see `connection/flistHttpApi.ts`.
`character-data.php` also returns description/infotags/custom kinks, all ignored here since
those are already obtained more cheaply via the websocket `PRO`/`KIN` commands.

That API's documented usage policy ("Limit requests to one per second and character data
requests to less than 200 per hour") is enforced for the character-data.php calls
specifically via a sliding-hourly-window limiter in `flistHttpApi.ts` (capped at 180 for a
safety margin) - once exhausted, further standard-kinks lookups are skipped gracefully
(logged as a warning) until the window frees up again, rather than violating the policy.

That HTTP lookup is **best-effort**: `standardKinks` is an empty array if the call fails
(network issue, no ticket yet, rate limit reached, unexpected response shape) rather than
failing the whole `getUserInfo()` call - `profileTags` and `customKinks` are unaffected
either way. Both response shapes are confirmed against live data:
- `character-data.php`: `{ kinks: { "<kinkId>": "no"|"maybe"|"yes"|"fave", ... } }`.
- `kink-list.php`: `{ kinks: { "<groupId>": { group: "<name>", items: [{ kink_id, name,
  description }, ...] } } }` - **grouped by category**, not a flat `kinkId -> entry` map.
  Every top-level value under `kinks` is a *group*; the actual kinks are one level deeper,
  in each group's `items` array.

`character-data.php` also returns a `custom_kinks` field (name/description/**rating**/
related-kink-IDs per custom kink) - richer than `KIN`/`KID`, which has no rating for custom
kinks. Not currently used, since it would mean relying on the rate-limited HTTP call for
data the websocket already provides for free - a reasonable future enhancement if
per-custom-kink ratings become useful.

### Room events and moderation actions

`onRoomEvent("join" | "leave", callback)` subscribes to room membership changes across
**every** room the bot is in - it's not filtered by the (future) per-room plugin-activation
setting, and it fires for the bot's own joins/leaves too, so check
`character === api.getBotCharacter()` if you need to ignore those. It returns an
unsubscribe function - call it from `onUnload`, or `!reload` leaves a duplicate listener
registered every time. `plugins/checkage/plugin.ts` is the reference implementation.

`kickFromRoom(room, character)` sends `CKU`. This only works if F-List's own server
considers the bot's character a channel op (or owner) of that room - a permission system
entirely separate from this bot's admin/mod concept, and outside this bot's control. It
resolves once the command has been sent, not once confirmed - the protocol has no reliable
success/failure acknowledgement for `CKU`.

### Persisted global (non-per-user) settings

`storage.get`/`storage.set` always require an `owner` - for a setting that belongs to the
*plugin*, not any particular character, use a sentinel string that can never be a real
F-List character name (e.g. `"__yourplugin_config__"`) as the owner, consistently, and pass
`room: null`. `plugins/checkage/plugin.ts`'s `getMinAge`/`setMinAge` are the reference
implementation - note there's no `storage.delete`, so "unset" needs its own sentinel value
(checkage uses an empty string) that your read logic treats as "not configured".

### Storage and user data isolation

**Use `storage.getOwn(ctx, key)` / `storage.setOwn(ctx, key, value)` by default.** These are
always scoped to the character who ran the command (and the room, if any) - a user can
never read another user's data through them, by construction.

`storage.get(room, owner, key)` / `storage.set(...)` with an explicit `owner` exist for the
rare case where a plugin legitimately needs to touch another character's data (e.g. a
moderation command). **If you use these, you are responsible for checking
`api.isAdmin(ctx.senderCharacter)` or `api.isModerator(ctx.senderCharacter, ctx.room)`
before allowing the lookup.** The bot does not enforce this for you at this layer - only
the composite-key structure (a plugin can never accidentally list "all users' data") is
guaranteed automatically.

## Hot reload (`!reload`)

`!reload` (or `!reload <yourPluginId>`) unloads your plugin (calling `onUnload`), clears
Node's module cache for your plugin's files, re-`require`s your entry file, and calls
`onLoad` again - all without dropping the bot's connection to F-Chat. Implications:

- If `onLoad` starts anything persistent (a `setInterval`, an event subscription outside
  the command system), **you must tear it down in `onUnload`**, or it will leak a duplicate
  on every reload.
- Plugin files are plain TypeScript, transpiled on the fly (no type-checking at reload
  time - run `tsc --noEmit` yourself if you want type-safety guarantees before shipping a
  change).
- A plugin that throws while loading (syntax error, throwing `onLoad`) does not crash the
  bot - the error is reported back through `!reload`'s reply and the plugin is simply left
  unloaded.

## Room-specific activation (future)

Every plugin is active in all rooms by default. A future admin command will let you scope
a plugin to specific rooms (the underlying config already exists per-plugin); nothing
changes on your end for that to start working once it ships.
