# discord-metrics-bot

A read-only Discord analytics collector with a small JSON API on loopback, designed
to be handed to a language model as a tool.

The bot watches one guild, counts things, and stores aggregates in SQLite. It never
stores message text, never stores a member list, and exposes no write path. The
model never holds a Discord token — it holds a token for a local API that can only
answer eleven fixed questions.

```
        Discord Gateway (read-only, 4 intents)
                     │
                     ▼
        ┌────────────────────────────┐
        │  collector  (node)         │   in-memory counters,
        │  messages / voice / members│   flushed every 15s
        └────────────┬───────────────┘
                     ▼
        ┌────────────────────────────┐
        │  SQLite  /data/metrics.db  │   aggregates only, no text
        │  hourly + daily rollups    │
        └────────────┬───────────────┘
                     ▼
        ┌────────────────────────────┐
        │  HTTP API  127.0.0.1:8283  │   GET only, bearer token,
        │  11 endpoints, fixed params│   hash-only token store, audit log
        └────────────┬───────────────┘
                     ▼
        ┌────────────────────────────┐
        │  Open WebUI tool (python)  │   token in a valve, no Discord creds
        └────────────────────────────┘
```

**Contents:** [Why](#why-not-just-give-the-model-a-discord-bot) · [Requirements](#requirements) · [Quick start](#quick-start-docker) · [Discord setup](#1-discord-application-setup) · [Bare metal](#bare-metal-install) · [Tokens](#3-issue-an-api-token) · [Tool wiring](#4-wire-up-open-webui) · [Verifying](#5-verify-it-is-actually-collecting) · [Data model](#data-model-and-retention) · [Structure](#server-structure) · [Event tagging](#event-tagging) · [Repair](#the-day-counter-repair-tool) · [API](#api-reference) · [Config](#configuration-reference) · [Operations](#operations) · [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Why not just give the model a Discord bot

Because a bot that can read a server has to be trusted with a token that can read a
server, and a model that is prompt-injected is not a trustworthy holder of one.
Three decisions follow from that:

1. **The collector cannot read messages.** It does not request the `MessageContent`
   intent, so the payload has no `content` field. A future bug cannot log what is
   not there.
2. **The API cannot write.** Every route is `GET`, parameters are enums and
   integers, unknown parameters are rejected rather than ignored, and queries are
   constant strings with bound arguments. There is no SQL for a caller to reach.
3. **The model asks questions, not queries.** It picks a window (`30d`) and a
   bucket (`day`), not a table and a join.

If you only need "how many messages today", a leaderboard bot is less work. This
exists because a community wants to know whether its events moved the needle, and
that question needs history, per-day baselines, and numbers a model will not invent.

What it refuses to store, by default:

| Data | Stored? | Notes |
|---|---|---|
| Message text, attachments, embeds, reactions | **never** | not in the intent, not in the handler, not in the schema |
| Usernames, discriminators, avatars | **never** | |
| Member list / per-member rows | **never** by default | `PER_MEMBER_COUNTERS=off` writes no per-member row at all |
| Per-member pseudonym | opt-in only | `hmac` mode = `HMAC-SHA256(user_id, HMAC_KEY)`, stable but opaque; `off` mode = random per-process salt, so pseudonyms do not even survive a restart |

---

## Requirements

- **Node.js 22.13+** (uses the built-in `node:sqlite`; no native build step, no
  `better-sqlite3`). The Docker image pins `node:22-alpine`, which is fine — it
  tracks the latest 22.x. The floor is 22.13 rather than the 22.5 that introduced
  `node:sqlite` because the module is gated behind `--experimental-sqlite` before
  22.13, and importing it unflagged there fails with `ERR_UNKNOWN_BUILTIN_MODULE`.
- **A Discord application** with a bot user in exactly one guild.
- A few tens of MB of RAM and a few MB of disk per year of daily rollups.
- Optional: **Docker** + Compose v2 (the recommended path), and **Open WebUI** if
  you want the model integration.

Time zone note: every timestamp is stored as a UTC epoch second. Buckets are UTC
days and UTC hours, which means a "day" boundary is midnight UTC, not midnight
local. For a community spread across Asia and North America that is the least
wrong choice, but it does mean an event late in the evening US time falls into the
next UTC day. The tagging CLI converts local input to UTC and echoes both, so
event windows still line up with the data.

---

## Quick start (Docker)

```bash
git clone https://github.com/mark-zeroo/discord-metrics-bot.git
cd discord-metrics-bot

cp .env.example .env
$EDITOR .env                 # DISCORD_TOKEN and DISCORD_GUILD_ID are the only required values

docker network create --subnet 172.28.0.0/24 metrics-net   # once, before the first up
docker compose up -d --build
docker compose logs -f metrics
```

The image is built locally (no registry image is published, deliberately — you
should be able to read every line that runs with your token).

Once the log shows the guild name and `ready`, issue a token and check the API:

```bash
docker compose exec metrics node scripts/issue-token.mjs issue --label openwebui
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8283/v1/meta | jq
```

That is the whole happy path. The rest of this file is why it works and what to do
when it does not.

The `metrics-net` network is created by hand because this compose file declares it
`external:` — deliberately. Open WebUI normally lives in its own compose project (or
another host entirely), and a network owned by *this* project would be torn down by
`docker compose down` while that project was still using it. If you are only running
the collector, the network still costs nothing; [§4](#4-wire-up-open-webui) explains
how the second project joins it.

---

## 1. Discord application setup

### 1.1 Create the application

1. <https://discord.com/developers/applications> → **New Application**.
2. Name it something honest (`metrics-collector`). Use a **dedicated application**
   — do not reuse the token of a bot that posts, moderates, or handles money. If
   this token leaks, the blast radius should be "someone can read one guild's
   aggregate stats", not "someone can act as your community bot".
3. **Bot** tab → **Reset Token** → copy it into `.env` as `DISCORD_TOKEN`. It is
   shown once. Never commit it; `.env` is gitignored.
4. **Bot** tab → turn **Public Bot OFF**. A public bot can be invited to arbitrary
   guilds by anyone who finds its client ID.

### 1.2 Privileged intents

**Bot** tab → *Privileged Gateway Intents*. Enable **Server Members Intent** only:

| Intent | Requested | Why |
|---|---|---|
| `Guilds` | ✅ | guild metadata, channels, roles |
| `GuildMessages` | ✅ | `messageCreate` fires; we count it |
| `GuildVoiceStates` | ✅ | voice join/leave/move for time accounting |
| `GuildMembers` | ✅ (privileged) | joins and leaves; also enables the join-date backfill |
| `MessageContent` | ❌ | never requested — the payload has no `content` field at all |
| `GuildPresences` | ❌ | online counts come from the REST snapshot's `with_counts` |

`MessageContent` and `Presence` are the two privileged intents that leak the most
and cost the most to hold. Neither is requested, which is why this collector cannot
read a message even if a future bug tried to.

### 1.3 Invite it with two permissions

Permissions integer **`66560`**:

- `View Channels` (1024)
- `Read Message History` (65536)

No `Send Messages`, no `Manage Messages`, no `Administrator`, no `Manage Roles`. The
bot cannot post, delete, rename, kick, or ban.

```
https://discord.com/api/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=66560
```

Or generate it under **OAuth2 → URL Generator** with scopes `bot` and those two
permissions.

Then flip **Public Bot** off again if you changed anything, and copy the guild ID
(right-click the server → *Copy Server ID*, with Developer Mode enabled) into
`DISCORD_GUILD_ID`. The collector only ever acts on that one guild; an invite to a
second guild is ignored.

`Read Message History` matters: without it `messageCreate` still fires for new
messages but channel history backfill and some channel resolution fails. Revoking it
later is a safe degradation, not a crash.

Structure capture needs neither permission. That channels exist, what type they are and
how many overwrites they carry is readable from the `Guilds` intent alone; `View
Channels` only decides whether a channel's `bot_can_view` is true. That split is why
`/v1/structure` can name the channels it cannot read — a list you cannot get from a bot
that lacks the permission to look.

---

## Bare-metal install

```bash
git clone https://github.com/mark-zeroo/discord-metrics-bot.git
cd discord-metrics-bot
cp .env.example .env           # .env stays at the repository root, beside compose
$EDITOR .env                   # DISCORD_TOKEN, DISCORD_GUILD_ID, DATA_DIR
mkdir -p ./data

cd app                         # the Node project lives in app/
npm ci --ignore-scripts        # exact lockfile, no postinstall scripts
npm start
```

`npm start` runs the collector and the API in one process. Logs go to stdout as
line-delimited JSON (`LOG_LEVEL=info`); pipe them wherever you pipe logs.

Note the two directories: `.env` and `data/` are at the repository root, the code is
in `app/`. `DATA_DIR=../data` in `.env.example` is written for that split — relative
paths resolve against the working directory of the `node` process, which is `app/`.
Docker does not care: both compose files set `DATA_DIR=/data` explicitly.

To keep it running, use a supervisor — systemd, s6, runit — rather than `&`:

```ini
# /etc/systemd/system/metrics-bot.service
[Unit]
Description=Discord metrics collector
After=network-online.target

[Service]
Type=simple
User=metrics
# The Node project is in app/; .env and data/ are one level up, at the repo root.
WorkingDirectory=/srv/discord-metrics-bot/app
EnvironmentFile=/srv/discord-metrics-bot/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
# node:sqlite keeps a WAL file next to the database; give it a real directory
ReadWritePaths=/srv/discord-metrics-bot/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now metrics-bot
journalctl -u metrics-bot -f
```

There is no separate migration step: the schema is created on first open, and
additive changes are applied in `app/src/db.js` idempotently, so upgrading is
`git pull && (cd app && npm ci --ignore-scripts) && restart`.

---

## 2. Choosing where the database lives

**Named volume (default, recommended).** `docker-compose.yml` mounts a named volume
at `/data`. Docker creates and owns it from the image's `/data` directory, so there
is no host path and no uid mapping to get wrong. This is the configuration that
"just works" on rootless Docker, where container uid 1000 is *not* host uid 1000.

The volume's key in `docker-compose.yml` is historical and kept as-is so an existing
install does not silently start on an empty volume. Docker's name for it is
`<compose-project>_<key>` (see `docker compose config`). Renaming the key is fine
on a fresh install — on a running one, copy `/data` across first, because a new key
is a new empty volume and the old one stays behind holding your history.

Pick one mode and stay in it. On every boot the app logs either `database opened`
(with a row count, file size and first/last day) or `database file created — no
prior history at this path`. Switching modes — or even reordering the `-f` flags —
points the container at a different database, and without that line it looks exactly
like a normal healthy start.

**Host bind mount.** If you want to point `sqlite3`, a backup script, or your editor
at the file, layer the overlay:

```bash
PUID=$(id -u) PGID=$(id -g) docker compose \
  -f docker-compose.yml -f docker-compose.bindmount.yml up -d --build
```

That overlay starts the container as root *only* so `docker/entrypoint.sh` can
`chown` the data directory to `PUID:PGID` and immediately `su-exec` down to it. The
application process is unprivileged either way; root exists for microseconds.

`./data` is relative to the compose file, so it means the repository root even though
the code is in `app/`. The clone ships it empty with a `data/.gitkeep`, which matters:
if the directory does not exist, Docker creates the bind source as **root** on first
`up`, and that is the ownership problem the entrypoint then has to undo.

If a bind mount still fails with `EACCES` or `SQLITE_CANTOPEN`, run the read-only
diagnostic on the **host**:

```bash
./app/scripts/doctor.sh ./data
```

It reports whether Docker is rootless, what the container's uid maps to, who owns
the directory, and whether SQLite's `-wal`/`-shm` siblings are writable and private.
Note that SQLite needs the *directory* writable, not just the file.

### File modes

The container writes to exactly one place — `DATA_DIR` (`/data`) — because the image
runs with a read-only root filesystem. `/tmp` is a 16 MB tmpfs at `1777` and needs no
attention. Everything else in the image is read-only and root-owned: directories
`0755`, files `0644`, and `/usr/local/bin/entrypoint.sh` `0755` because it is executed.

| Path | The process | Mode |
| --- | --- | --- |
| `/data` (the mount point) | create and delete SQLite files beside the database | `0750` |
| `/data/metrics.db` | read/write | `0600` |
| `/data/metrics.db-wal`, `-shm` | read/write, created by SQLite itself | `0640` |
| `/data/tokens.json` | read, replaced atomically on issue/revoke | `0600` |
| `/app/**` (code, `node_modules`) | read only | `0755` / `0644`, root-owned |
| `/tmp` | temp files | `1777`, tmpfs, `16m` |
| `.env` (host, next to compose) | read by **compose**, never by the container | `0600`, owned by you |

**The directory needs `+x`, and that is the part people get wrong.** Opening
`/data/metrics.db` requires search permission on `/data`; creating `-wal` alongside it
requires write permission too. A directory at `0644` — no execute bit — fails with
`SQLITE_CANTOPEN`/`EACCES` while the database file looks perfectly fine, which sends
you looking at the file. `0750` gives owner `rwx` and group `r-x`, and since the
container user is the owner, that is sufficient. `0700` also works. `0744` does not:
it has no write bit and no execute bit.

**Files are `0600` or `0640`. Never `0666`.** Privacy here is mode bits, not
encryption: a `0600` database next to a `0644` `-wal` is the same data under a
different filename, so the sidecars matter as much as the database. The app sets its
own umask to `0027` in `openDb()` before it touches the disk — that is what keeps
SQLite's sidecars at `0640` regardless of the host's umask, and `app/test/permissions.test.mjs`
fails if it regresses.

On a host bind mount, the standard pair of commands:

```bash
install -d -m 0750 -o "$(id -u)" -g "$(id -g)" ./data
chmod -R u+rwX,g+rX,o-rwx ./data
```

`+X` (capital) sets the execute bit on directories but not on the `.db`, which is what
you want; a flat `chmod -R 0750` would leave the database looking executable.

Under rootless Docker none of this is the lever you think it is: container uid 1000
maps to a host subuid, so the owner you set here is not the owner it sees. Use the
named volume, or `PUID=$(id -u)` with the bind-mount overlay, and let the entrypoint
do the `chown` from inside where the mapping is unambiguous.

---

## 3. Issue an API token

The API has no user database. Tokens are opaque bearer strings, stored only as
SHA-256 hashes with the scope and a label:

```bash
# bare metal (from app/)
cd app && npm run token -- issue --label openwebui

# docker
docker compose exec metrics node scripts/issue-token.mjs issue --label openwebui
```

```
token: 9M5xYTqAMBKnSGn4qFSwcA4i6zCPsufPcAU0SHMoF6M   (43 chars — shown once, not recoverable)
id:    a1b2c3d4
scope: stats:read
```

- The plaintext is printed once and never written to disk. A stolen
  `tokens.json` gives an attacker nothing to replay.
- One token per consumer, so revoking one does not break the others.
- `cd app && npm run token -- revoke <id>` disables a token without deleting its audit
  history; `npm run token -- list` shows the active set.
- The file is mode `0600` and written by atomic replace, so a crash cannot leave a
  half-written token store.

---

## 4. Wire up Open WebUI

This repository does not run Open WebUI. It is assumed to be running already — its own
compose project, another host, whatever you have — and all the collector needs from it
is a URL and a token. `app/openwebui/discord_metrics_tool.py` is a self-contained tool:
one file, standard library only (`urllib`, no `requests` dependency).

1. Open WebUI → **Workspace → Tools → +** → paste the file contents → Save.
2. Open the tool's valves and set:
   - `API_URL` → `http://discord-metrics:8283` if Open WebUI runs in its own compose
     project on the same Docker host and has been attached to the shared network
     (instructions below). Not `127.0.0.1` — inside a container that is Open WebUI
     itself, not the host. `http://127.0.0.1:8283` only works for a `network_mode: host`
     or bare-metal Open WebUI that is co-located with the collector.
   - `API_TOKEN` → the token from step 3.
3. Attach the tool to a model, and set `app/openwebui/SYSTEM_PROMPT.md` as its system
   prompt. The prompt is what stops the model from re-deriving numbers it should be
   reading, tells it to check `get_server_structure` before believing a zero, and
   describes how to talk about coverage gaps without inventing causes. It is a
   copy in Open WebUI's database, not a file read at runtime: re-paste it whenever
   the file changes, or the model keeps running the old rules.
4. Ask something answerable: *"How did the server do over the last 7 days?"* The
   tool call should appear with the window it chose.

### Networking: two compose projects on one host

The collector publishes its port to `127.0.0.1` only. That is right for debugging from
the host and useless to a container in another compose project, where `localhost` is
Open WebUI itself. Container-to-container traffic needs no published port at all — it
needs a shared user-defined network, because only user-defined networks get embedded
DNS. The default bridge does not resolve service names.

**1. Create the network once, on the host.** It belongs to neither project:

```bash
docker network create --subnet 172.28.0.0/24 metrics-net
```

Pin the subnet. `API_ALLOWED_IPS` defaults to `127.0.0.1,::1,172.16.0.0/12`, and
`172.28.0.0/24` sits inside that range, so the collector accepts the caller with no
change. If you let Docker pick the pool instead (`docker network create metrics-net`),
check where it landed:

```bash
docker network inspect metrics-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

A subnet outside `172.16.0.0/12` produces a `403` that reads like a bad token: add the
subnet to `API_ALLOWED_IPS` and recreate the container.

**2. This project is already attached.** `docker-compose.yml` declares the network
`external:` and gives the service an explicit alias, so the name is stable no matter
what the other project calls its services:

```yaml
services:
  metrics:
    networks:
      metrics-net:
        aliases:
          - discord-metrics

networks:
  metrics-net:
    external: true
    name: metrics-net
```

**3. Add the same network to the Open WebUI project.**

```yaml
services:
  open-webui:
    # ... your existing config ...
    networks:
      - metrics-net

networks:
  metrics-net:
    external: true
    name: metrics-net
```

Then `docker compose up -d` there so the container is recreated with the second
network attached. `external: true` on both sides is the point: neither project believes
it owns the network, so `docker compose down` in either one leaves it intact for the
other.

**4. Verify before blaming a valve.**

```bash
docker compose exec open-webui getent hosts discord-metrics        # DNS, or EAI_AGAIN
docker compose exec metrics node -e \
  "fetch('http://discord-metrics:8283/healthz').then(r=>r.text()).then(console.log)"
```

An `ENOTFOUND`/`EAI_AGAIN` means the network or alias is missing; a `403` means the
caller's address is outside `API_ALLOWED_IPS`; a hang means you are reaching something
that is not listening.

**If Open WebUI is on a different host, stop here.** A Docker network does not cross
machines. Put the API behind the network you already trust — WireGuard, a tailnet, or
a reverse proxy — publish the port on that interface rather than `0.0.0.0`
(`- "10.8.0.5:8283:8283"`), narrow `API_ALLOWED_IPS` to the tunnel subnet, and set
`API_URL` to that address. Binding widely is what `ALLOW_PUBLIC_BIND` exists to make
you do on purpose.

### Optional: `app/openwebui/metrics_filter.py`

The system prompt in step 3 belongs to a *model*. Attach the tool to a different
model, use it from a group chat, or replay a conversation under another model and the
rules vanish while the tool stays — silently, because the model still answers, just
without knowing that activity is a lower bound. The filter fixes that by keying the
instructions to the request instead of to the deployment.

1. **Workspace → Functions → +** → paste `app/openwebui/metrics_filter.py` → Save.
2. Enable it **globally**, or per model in the model's settings. Global is the point:
   a new tool is not a new prompt to remember.
3. Leave the valves alone unless you know why you are changing them.

| Valve | Default | What it does |
| --- | --- | --- |
| `TOOL_TARGETS` | `discord_metrics,discord_server_metrics` | comma-separated tool ids that count as this tool |
| `TRIGGER` | `either` | `attachment`, `use`, or `either` — see below |
| `INSTRUCTIONS` | `compact` | `compact` contract, `full` (SYSTEM_PROMPT.md verbatim), or `both` |
| `SKIP_IF_PROMPT_PRESENT` | `true` | stay out of the way when the model already carries the full prompt |
| `SKIP_TASK_REQUESTS` | `true` | skip Open WebUI's title/tag/search requests |
| `EMIT_STATUS` | `true` | show a status line when injection happens |
| `MAX_CHARS` | `16000` | refuse to inject more than this — `both` is the largest mode at ~12.5k, so keep headroom |

**What "when the tool is used" can honestly mean.** An inlet filter runs once, before
the request reaches the model, so it cannot observe the tool call that is about to
happen — that decision has not been made yet, and for native tool calling the
follow-up request after a tool result does not pass through inlet filters again.
There are only two honest signals, and `TRIGGER` picks between them:

| | tool attached to this request | tool used earlier in this chat |
| --- | --- | --- |
| `attachment` | inject | — |
| `use` | — | inject |
| `either` (default) | inject | inject |

`attachment` is the only signal available *before* the first call, which is exactly
when the rules matter most, so `use` alone means the first answer of a fresh
conversation is uninstructed. `use` does catch something a system prompt cannot: the
tool was called earlier but is no longer attached, and the model is about to
interpret those results without the rules. Default is both.

Injection is idempotent — Open WebUI re-sends the whole history every turn, so the
block would otherwise stack once per turn; the filter checks for its own header
instead. It also sits *after* your system prompt rather than replacing it, and skips
entirely when the model already carries SYSTEM_PROMPT.md, so running both costs
nothing.

`inlet` is synchronous on purpose. Open WebUI's documented filter signature returns
the body, and a host that called a coroutine-returning `inlet` without awaiting it
would discard the injection with no error anywhere. The status event is scheduled
instead of awaited, and dropped when there is no loop to run it on. Detection is also
shape-tolerant rather than schema-bound: where the tool list lives has moved between
Open WebUI releases (`tool_ids` at the top level, under `metadata`, under `chat`, or
as a rendered OpenAI `tools` array), so the filter harvests strings from any key whose
name mentions tools and matches strictly against the id. Prose that happens to contain
the tool name cannot trigger it.

**The embedded copy cannot rot.** Open WebUI loads a function as one self-contained
file, so `INSTRUCTIONS=full` needs the prompt text inside the module. That copy is
generated — `cd app && npm run sync-prompt -- --write` rewrites it, and `npm test`
fails when the two disagree. Edit `app/openwebui/SYSTEM_PROMPT.md`, not the Python
literal.

`MAX_CHARS` is a fence around the whole injection, and crossing it turns the filter
*off* rather than truncating: half a prompt is worse than none. That makes the cap a
thing the prompt has to fit inside, so `npm test` pins `INSTRUCTIONS=both`
(compact + full, the largest mode) at under 90% of it, and a refusal now emits a
status line instead of returning the payload silently — a prompt that outgrew a
stale cap once made the filter look like it had never fired.

Its decision logic has its own suite (`app/openwebui/filter_selftest.py`, run by
`npm test`): inert without the tool, idempotent across turns, anchored matching so
`discord_metrics_archive_v2` does not count as this tool, multimodal content tolerated,
and it never raises — a filter that throws breaks every chat it is attached to, so
any surprise returns the payload untouched.

The valves are the only credential the model's tool environment holds. If the tool
is compromised, the attacker gets read access to aggregates — not a Discord token.

---

## 5. Verify it is actually collecting

Do not trust "it started". Verify in this order, because each step depends on the
one before:

```bash
# 1. process alive, gateway connected, guild resolved
docker compose logs --tail=50 metrics | grep -i ready

# 2. API answering (no token needed for this one)
curl -s http://127.0.0.1:8283/healthz           # {"ok":true,"up":true}

# 3. token accepted, database readable, coverage window known
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8283/v1/meta | jq
```

`/v1/meta` is the honest one. It returns `quality.collection_started`, the schema
version, the endpoint list, the definition of every metric it reports, the caveats
the model is expected to repeat, and whether per-member counters are on. If
`collection_started` is today and the server is three years old, every historical
answer will be limited to today — and the model can see that and say so.

Then confirm numbers move:

```bash
# send a message in any channel the bot can see, then:
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8283/v1/summary?window=24h" | jq
```

Counters are flushed every `FLUSH_INTERVAL_MS` (15s), so give it a flush cycle
before expecting the number to appear. Until the first flush, the API reports what
is on disk, which is the correct thing for it to report.

---

## Data model and retention

Aggregates only. Two resolutions, so long-range retention stays cheap:

| Table | Grain | Contents |
|---|---|---|
| `message_hour`, `message_day` | hour / day × channel | messages, distinct authors |
| `poster_hour`, `poster_day` | hour / day | distinct posters (guild-wide) |
| `voice_hour`, `voice_day` | hour / day × channel | member-seconds, distinct users |
| `growth_hour`, `growth_day` | hour / day | joins, leaves, net |
| `snapshot` | point in time | member count, online count, boosts |
| `guild_event` | Discord scheduled event | name, times, subscriber count |
| `event_tag` | operator-declared window | name, kind, prize, participants, notes |
| `member_hour` | hour × pseudonym | opt-in only, `PER_MEMBER_COUNTERS=hmac` |
| `channel_meta`, `role_meta` | current state | channels and roles as last observed, `deleted_ts` marks removals instead of deleting rows |
| `structure_change` | change event | channel, role and guild changes, plus one `structure_baseline` row at install |
| `api_audit` | per request | token id, route, query string, status, duration, peer IP |
| `meta`, `channel_name`, `growth_backfill`, `voice_active` | bookkeeping | schema version, channel names, join-date backfill, live voice sessions |

Voice is counted in member-seconds in non-AFK channels. Who counts is set by
`VOICE_COUNT_MODE`:

| Mode | Counts | Use when |
| --- | --- | --- |
| `present` (default) | anyone sitting in a non-AFK channel, muted or not | the group uses voice as a lobby — join, mute, play — which is normal on phones |
| `unmuted` | only members who are neither self-muted, self-deafened nor server-deafened | you want voice to mean "people who could actually talk" |

The default changed because `unmuted` reports a flat zero on a server where nobody
unmutes, and a zero is indistinguishable from a broken collector. Note that the two
modes are not comparable: a switch in either direction starts a new series, since the
same four minutes in a lobby score 240 s in one mode and 0 s in the other.
A member alone in a channel still counts — for a community that sits in a game lobby
channel while playing, "alone in voice" is often the most meaningful signal there is.

Sessions are held in memory, so they are also *adopted* at boot: on startup the
collector walks the cached voice states and opens a session at boot time for every
eligible member already sitting in a channel. Without that, a member who has not
muted, moved or left since the last restart emits no `voiceStateUpdate` and would
stay invisible until they next touched voice — which, on a process that restarts
several times an hour, meant minutes were not counted at all. An adopted session
starts at the boot; it is never backdated, because the time before the boot is
unknowable. A graceful shutdown flushes before exiting, so the only loss is a
`SIGKILL` (everything since the last flush) and that pre-boot window.

Retention (`RETENTION_HOURLY_DAYS=90`, `RETENTION_DAILY_DAYS=730`) is enforced by a
periodic sweep that runs `VACUUM` afterwards, on `MAINTENANCE_INTERVAL_MINUTES`. Daily
rollups outlive hourly ones on purpose: dropping hours loses drill-down, not history.

---

## Server structure

Every number this API reports is a measurement of activity, and all of them are wrong
in the same direction when the bot cannot see a channel. Structure collection exists so
that the gap is a named list instead of an unknown: the collector stores the server's
configuration, and `/v1/structure` reports it next to what the bot can and cannot read.

**What is collected.** Channels — name, type, parent category, position, NSFW flag,
slowmode, number of permission overwrites, and whether the bot can view it. Roles —
name, position, colour, hoist/mentionable/managed, permission bits, member count. Guild
settings — verification level, MFA level, explicit-content filter, AFK channel and
timeout, system and rules channels, locale, features, boost tier and count, emoji and
sticker counts.

None of it needs a privileged intent. A bot can see that a channel exists, what type it
is, and how many overwrites it carries *without* being able to read a single message in
it, which is exactly the split this wants: full configuration, zero content.

**What is deliberately not collected.** Channel topics. They are the one field on a
channel that routinely holds webhook URLs and invite links, and nothing here needs them.

**Snapshot plus events.** `channel_meta` and `role_meta` hold current state, with
`deleted_ts` marking removals rather than deleting rows, so a channel that disappeared
can still be named in old activity. Each refresh diffs against stored rows and appends
to `structure_change`; the very first refresh after install records a single
`structure_baseline` row rather than 119 individual creations. Refresh runs on ready and
on channel, role and guild events — there is no polling interval, because the events are
authoritative.

**The rollup must add up.** This is the invariant to check first when a number looks
wrong, because it caught a real bug:

- per-category `channels` sum to `counts.channels`;
- `empty_channels` sums to `activity.channels_with_no_traffic`;
- `unused_voice_channels` sums to `voice_channels_visible − voice_channels_used`
  (a channel with voice time is not unused, so this is *not* the visible total);
- a `(no category)` row appears when any channel belongs to no category, which includes
  threads — their parent is a channel, not a category. Without it those channels were
  missing from the rollup entirely.

`counts.channels` excludes categories, because Discord counts the category objects as
channels: `counts.channels + counts.categories` is the figure Discord's own UI shows.

**Null is not zero.** A category with no visible channels reports `messages: null` and
`activity_known: false` — nothing there was measured. A category with no text channels
at all (voice-only) reports `messages: 0`, because zero is then a fact about the
category rather than a missing measurement. `messages_from_invisible` follows the same
rule: it is `null` where the category has nothing visible, since traffic in its invisible
half cannot be known. `messages` counts visible children only; the split exists so that
invisible traffic is neither hidden nor folded into a figure that claims to exclude it.

**Coverage and contradictions.** `coverage` reports counts — `visible_to_bot`,
`invisible_to_bot` and `visibility_unknown`, the last for channels whose flag was never
captured — while per-channel rows carry a strict true/false/null. The three-way split is
the point: `null` is not "probably visible", and coercing it either way silently moves
channels in or out of every total. A channel flagged invisible that nonetheless
produced messages or voice is reported under `visibility_contradictions`: the permission
probably changed mid-window, otherwise the flag is wrong. Those are already being
measured, so asking for `View Channel` there is wasted effort. `invisible_channels` is
ordered by how actionable a grant would be — channels with traffic first, then channels
in mostly-visible categories, then channels whose parent is unknown, with wholly
invisible categories (Archive) last, so a capped list does not bury what is being fixed.
Each `busiest` row carries `visible_to_bot` for the same reason: the list includes
channels that are also contradictions, and a reader must be able to tell.

**Permission audit.** Roles carrying `administrator`, `manage_guild` or `manage_roles`
are listed with their member counts. In a community that hands out roles this is the list
to review periodically; it is also the list of roles whose compromise matters. Channel
overwrites can grant a permission the role lacks, so this audits roles, not the effective
permission of any member.

---

## Event tagging

The most useful question a community asks is "did the tournament do anything", and
the answer needs a window that no automated source knows about. Discord's scheduled
events are not it: a pick-up tournament with a prize is usually not a scheduled
event, and `subscriberCount` is a guess.

So windows are declared by hand, on the same database, with no HTTP write path:

```bash
# local time is converted to UTC and echoed back in both, so you can see the shift
cd app                      # every npm command runs from the Node project in app/

npm run tag -- add \
  --name "Autumn 5v5 Cup" \
  --start 2026-11-14T15:30 --end 2026-11-14T20:30 \
  --tz America/New_York --kind tournament --prize "6000 tokens" --participants 30

npm run tag -- list
npm run tag -- rm --id 3

# inside docker
docker compose exec metrics node src/cli/tag.js list
```

```
tagged #1 "Autumn 5v5 Cup"
  2026-11-14T15:30 America/New_York (UTC-05:00)
  2026-11-14T20:30 America/New_York (UTC-05:00)
  window: 5.0h  (2026-11-14T20:30:00Z -> 2026-11-15T01:30:00Z)
  db: /data/metrics.db
```

Note the shift: 15:30 local is 20:30Z, i.e. the evening of the 14th UTC. Store it as
15:30Z by hand and you are measuring the small hours instead of the tournament.

In the database every timestamp is a UTC epoch second, so the only place a zone can
go wrong is the input. A naive time is read in `--tz`, then `$TAG_TZ`, then UTC; an
explicit offset
(`2026-11-14T15:30-05:00`) or trailing `Z` is honoured as-is. A date-only `--end`
covers the whole of that day, end-exclusive. Assuming UTC silently is how a 3:30pm
event gets stored at 08:30Z and compared against the wrong hours of activity.

`/v1/tags` then reports, per window, the activity inside it and an uplift against
the trailing `EVENT_BASELINE_DAYS` (28) per-day baseline, plus a `baseline_noisy`
flag when the busiest baseline day exceeds `EVENT_BASELINE_NOISY_DAYS` × the median
— because a server with one weekly game night will show a fake spike for anything
compared against it.

---

## The day-counter repair tool

Worth reading if you are inheriting this codebase, because it explains a class of
bug that is invisible until someone checks the arithmetic.

**What happened.** The original flusher wrote each day's row as an *absolute* value
taken from in-memory counters that started at zero on every boot. So a restart in
the middle of a day rewrote that day's total down to "messages seen since this
boot", while the hourly rows for the same day kept the real figures. A day row
ended up *lower* than the hours that compose it, which is impossible for real data:

```
message_day   1794268800  c1   8     <- after restart
message_hour  1794286800  c1   8
message_hour  1794283200  c1  22     <- same day, 30 total
```

**The fix.** The collector now diffs against what it last persisted and *adds*, and
it accumulates into any row already flagged `partial` instead of replacing it. A
`partial` flag is not cosmetic — it is the marker that says "this row was not
observed from the start of the day, so a later process must add to it". Rows are
raised with `MAX`, never lowered.

**Partial days are a property of the day, not of the process.** `isPartialDay()`
answers "did *this* process boot mid-day", which is not the same question as "was this
day observed from midnight". A process that booted yesterday and ran through midnight
writes today's first row, correctly judges itself to have seen the day from the start,
and stores `partial = 0`; the sticky `MAX` only upgrades a row when new traffic rewrites
it. Restart at 03:00 with no messages since, and today stays unflagged — while the day
was in fact observed in two pieces. That mattered because `first_full_day` is computed
by *excluding* partial days, so the API claimed a day was complete when it was not.

A boot is the one moment the split is known for certain, so `app/src/index.js` calls
`markDayPartial(db, dayOf(now))` immediately after writing the boot counter, before any
collector runs. It raises the flag on the boot day across `message_day`, `voice_day` and
`growth_day`; the collectors' own `isPartialDay` covers rows that do not exist yet. If
you upgrade in place, today's row stays unflagged until tomorrow's traffic rewrites it —
or fix it retroactively:

```bash
sqlite3 data/metrics.db "UPDATE message_day SET partial=1 WHERE day_ts = (SELECT MAX(day_ts) FROM message_day);"
# same for voice_day and growth_day
```

**The repair.** Rows written before that fix are fixed by:

```bash
cd app
npm run repair                       # report only; writes nothing
npm run repair -- --apply            # write the corrections
npm run repair -- --json             # machine-readable
docker compose exec metrics node src/cli/repair.js --apply
```

Rules, in order of importance:

1. Only ever raise a value. Hourly rows are pruned before daily rows, so an hour sum
   *below* the day value means part of the day lost hourly coverage — not that the
   day is wrong.
2. A day's message/voice total is at least the sum of its hours.
3. A day's distinct-author (or distinct-user) count is at least the largest single
   hour it saw. Distinct counts are unions, not sums.
4. Repaired rows are marked `partial = 1`, so the live collector keeps accumulating
   into them on the next flush instead of flattening the correction.

It is idempotent, so it is safe in a cron. Days whose hourly rows are already pruned
cannot be checked and are reported as `unverifiable` rather than silently trusted.

**Back up before `--apply`**, since this rewrites stored history:

```bash
docker compose exec -T metrics tar czf - -C /data . > metrics-$(date +%F).tar.gz
```

---

## API reference

All routes are `GET`, bearer-authenticated (`Authorization: Bearer <token>`), and
reject unknown query parameters with `400` rather than ignoring them — so a prompt
that tries to smuggle `&sql=` fails loudly.

| Route | Parameters | Answers |
|---|---|---|
| `/healthz` | — | liveness; no token required |
| `/v1/meta` | — | collection start, schema version, endpoint list, metric definitions, caveats, counter and retention settings |
| `/v1/summary` | `window` | headline totals: members, online, boosts, messages, posters, voice hours, joins/leaves |
| `/v1/growth` | `window`, `bucket` | joins, leaves, net growth over time, tenure of current members (shares divide by today's headcount in `tenure.total_members`; `tenure.members_at_install` keeps the install-day figure for context) |
| `/v1/activity` | `window`, `bucket`, `top` | message/voice series over time, busiest channels |
| `/v1/voice` | `window`, `bucket`, `top` | voice minutes over time, busiest channels; `voice_count_mode` says whether the series was collected under `present` or `unmuted`, because a total means different things in each |
| `/v1/tags` | `limit` | tagged event windows with in-window activity and uplift vs baseline |
| `/v1/engagement` | `window` | concentration: how many members produce 80% of messages, top-10% share, Gini, active-to-lurker ratio (requires `PER_MEMBER_COUNTERS=hmac`) |
| `/v1/events` | — | Discord scheduled events and observed turnout |
| `/v1/presence` | — | point-in-time online count and ratio |
| `/v1/structure` | `window`, `detail` | server configuration: channel and role counts, category rollup, bot visibility coverage and contradictions, permission audit, recent structure changes |
| `/v1/quality` | — | how far the data can be trusted: coverage, collector uptime, partial days, plus `voice_collector` — live in-process state (`active_sessions`, `sessions_started`, `count_mode`) |

Enumerations and limits — everything the caller can influence:

| Input | Constraint |
|---|---|
| `window` | `24h` (also `1d`), `7d`, `30d`, `90d`, `365d`, `all`; default `30d` |
| `bucket` | `hour`, `day`, `week`, `month`; `hour` only for windows ≤ 7d; default `day` |
| `top` | integer `1`–`API_MAX_TOP` (10); anything else is a `400`, not a clamp |
| `detail` | `summary` or `full`; `full` adds per-channel and per-role rows, the uncategorised list, and a longer change history; default `summary` |
| `limit` | integer `1`–50; anything else is a `400` |

Errors are shaped the same everywhere, so a model can recover:

| Status | Meaning |
|---|---|
| `400` | unknown/invalid parameter (the message names the offending one) |
| `401` | missing or malformed bearer token |
| `403` | token lacks `stats:read`, or the client IP is not in `API_ALLOWED_IPS` |
| `404` | no such path |
| `405` | non-`GET` method |
| `429` | per-token rate limit exceeded; `Retry-After` is set |
| `500` | internal error, or a response that would exceed `API_MAX_RESPONSE_KB` |

A response larger than the size cap is replaced with a `500` and a log line, rather
than streaming a payload a model will truncate anyway. Narrow the window or lower
`top` and retry.

Headers on every response: `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy:
no-referrer`. Every request is appended to `api_audit` (token id, route, query
string, status, duration, peer IP), pruned at `AUDIT_RETENTION_DAYS`, so a looping
model or a leaked token leaves a trail.

---

## Slash commands

The bot also answers four read-only slash commands in the guild, so members do not
need the API token (or an LLM) to see the same numbers. They read the query layer
directly — same code the API serves, no HTTP hop — and like the API they cannot
change collection.

| Command | Options | Shows |
|---|---|---|
| `/stats summary` | `window` | members, online, boosts, messages, voice hours, joins/leaves, posters, busiest channel |
| `/stats activity` | `window`, `channels` (1–10) | messages in the window plus the busiest channels |
| `/stats growth` | `window` | joins, leaves, net, members now, tenure shares |
| `/stats voice` | `window` | voice hours (per `VOICE_COUNT_MODE`) and the busiest voice channels |

`window` is one of `1d`, `7d`, `30d`, `90d`, `all` and defaults to `30d`.

Commands are registered on the guild at startup, so they appear immediately after
the bot connects (guild-scoped, not global, to avoid Discord's propagation delay).
Registration failure is logged and does not stop collection — if the log says
`Missing Access`, re-invite the bot with the `applications.commands` scope.

### Restricting who can use them

`/stats` is unrestricted until you say otherwise. `/stats-access` manages the
allowlist (stored in the `commands.stats.roles` meta key, so it survives restarts):

| Command | Effect |
|---|---|
| `/stats-access list` | show the current restriction |
| `/stats-access add role:@Role` | only holders of `@Role` may run `/stats` |
| `/stats-access remove role:@Role` | drop one role from the list |
| `/stats-access clear` | remove the restriction entirely |

Notes on the policy, because two of them are deliberate rather than obvious:

- **Members with Manage Server always have access,** even when they hold none of the
  listed roles. Without that override, one typo in `/stats-access` could restrict the
  only people able to undo it. `/stats-access` itself is likewise Manage Server only,
  re-checked in the handler rather than trusted to Discord's command visibility.
- **The allowlist controls reading, not collecting.** Collection is unaffected; a
  restricted member still contributes to every figure.
- **Empty list means unrestricted, not locked.** A fresh install works with no setup.
  To hand access to a single role, run `add` once — the list then becomes exclusive.
- Stats replies are public to the channel; denials are ephemeral. If the numbers are
  sensitive, put the channel somewhere only the allowed roles can see.

---

## Configuration reference

`.env.example` documents every variable with its rationale. The ones worth knowing:

### Required

| Variable | Meaning |
|---|---|
| `DISCORD_TOKEN` | bot token; never logged, never stored |
| `DISCORD_GUILD_ID` | the single guild to collect |

### Storage

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `./data` | directory for the database (Docker: `/data`) |
| `DB_PATH` | `$DATA_DIR/metrics.db` | explicit database path; overrides `DATA_DIR` |
| `TOKENS_FILE` | `$DATA_DIR/tokens.json` | hashed token store |
| `DB_BUSY_TIMEOUT_MS` | `5000` | how long a writer waits on a locked file before `SQLITE_BUSY` |

### Collection

| Variable | Default | Meaning |
|---|---|---|
| `FLUSH_INTERVAL_MS` | `15000` | counter flush cadence |
| `SNAPSHOT_INTERVAL_MINUTES` | `10` | presence/member-count snapshot cadence |
| `PRESENCE_STALE_MINUTES` | `30` | age at which `/v1/presence` reports stale |
| `MAINTENANCE_INTERVAL_MINUTES` | `60` | retention sweep + `VACUUM` cadence |
| `RETENTION_HOURLY_DAYS` | `90` | hourly rows kept |
| `RETENTION_DAILY_DAYS` | `730` | daily rows kept |
| `AUDIT_RETENTION_DAYS` | `30` | audit rows kept |
| `READY_TIMEOUT_SECONDS` | `60` | fail fast instead of looking alive without collecting |
| `PER_CHANNEL_METRICS` | `true` | per-channel rows (off = one total row per bucket) |
| `PER_MEMBER_COUNTERS` | `off` | `off` or `hmac`; `hmac` requires `HMAC_KEY` (≥32 bytes) |
| `EXCLUDED_ROLE_IDS` | — | comma-separated role IDs whose messages are ignored |
| `VOICE_COUNT_MODE` | `present` | `present` counts muted members sitting in a channel; `unmuted` requires an unmuted, undeafened member |

Structure capture has no variable of its own: it is written on ready and on channel,
role and guild events, with no polling interval to tune and no way to switch it off.
That is deliberate — it is the map every other figure is read against.

### Analytics

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_BASELINE_DAYS` | `28` | trailing baseline length for event uplift |
| `EVENT_BASELINE_NOISY_DAYS` | `3` | spike ratio at which the baseline is flagged noisy |

### API

| Variable | Default | Meaning |
|---|---|---|
| `API_HOST` | `127.0.0.1` | bind address; non-loopback requires `ALLOW_PUBLIC_BIND=true`, and routable public IPs are refused even then |
| `API_PORT` | `8283` | port |
| `RATE_LIMIT_PER_MIN` | `60` | per-token sliding window |
| `API_ALLOWED_IPS` | — | optional IP/CIDR allowlist on top of the token check |
| `API_MAX_TOP` | `10` | hard cap on `?top=` |
| `API_MAX_RESPONSE_KB` | `256` | response size cap |
| `AUDIT_FLUSH_SECONDS` | `10` | audit batch interval |
| `AUDIT_BUFFER_ROWS` | `500` | audit buffer length before a forced flush |
| `ALLOW_PUBLIC_BIND` | `false` | explicit opt-in for a non-loopback bind |

### CLI

| Variable | Default | Meaning |
|---|---|---|
| `TAG_TZ` | `UTC` | fallback zone for `npm run tag` when `--tz` is omitted |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Config is validated once at startup: a bad value stops the process with a message
naming the variable, rather than being silently coerced into something that looks
fine until the numbers are wrong. Nothing is read from `process.env` outside
`app/src/config.js`, so this table is the complete surface.

---

## Operations

**Logs.** Line-delimited JSON on stdout. `docker compose logs -f metrics`, or
`journalctl -u metrics-bot -f`. Nothing sensitive is logged: no tokens, no message
text, no usernames. Token ids are logged, which is what you want when revoking one.

**The data volume.** Everything the bot persists lives in the named volume
`metrics-data`, mounted at `/data`: `metrics.db` (plus its `-wal`/`-shm` siblings) and
`tokens.json`. The volume name is pinned with an explicit `name:` in
`docker-compose.yml`, so it is literally `metrics-data` and not
`<compose-project>_metrics-data`. That makes the commands below stable if the project
directory is ever renamed — at the cost of one instance per host. Delete the `name:`
line to go back to project-scoped naming.

**Migrating an existing volume.** If the volume key in `docker-compose.yml` is ever
renamed, Docker treats it as a new volume: it mounts empty and the bot starts with an
empty history. Copy it across once, with the stack stopped:

```bash
# 1. find the old volume's real name — the prefix is the compose project
docker volume ls

# 2. stop everything that writes to it
docker compose down                       # NEVER `down -v`, that deletes the volume

# 3. copy old -> new, preserving ownership (the app runs as uid 1000)
docker volume create metrics-data
docker run --rm \
  -v <old-volume>:/from \
  -v metrics-data:/to \
  alpine sh -c 'cd /from && cp -av . /to/'

# 4. verify the copy before trusting it
docker run --rm -v metrics-data:/data alpine ls -la /data
docker compose up -d
curl -s http://127.0.0.1:8283/v1/quality | jq '.boots, .last_boot'
curl -s 'http://127.0.0.1:8283/v1/summary?window=30d' | jq '.messages, .members'

# 5. only once the numbers look like the old install, drop the old volume
docker volume rm <old-volume>
```

If the numbers are zero, the copy did not land — put the old volume back before
deleting anything. Leaving the old volume in place for a few days costs nothing.

**Backups.** `metrics.db` runs in WAL mode, so the file on disk plus its `-wal` are
only consistent as a set. Two options:

```bash
# A. cold: consistent by construction, a few seconds of downtime.
#    Stopping lets the collector flush and SQLite checkpoint the WAL.
docker compose stop metrics
docker run --rm -v metrics-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/metrics-$(date +%F).tar.gz -C /data .
docker compose start metrics

# B. hot: no downtime, one consistent file via SQLite's own snapshot
docker compose exec -T metrics node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/metrics.db");
  db.exec("VACUUM INTO \"/data/metrics-snapshot.db\"");
  db.close();
'
#    `ls` names only the files that exist: tar exits non-zero on a missing member,
#    and tokens.json is absent until the first token is issued
docker compose exec -T metrics sh -c 'cd /data && tar czf - $(ls metrics-snapshot.db tokens.json 2>/dev/null)' \
  > metrics-$(date +%F).tar.gz
docker compose exec -T metrics rm -f /data/metrics-snapshot.db

# C. bare metal (no Docker): sqlite3 checkpoints the WAL for you
sqlite3 data/metrics.db ".backup '/backups/metrics-$(date +%F).db'"
```

Do not `docker cp` or `tar` the live `metrics.db` on its own: it can capture a database
whose committed data is still in the WAL, and you get a file that opens fine and is
quietly missing the last minutes.

Back up `tokens.json` in the same archive, and `.env` alongside it — the volume holds
the token *store*, but `DISCORD_TOKEN` lives in `.env`. Restoring a database without its
token store means reissuing tokens; restoring a token store without its database gives
you hashes for a schema that is not there.

**Restore.**

```bash
# from a cold archive — wipe /data first so a stale -wal cannot pair with a restored db
docker compose down
docker run --rm -v metrics-data:/data -v "$PWD:/backup" alpine sh -c \
  'rm -rf /data/* && tar xzf /backup/metrics-2026-11-10.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d

# from a hot snapshot (single file) — drop the old sidecars, they belong to the old db
docker compose stop metrics
docker run --rm -v metrics-data:/data -v "$PWD:/backup" alpine sh -c \
  'rm -f /data/metrics.db-wal /data/metrics.db-shm \
   && cp /backup/metrics-snapshot.db /data/metrics.db \
   && chown 1000:1000 /data/metrics.db'
docker compose start metrics

# into a brand-new volume (fresh host, volume deleted, disaster recovery)
docker volume create metrics-data
docker run --rm -v metrics-data:/data -v "$PWD:/backup" alpine sh -c \
  'tar xzf /backup/metrics-2026-11-10.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d
```

`chown 1000:1000` is not optional: the container runs as `node` (uid 1000), and a file
extracted as root is not writable by it — you get `SQLITE_CANTOPEN` on the next boot.
Under rootless Docker that is still uid 1000 *inside* the container, which is the
mapping the entrypoint itself uses.

After any restore, confirm the history came back rather than assuming:

```bash
curl -s http://127.0.0.1:8283/v1/quality | jq '.boots, .last_boot, .partial_days'
curl -s 'http://127.0.0.1:8283/v1/summary?window=30d' | jq '.messages, .voice_hours'
```

`boots` continues from the archived value instead of resetting to 1, and the 30-day
totals are non-zero. A restore that "works" but shows `boots: 1` restored an empty
database.

**Upgrades.** `git pull && (cd app && npm ci --ignore-scripts) && restart`. Schema
changes are additive and idempotent. Run `npm run repair` (from `app/`) after a
`major` bump that touches the flusher, and `npm test` before deploying at all.

**Changing the guild.** Point `DISCORD_GUILD_ID` at the new guild and restart. The
database keeps the old guild's aggregates and starts writing new ones; if you want a
clean history, move the old file aside first. There is no guild column because the
process only ever watches one.

---

## Troubleshooting

**`SQLITE_CANTOPEN` / `EACCES` in Docker.** SQLite needs the *directory* writable,
not just the file, because it creates `metrics.db-wal` and `metrics.db-shm`. Under
rootless Docker, container uid 1000 maps to a host subuid, so a host-side
`chown 1000:1000` gives the file to the wrong user. Use the named volume (default),
or the bind-mount overlay with `PUID=$(id -u)`, and run `./app/scripts/doctor.sh ./data`.

**`doctor.sh` says `metrics.db-wal` is world-accessible.** A database upgraded from
before the umask fix left its sidecars at `0644`; restart the container and SQLite
recreates them at `0640`, or `chmod 640 data/metrics.db-wal data/metrics.db-shm` now.
The database itself was always `0600` — the WAL is the same data under a different
filename, which is why it is checked separately.

**`Used disallowed intents`.** The Members intent is enabled in code but not in the
Developer Portal. Bot tab → *Privileged Gateway Intents* → Server Members.

**Connected, but every number is zero.** The bot can see no channels. Check that
`View Channels` and `Read Message History` are granted *in the channels you care
about* — a category-level deny overrides a server-level allow. `/v1/quality` reports
`coverage.visible_to_bot`; if that is 0 the cause is permissions, not code, and
`/v1/structure` names the channels involved. No endpoint reports per-table row counts,
so confirm rows are landing by querying the database directly
(`SELECT COUNT(*) FROM message_hour`).

**`401` from the API with a token you just made.** `TOKENS_FILE` points somewhere
other than where the server reads it — common when the server runs in Docker and the
CLI ran on the host. Issue the token with `docker compose exec metrics ...` so both
sides use `/data/tokens.json`.

**`403` with a valid token.** Either the scope is not `stats:read`, or the client IP
is not in `API_ALLOWED_IPS`. The compose file sets an allowlist including
`172.16.0.0/12` for the container network; add your reverse proxy's subnet there.

**`Request with opcode 8 was rate limited` in the log.** The gateway refused a
member-chunk request. The join-date backfill no longer uses that path (it pages the
REST member list and retries with backoff), so this line should only ever appear
once, from an older build. If it appears repeatedly, check `backfill.completed` in
`/v1/meta`: repeated occurrence means the backfill flag is never being set.

**`429` while a model retries.** That is the rate limiter doing its job. Raise
`RATE_LIMIT_PER_MIN` or fix the prompt loop — a model stuck in a retry loop will
happily spend a thousand requests on one question.

**`/v1/presence` says stale.** Presence is a snapshot taken every
`SNAPSHOT_INTERVAL_MINUTES`; if the newest row is older than
`PRESENCE_STALE_MINUTES`, the endpoint says so instead of presenting a stale number
as current. Check the collector is alive.

**Numbers disagree with another bot.** They probably count different things: this
collector counts messages *after* the flush, excludes `EXCLUDED_ROLE_IDS`, ignores
DMs and other guilds, and buckets by UTC day. `/v1/quality` is the honest arbiter —
it reports coverage start, collector uptime, and partial days caused by restarts.

**A day looks low.** Run `npm run repair` (report only). If it finds a day below its
hour sum, you have the pre-fix bug documented [above](#the-day-counter-repair-tool).
If it finds nothing and the day is still low, the collector was not running that day;
`growth_day` and `api_audit` timestamps will usually confirm it.

**`partial_days` lists a day you think was complete.** Check `boot.count` and the
day: a boot marks that day partial by definition, because whatever happened between
midnight and the boot was counted by a process that is gone. A day is only complete if
a single process watched it start to finish. If a day is listed that had no boot, the
row was written by an older build — see the retroactive `UPDATE` [above](#the-day-counter-repair-tool).

**Voice is flat zero while channels are visible.** Zero seconds means no session was
ever opened, which is a different problem from voice being quiet. Three things to check,
in order: a body actually sat in a channel for longer than one flush interval; the row
appears in `voice_hour` (query the database — the collector logs table counts at debug
level only, so absence of a log line proves nothing); and after a restart, that the
member was still connected, since the boot-time seed adopts connected members and should
produce a row within two flush intervals. If all three hold, the write path is at fault,
not the permissions. Two silent exclusions worth remembering: an AFK channel is skipped
entirely, and under `VOICE_COUNT_MODE=unmuted` a self-muted or self-deafened member is
skipped too — with no AFK channel set, `afk_timeout` does nothing and idle sitters count
in full under the default `present` mode. The collector logs its session counters at
`debug` on every flush (`activeSessions`, `sessionsStarted`, `countMode`), so
`LOG_LEVEL=debug` distinguishes "no session ever opened" from "session open, nothing
accrued" without querying the database.

At boot, `voice sessions adopted on boot` logs `sessions` and `voice_states` — always,
even when both are zero, because a missing line used to be indistinguishable from
"adopted nobody".

`/v1/quality` → `voice_collector` is the first thing to read when a voice total stops
moving: `active_sessions: 0` means nothing is being measured right now, so a flat total
is not a stalled counter — it is an empty measurement, and the last number is simply the
closed session's final value. `active_sessions: 1` with a total that will not move is a
real bug.

That distinction is not academic. A session that read 459 → 549 → 594 s and then held at
649 s across a redeploy was diagnosed here as a failed boot re-adoption, because from
outside a closed session and a stalled one are indistinguishable. The member had in fact
left the channel, and 649 s was the correct total: 594 s before the restart plus ~50 s of
shutdown flush. `voice_collector` exists so the next person does not have to guess.

The re-adoption path is hardened anyway, as insurance against the case that would look
the same: `seed()` resolves each voice state against the member cache, falling back to a
lookup by user id when `state.member` is null (it is a getter over that cache, so a
swept member yields null), and retries 10 s and 30 s after boot — the retry only adds
sessions that were missed, since a member with an open session is skipped.
`last_seed_unknown` counts voice states that could not be resolved to a member at all; a
non-zero value while people sit in channels is the one thing there that would be a
genuine adoption failure.

**`/v1/structure` says `available: false`.** The collector has not completed a ready
cycle on a build that captures structure, so the tables are empty. It is written on
startup, not on a timer; restart the collector and re-check
`/v1/quality` → `coverage.structure_observed_at`. If that timestamp is old while the bot
is up, no channel, role or guild event has fired since — the collector diffs on those
events rather than polling, and `GuildUpdate` fires for guild-level settings only.

**Structure totals do not add up.** The per-category `channels`, `empty_channels` and
`unused_voice_channels` are supposed to sum to `counts.channels`,
`activity.channels_with_no_traffic` and `voice_channels_visible − voice_channels_used`
respectively. If they do not, an uncategorised channel is being dropped from the rollup
(check the `(no category)` row is present) — that was a real bug, and the arithmetic is
the fastest way to notice it again.

---

## Security notes

| Risk | Control | Where |
|---|---|---|
| Token replay from a dump | only SHA-256 hashes stored, mode `0600`, atomic replace | `app/src/api/auth.js`, `app/scripts/issue-token.mjs` |
| Timing oracle on token compare | `crypto.timingSafeEqual` on fixed-width digests | `app/src/api/auth.js` |
| Token brute force | 32 random bytes (256 bits), plus a shape check before hashing | `app/src/api/auth.js` |
| Accidental internet exposure | refuses any non-loopback `API_HOST` unless `ALLOW_PUBLIC_BIND=true`; refuses routable public IPs *even then* | `app/src/config.js` |
| Lateral movement inside a VPC | optional `API_ALLOWED_IPS` allowlist (exact IP or CIDR, IPv4-mapped IPv6 normalised) | `app/src/api/auth.js` |
| Unbounded load from a looping model | per-token sliding-window rate limit, `429` + `Retry-After` | `app/src/api/server.js` |
| Silent misuse | every request appended to `api_audit`, pruned at 30d | `app/src/api/server.js` |
| Browser-side leakage | `no-store`, `nosniff`, `CSP: default-src 'none'`, `no-referrer` | `app/src/api/server.js` |
| Response splitting | header values stripped of CR/LF before use | `app/src/api/server.js` |
| Supply chain | `npm ci --ignore-scripts`, exact pins, committed lockfile | `Dockerfile`, `app/.npmrc` |
| Container breakout | non-root user, `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit` | `docker-compose.yml` |

There is no TLS in the server. It binds loopback and expects a reverse proxy if it
ever needs to be reached across a network — and `ALLOW_PUBLIC_BIND` exists to make
that a deliberate decision rather than a typo in `.env`.

Nothing here defends against a compromised host, and there is no defence against a
guild admin who can invite a bot. Both are out of scope: if an attacker can read
`/data`, they can read aggregates, which is exactly what the tool would tell them
anyway.

---

## Development

```bash
cd app                       # the Node project; every npm command lives here
npm test                     # 205 tests, node:test, no test framework needed
npm test -- --test-name-pattern restart
node --test test/repair.test.mjs
```

Tests use `node:test` and `node:assert`, an in-memory SQLite database
(`openDb(':memory:')`) for unit tests, and temp files where the file path itself is
under test. There is no mocking of SQLite — the queries run for real, which is why
they can be trusted.

Layout — two directories, and `app/test/dockerfile.test.mjs` enforces the rules that
keep them apart:

```
.
├── app/                       the Node project; every npm command runs from here
│   ├── .npmrc                 ignore-scripts=true (must sit beside package.json)
│   ├── package.json
│   ├── src/
│   │   ├── index.js           process wiring: config → db → bot → api → timers → shutdown
│   │   ├── config.js          env parsing and validation; the only reader of process.env
│   │   ├── db.js              schema (idempotent), pragmas, prepared statements
│   │   ├── bot.js             discord.js client, intents, ready gate, backfill, structure capture
│   │   ├── backfill.js        join-date backfill (REST pagination, bounded retries)
│   │   ├── collectors/        messages.js, voice.js, members.js
│   │   ├── api/               server.js, auth.js, params.js, queries.js
│   │   ├── cli/               tag.js, repair.js
│   │   ├── maintenance.js     retention sweeps, VACUUM, audit pruning
│   │   ├── privacy.js         pseudonymisation (off / hmac)
│   │   ├── time.js            UTC bucket helpers (DAY, HOUR, dayOf, hourOf, isoDate)
│   │   └── log.js             JSON logger
│   ├── test/                  node:test suites
│   ├── scripts/
│   │   ├── issue-token.mjs    issue/revoke API tokens — the only script in the image
│   │   ├── sync-prompt.mjs    embed SYSTEM_PROMPT.md into the filter; --write to apply
│   │   └── doctor.sh          host-side permissions diagnostic
│   └── openwebui/
│       ├── discord_metrics_tool.py  self-contained Open WebUI tool (stdlib only)
│       ├── SYSTEM_PROMPT.md         instructions that keep the model honest about gaps
│       ├── metrics_filter.py        inlet filter: injects the above when the tool is in
│       │                            play; embeds a generated copy of SYSTEM_PROMPT.md
│       └── filter_selftest.py       behavioural checks for the filter's decision logic
├── data/                      bind-mount source; empty in git, kept by .gitkeep
├── docker/entrypoint.sh       chown-then-exec privilege drop for host bind mounts
├── Dockerfile                 build context is THIS directory; copies app/…
├── docker-compose.yml         build: .  (named volume — the default)
├── docker-compose.bindmount.yml
├── .env.example               copy to .env; compose reads it from the root
├── .dockerignore              keeps app/node_modules, app/test, app/openwebui, data out
├── .gitignore
└── README.md
```

Two rules hold the split together:

- **The Docker build context is the repository root, not `app/`.** A Dockerfile cannot
  `COPY` from outside its own context, and `docker/entrypoint.sh` sits beside it — so
  `build: .` stays as it is and every `COPY` in the Dockerfile is `app/`-prefixed.
  Narrowing it to `build: ./app` breaks the entrypoint copy; dropping the prefix breaks
  every other copy.
- **Nothing in `app/` reaches upward for code.** A `../src` import or a script reading
  `../openwebui/…` would resolve to nothing in the image, which ships `app/src` and
  `issue-token.mjs` only. The test asserts each `COPY` source exists, is `app/`-prefixed
  (or `docker/`), is not `.dockerignore`d, and that every `package.json` script still
  names a file that exists.

Config follows the same split: `.env` and `data/` live at the root, where both compose
and systemd point at them, while `DATA_DIR=../data` is what a bare-metal run from `app/`
resolves.

Conventions worth keeping: `config.js` is the only reader of `process.env`; queries
are constant strings with bound parameters; every write goes through a transaction;
and anything that changes stored history gets a test that pins the arithmetic (see
`app/test/repair.test.mjs` and `app/test/restart.test.mjs`).

---

## Limitations

- **One guild.** A second guild is ignored. Running two instances means two
  databases and two tokens.
- **UTC buckets.** A "day" is midnight UTC, which is rarely midnight anywhere the
  community lives. Correcting for a fixed local zone is a small change; correcting
  for a community spread across eight time zones is a data-model change, so it has
  not been done.
- **No per-message time series.** Message timestamps are bucketed, never stored
  individually, so "what time of day is the server busiest" is answerable and "who
  said what when" is not — by design.
- **Backfill is join dates, not history.** Discord does not let a bot enumerate
  historical messages without `Read Message History` per channel, and does not allow
  it at all for messages older than the bot's own access. Numbers start when the
  collector does; `/v1/meta` says when that was.
- **Message and voice totals are a lower bound.** They only include channels the bot
  can see, and a busy channel can be invisible. `/v1/structure` names the invisible
  channels and ranks them by how much granting access there would buy, so the gap is
  measurable rather than merely acknowledged — but it cannot be closed from inside.
- **Voice before the first boot is gone.** A session that began while the collector
  was down is adopted at boot and starts at the boot; it is never backdated. The API
  says so rather than pretending the first interval was quiet.
- **Structure is current state plus changes, not a history.** A rename that happened
  before collection began is invisible; only the current name is known. Rows are kept
  after deletion only so old activity can still be labelled.
- **No writes over HTTP, including tagging.** Deliberate: it is the property that
  makes a leaked token uninteresting. Tagging is a CLI on the same file.
- **Tenure shares divide by today's headcount, but count join events.** The
  denominator is the latest snapshot (`tenure.total_members`), because the metric is
  "share of current members who joined within N days"; the install-day headcount lives
  on as `tenure.members_at_install`. The numerator still counts join *events* — someone
  who joined and later left is included — so on a long window with heavy churn a share
  can exceed `1.0`, and `/v1/growth` adds a caveat naming the windows that do. Read
  those as "joins relative to current size", not as a slice of the people here now.
- **Slash commands are a fixed set of views.** `/stats` renders the four views in the
  table above; there is no free-form query syntax, for the same reason the API takes
  enums instead of SQL. They are guild-scoped and read-only, and the only state they
  write is the role allowlist.

---

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, run it for your own server.
