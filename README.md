# FChatBot

An F-Chat (f-list.net) bot with a hot-reloadable plugin system, room and private-message
command handling, and chat-driven administration.

## Requirements

- Node.js 18 or newer.
- A process supervisor for production use: **pm2**, **systemd**, or a Docker restart
  policy. The bot does **not** daemonize or respawn itself. `!restart` (and any crash)
  cleanly exits the process with a distinct exit code - something else must bring it
  back up. See "Exit codes" below.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set FLIST_ACCOUNT, FLIST_PASSWORD, FLIST_CHARACTER, BOOTSTRAP_ADMINS
npm run build
npm start
```

For development (auto-restarts the *main process* on src/ changes - unrelated to plugin
hot-reload, which happens via `!reload` while the process is running):

```bash
npm run dev
```

## Running with pm2

[pm2](https://pm2.keymetrics.io/) keeps the bot running, restarts it automatically
(including after `!restart` or a crash), and manages logs - this is the recommended way to
run the bot in production. Commands below assume the process name `fchatbot`; use whatever
name you prefer as long as you're consistent.

**Install pm2:**
```bash
npm install -g pm2
```

**Build and start the bot:**
```bash
npm run build
pm2 start dist/index.js --name fchatbot
```

**Save the process list**, so pm2 knows to bring it back after a reboot:
```bash
pm2 save
```

**Enable autostart on boot** (one-time per server - pm2 prints a command, usually needing
`sudo`, that you then run yourself):
```bash
pm2 startup
```

**View logs:**
```bash
pm2 logs fchatbot              # live tail
pm2 logs fchatbot --lines 200  # last 200 lines
```

**Restart or stop:**
```bash
pm2 restart fchatbot   # manual restart (also happens automatically after !restart or a crash)
pm2 stop fchatbot      # stop, keep it in pm2's process list
pm2 delete fchatbot    # remove from pm2 entirely
```

**After pulling code changes:**
```bash
npm run build
pm2 restart fchatbot
```

## Configuration (`.env`)

See `.env.example` for the full list. The important ones:

F-List accounts and characters are separate things - one account (a login with a
username/password) can own several characters, and you can roleplay as any of them. The
bot needs both pieces: the **account** to authenticate, and which **character** on that
account it should act as.

- `FLIST_ACCOUNT` / `FLIST_PASSWORD` - the account login used once at startup (and again on
  every reconnect) to fetch a short-lived auth ticket. Never logged, never exposed via any
  chat command.
- `FLIST_CHARACTER` - which of that account's characters the bot logs in and speaks as.
  Sent separately from the account in the login handshake. Give the bot its own dedicated
  character rather than reusing one you roleplay on yourself.
- `BOOTSTRAP_ADMINS` - comma-separated character names that are always bot admins,
  regardless of the database. This is your recovery mechanism: even if `data/bot.sqlite3`
  is lost or corrupted, you can never be locked out of administering the bot.
- `BOOTSTRAP_MODS` - comma-separated `room:character` pairs for room-scoped moderators at
  startup (room can be a raw `ADH-...` code or pasted as `[session=Title]adh-...[/session]`).

Admins/mods added later via `!addadmin` / `!addmod` are written to the SQLite database and
persist across restarts; they add to (never replace or remove) the bootstrap list.

## Chat commands

| Command | Who | Where | Effect |
|---|---|---|---|
| `!reload [pluginId]` | admin | anywhere | Hot-reloads plugin(s) without dropping the connection |
| `!restart` | admin | anywhere | Clean shutdown, process exits - supervisor must restart it |
| `!join <room>` | admin | anywhere | Joins a room, persists it for auto-rejoin after restart |
| `!leave` | mod | in a room | Leaves the current room, removes it from auto-rejoin |
| `!log on\|off` | mod | in a room | Toggles a chat transcript log for the current room |
| `!addadmin <character>` | admin | anywhere | Grants global admin rights |
| `!addmod <character>` | admin | in a room | Grants moderator rights scoped to the current room |
| `!deladmin <character>` | admin | anywhere | Revokes global admin rights (cannot remove BOOTSTRAP_ADMINS) |
| `!delmod <character>` | admin | in a room | Revokes moderator rights for the current room (cannot remove BOOTSTRAP_MODS) |
| `!settings [room]` | everyone | anywhere | Shows a room's active plugins and logging status. Room defaults to the current room; required as an argument via PM |
| `!gdpr` | everyone | **PM only** | Shows every piece of data stored about you (admin/mod status, plugin data, chat log entries) - always your own character, never anyone else's |
| `!help` / `!commands` | everyone | anywhere | Explains every command, filtered to what the asker can actually use (example plugin) |
| `!whois <character>` | everyone | anywhere | Looks up a character's profile (example plugin) |

Unknown `!`-prefixed text is silently ignored (so it doesn't misfire on ordinary
roleplay text that happens to start with `!`).

### Kinks in `!whois`

F-Chat's realtime `KIN` command only returns a character's *custom* kinks; standard
(master-list) kinks are fetched separately via F-List's HTTP API. Both are shown in
`!whois`. If a lookup ever looks wrong, set `LOG_LEVEL=debug` in `.env` and check the logs
for the raw API response - see `plugins/README.md`'s "getUserInfo() and kinks" section for
details.

## Exit codes

`!restart` and internal failure paths exit with distinct codes so a supervisor can react
appropriately:

- `0` - clean exit, not requesting a restart.
- `75` - `!restart` was invoked; always restart.
- `78` - authentication is broken (bad credentials, banned, or logged in elsewhere too
  often in a short window); restarting immediately will not help - back off or page a
  human instead of crash-looping against F-List's server.
- any other non-zero code - unexpected crash; restart with normal backoff.

## Plugins

See `plugins/README.md` for how to write a plugin. The `plugins/help` plugin is a working
example (`!help`, `!commands`, `!whois`).

## Data & logs

- `data/bot.sqlite3` - admins, room moderators, auto-rejoin room list, per-plugin config,
  and plugin key/value storage. Gitignored; back it up if you care about persisted state
  beyond your `.env` bootstrap list.
- `data/logs/rooms/<room>/<date>.log` - opt-in per-room chat transcripts (`!log on`).

## Testing against F-Chat

Test against the F-Chat **test server** if you have access (request one via an F-List
helpdesk ticket per the protocol docs) rather than the live server. If you don't have test
server access, use a secondary account/character on the live server and be mindful of
F-Chat's flood limits.

## F-List bot/client rules compliance

F-List's [Bot Requirements](https://wiki.f-list.net/Developer_Policy#Bot_Requirements) and
general client requirements impose obligations beyond what any codebase can enforce on its
own. What's handled in code, and what's on you as the operator:

**Handled in code:**
- Client identifies itself with a distinct name/version (`CLIENT_NAME`/`CLIENT_VERSION` in
  `.env`, sent in the `IDN` handshake) - never claims to be an official client.
- Reconnect attempts are staggered with a hard 10-second-minimum, exponentially backing off
  to 5 minutes on repeated failures (`connection/FChatConnection.ts` - `RECONNECT_BASE_MS`).
- All outbound server commands are rate-limited to at most ~1/second, including ones the
  protocol itself doesn't document explicit flood errors for (`JCH`, `LCH`, `PRO`, `KIN`) -
  see the `"other"` bucket in `connection/outgoingQueue.ts`.
- The bot never sends a PM, friend request, or channel invite unless it's a direct reply to
  something the user did first (a command they sent, in a room or via PM) - there is no
  code path that proactively messages a user.
- The bot never sets the `STA` (status) command at all, so it can't accidentally end up
  with a "looking" status - if you build a plugin that adds status control, keep this rule
  in mind.
- Unknown/malformed server commands are logged and swallowed, never crash the process.
- `!log on` announces itself **in the room** (not just to the moderator who ran it), and
  `!settings` lets anyone check a room's current logging status at any time - satisfying
  the requirement that collected data (chat logs) be publicly disclosed, not gathered
  silently. `!gdpr` gives any user a self-service view of everything stored about their own
  character.

**Your responsibility as the operator (not enforceable in code):**
- **Official channels**: file a Helpdesk ticket and get a positive response from site staff
  *before* using `!join` on an official channel. The Development channel is an exception
  for testing - mention in-channel that you're testing a bot if it responds to commands
  there. `!join` has no way to know whether you've actually gotten permission, so nothing
  stops you from technically joining an unauthorized room - don't.
- **Private channels**: only join with the channel owner's explicit permission.
- **Character profile**: the bot's character page must state that it's a chat bot, briefly
  describe its purpose, and link/name the character who operates it.
- **Kinks**: the bot's character must only have *custom* kinks set (none from the standard
  list), so it doesn't show up in kink search.
- **Advertisements**: don't use `sendRoomAd`/`!`-triggered ad-posting in public channels
  without site staff approval, or in private channels without the owner's consent.
- **Privacy policy**: since this bot logs messages and stores character-linked data
  (`!log`, `kv_store`), F-List's privacy rules require that this collection be *publicly
  disclosed* and that the bot have its own privacy policy (what's collected, how it's used,
  how long it's retained) - this can live on the bot character's profile page. The `!gdpr`
  and `!settings` commands help satisfy the "let users see/access their own data" part, but
  the written policy itself is on you.
- Credentials (`FLIST_ACCOUNT`/`FLIST_PASSWORD`) are only ever used locally to fetch a
  ticket and are never transmitted anywhere else - satisfies the "must not store/transmit
  user credentials" rule, which in this codebase is specifically about the *bot's own*
  login, since it doesn't handle other users' credentials at all.
