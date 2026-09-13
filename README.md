# CCMultiplayerClient-Next

> English | [中文版本](README.zh-CN.md)

[![Discord Server](https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server)](https://discord.gg/SJmMZKy)

An **online multiplayer mod** for [CrossCode](https://www.cross-code.com/), forked
from [CCMultiplayerClient](https://github.com/CCDirectLink/CCMultiplayerClient). It lets
several players share the same world: each sees the other players' avatars
walking around, and the **host's** enemies, projectiles and combat are
synchronized to everyone else over a central relay server
([CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next)).

> **Status:** early development. **Current release: 3.0.3** (handshake version —
> client and server must match).
> Main-story test progress: Faj'ro Temple (completed).
> The mod was originally written for CrossCode **1.1.0** and the old
> **CCLoader v2**. This codebase is **still based on CCLoader v2** (currently
> the actively-maintained loader),
> but has been adapted to **CrossCode 1.4.2** (the final game release). It builds cleanly,
> and multiplayer has been playtested on live 1.4.2 sessions through Faj'ro Temple.
> Later story areas are still being unlocked behind the server progress wall.
>
> **Development note:** This project is developed with **vibe coding**
> (AI-assisted development).

## FAQ

#### How is this mod different from [cc-multibakery](https://github.com/krypciak/cc-multibakery)?

* This mod focuses on story, numerous side quests, and co-op syncing. Its network
  overhead currently looks much larger than multibakery's. PvP and similar
  features aren't supported yet, but it aims for a more immersive story co-op
  experience than multibakery.

#### How long until I can play this CCMultiplayer fork?

* You can start right now. Just run
  [CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next),
  install CCMultiplayerClient-Next, and connect from the main menu. Saves are
  stored by the server, so you can play your account from any client.

#### Discord?

* Unfortunately I'm not very active in the Discord group — I may only check
  Discord once every two or three months, so this mod probably won't
  proactively share any information there.

#### Will this compete with cc-multibakery?

* I'll answer plainly: not unless its developer picks a fight with me first.
  Maintaining this mod has cost me a lot of money (due to vibe coding) and time on
  development and testing. I'd actually prefer multibakery to replace this
  project someday. I don't know any TypeScript syntax and I'm unfamiliar with the
  CCLoader API, so fixing odd bugs is very difficult. By comparison, multibakery seems more
  polished everywhere, has lower network overhead, and even has a
  smooth-looking PvP mode — I have to give multibakery a plug here.

#### How long until this project is finished?

* I don't know. I'm currently playing through it with a friend plus my own
  intensive testing and fixing. After two weeks of development the test run is
  still in the Temple Mine area, and the developer is a detail-obsessed perfectionist who
  stops to adjust anything that looks off.

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Main-city (shared town) mechanics](#main-city-shared-town-mechanics)
- [Requirements](#requirements)
- [Building](#building)
- [Installing](#installing)
- [Running](#running)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Network protocol](#network-protocol)
- [Porting notes (1.1.0 → 1.4.2, on CCLoader v2)](#porting-notes-110--142-on-ccloader-v2)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## How it works

CrossCode is a single-player game, so "multiplayer" here is really
**state mirroring**:

- One connected client is elected the **host**. The host's world is the source
  of truth for enemies.
- When a non-host client loads a map, every `Enemy` / `EnemySpawner` entity is
  **stripped out of the map data** before the level builds, and replaced with
  network-driven **mirror entities** (puppets) spawned from the host's world.
- The host continuously broadcasts entity **position, animation, state, target
  and health**; clients apply those to their mirrors. To stop the local AI /
  physics from fighting the network, a mirror's `coll.pos`, `face`,
  `currentAnim` and `currentState` are replaced with read-only accessors whose
  values only the network may change.
- Each remote player is rendered locally as a special `multiplayer` enemy
  (defined in [`assets/data/enemies/multiplayer.json`](assets/data/enemies/multiplayer.json))
  whose `anims` are the normal player animations, then re-textured with the
  local player's proxies so it looks like a person.
- The host can change over the session (**host migration**): if the host
  disconnects the server promotes another client and entities are "unlocked"
  back to local control.

Communication is a socket.io relay: clients never talk to each other directly,
everything goes through `CCMultiplayerServer-Next`. The current wire schema is
compact by default (`netSchema` = standard; a debug schema is optional).

## Features

**Connectivity & matchmaking**

- **Server list screen** (Minecraft-style): add / delete servers, **direct
  connect** by `host:port`, a live **reachability indicator** (online/offline +
  latency), all without editing the config file.
- **Version gate** — the server rejects a client whose mod version differs
  (current: **3.0.3**).
- **Account login** — username is the identity (LAN trust); optional password;
  duplicate logins are rejected and recent usernames are remembered.
- **Main-city auto-match** — see
  [Main-city (shared town) mechanics](#main-city-shared-town-mechanics).
- **Progress wall** — the server can list blocked maps (`blockedMaps`). Entry is
  refused at the door, and anyone already inside is returned to a safe map
  (Rhombus Square hub by default). Current lock: `autumn-fall.path-01`.

**World & combat sync**

- **Whole-state block sync** — players, host enemies and enemy projectiles are
  broadcast as whole-state blocks (self-healing, no packet-loss desync).
- **Host election & migration** — the first client in an instance is its host;
  the server migrates the host when it leaves.
- **Player state** — position / facing / animation / HP / SP / charge /
  cutscene / element / combat-class / guard timing.
- **Enemy sync** — host-authoritative, two cadences (base + option-driven
  hostile stream), plus enemy sounds / attacks / loot / AR messages / FX.
- **Dungeon mechanism sync** — push/pull boxes, sliding blocks, floating
  platforms, switches, ice pillars and other puzzle entities sync via a compact
  `puzzleState` relay + host snapshots. Box grip ownership is host-authoritative
  with per-frame interpolation; already-placed boxes stay personal save state.
- **Quest kill-progress sync** — with **story sync**, any party member's kill
  advances the whole party; without it, only same-map kills count.
- **Story sync** — party-wide main-story / side-quest progress with a leader
  authority stream, gather-on-trigger cutscenes, and skip votes.
- **Boss handoff** — host relays boss phase and scripted boss-defeat cutscenes so
  members stay in sync with the host's cinematic.
- **Trading** — player-to-player trade with server-side ratio and a lockout
  window after save import / mirror rollback (anti-dupe).
- **Soft-death revive** — in combat, a downed player can be revived after a
  countdown (HP fraction and time are server-configurable; boss fights use
  stricter defaults).
- **Combat feedback** — enemy hits, guards & perfect guards (with ping
  compensation for members), counter / guard-break FX, skill sound/FX replay,
  and party-wide charge time-stop.
- **Death & respawn** — downed players become spectators; a full-party wipe
  reloads the checkpoint in lockstep.
- **Guest QoL** — temporary cutscene companions, dream-FX cleanup, cutscene
  unstuck, skill-guard, and similar hardening for diverged clients.

**Social & party**

- **Parties** — invite / accept / decline / leave / kick, leader transfer, and
  "teleport to teammate" regroup.
- **Friends** — request / accept / decline / remove, request management, and a
  name search; the official companions can be re-added as friends (auto-accept).
- **Party bots** — the leader's follower bots are mirrored to members; offline
  friends can follow as "mod bots". In dungeons every network bot is culled
  (vanilla rule: follower entities are hidden inside dungeons), and they return
  automatically on leaving.
- **Story-locked companions** — companions are only unkickable when
  the game's own `SET_MEMBER_LOCKED` flag is on, exactly matching the vanilla
  Social menu logic.
- **Room players** — see who is in your current map instance, plus a live online
  counter.
- **Party chat** — press Enter for a chat input with history and speech-bubble
  rendering (party-only).

**HUD & helpers**

- **Name tags** — show names / own name / bot names, gold leader name, ping
  display, adjustable opacity and size.
- **Network badges** — a green/yellow/orange/red diamond (latency/loss) on party
  portraits and the element indicator, with hover tooltips.
- **Network debug HUD** — live upload/download rates, packet loss, cumulative
  totals.
- **Mod options tab** — a dedicated "Multiplayer" options tab in the game menu,
  including **external UI scale** and wire-schema preference.
- **Quick-menu (SHIFT) inspection** — online players and party bots are
  inspectable, with an add/remove-friend button.
- **Direct save+upload** — the bag-menu / ESC-menu save buttons upload straight
  to the server while connected.
- **Off-screen teammate arrows** and area/world-map teammate avatars.
- **Item-use / heal indicators** for other players.

**Saves & persistence**

- **Cloud saves** — your save is streamed from the server on login and restored;
  it uploads (chunked + rate-limited) on save and on exit-to-title.
- **Save mirror rollback** — the server keeps the last **five distinct
  save images** per player. The login screen's **Rollback from Mirror** button
  logs in with the save stream held, shows the five snapshots with timestamps,
  and restores whichever one you pick (picker can be closed with **×**).
- **Anti-spam** — area-save throttling and a login-time upload suppression window.
- **Local persistence** — server list, options, login history and chat history
  survive restarts (localStorage).

## Main-city (shared town) mechanics

Six areas act as **main cities** (open matchmaking hubs) where players meet
without needing to form a party:

- **Rookie Harbor** (`rookie-harbor`)
- **Rhombus Square** (`rhombus-sqr`, incl. Welcome Bridge)
- **Bergen Village** (`bergen`)
- **Ba'kii Kum** (`ba-ki-kum`)
- **Basin Keep** (`basin-keep`)
- **Homestedt** (`homestedt`)

Behaviour:

- **Whole-area instances.** The entire area counts as one main-city instance —
  every player anywhere in the area auto-matches into the same instance
  (`town:<area>[#N]`), regardless of which sub-map they stand on. A town
  instance is **not** keyed per sub-map.
- **Host = first in.** Like the wilderness, the first player to enter a channel
  becomes its host; host migration stays the same.
- **No party required.** Players auto-match to whoever is already in the city.
- **32 players per channel.** Each main-city channel holds up to 32 players;
  when full, the next player spills into a new `town:<area>#N` channel.
- **Traffic optimised for crowds.** To keep a 32-player room cheap:
  - player state (HP / EXP / SP …) syncs at **1 Hz**;
  - position syncs at **10 Hz**;
  - enemy / projectile sync packets are **not** sent (towns have no enemies);
  - party **bots** are **not** synced — they stay visible only to their own
    party leader;
  - ghost chests remain **party-only**.

## Requirements

| Component | Version |
| --- | --- |
| CrossCode | **1.4.2** (final release; the game is no longer updated) |
| Mod loader | **CCLoader v2** — it bundles the `simplify` library this mod uses |
| Node.js (build) | ≥ 18 |
| Relay server | [CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next) **3.0.3** (Node ≥ 14) |

## Building

```bash
npm install
npm run build
```

This produces `dist/`:

```
dist/
├─ mod.js       # the mod, one bundled classic script (CCLoader v2 `main`)
└─ mod.js.map
```

Game assets and the default server list are **not** copied into `dist/` —
CCLoader v2 loads them from the mod folder:

```
assets/
├─ data/enemies/multiplayer.json          # mirror-player enemy type
└─ media/sound/storysync/*.ogg            # story-sync fanfare / quest sounds
config/config.json                        # default server list
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | one-off production bundle via esbuild |
| `npm run watch` | rebuild on change |
| `npm run check` | type-check only (`tsc --noEmit`) against the 1.4.0 typedefs |

## Installing

1. Install **CCLoader v2** into your CrossCode 1.4.2 copy
   (see the [CCLoader repo](https://github.com/CCDirectLink/CCLoader)). It ships
   with the `simplify` library mod, which this mod depends on.
2. Copy this mod folder into the game's `assets/mods/` directory so that the
   mod's `package.json` sits at `assets/mods/multiplayer/`, with the compiled
   `dist/` next to it.
3. The manifest's `main` already points at the bundle (`"main": "dist/mod.js"`),
   and `ccmodDependencies` declares `simplify`, so the loader wires everything up.

## Running

1. Start a relay server (see the server repo), e.g.:
   ```bash
   cd CCMultiplayerServer-Next
   npm install
   npm start          # listens on *:15151 by default
   ```
2. Add the server to `config/config.json` (or use the bundled default).
3. Launch the game with CCLoader v2. On the **title screen** the second menu
   button is relabelled to **Connect** — click it, pick a server, enter a
   username, and the mod loads you into the host's current map.

## Configuration

`config/config.json` lists the servers shown in the in-game picker:

```json
{
	"servers": [
		{ "hostname": "localhost", "port": 15151, "type": "http" },
		{ "display": "Public server", "hostname": "example.com", "port": 15151, "type": "http" }
	]
}
```

- `hostname` / `port` / `type` — where the socket.io relay lives (`type` is the
  URL scheme, `http` or `https`).
- `display` — optional friendly name shown in the server picker.
- Default port when adding a new entry in the UI is **15151**.

Server-side gameplay knobs (monster scaling, trade, AFK, progress wall, admin
page, …) live in the **server** `config.json` — see the server README.

## Project layout

```
src/
├─ main.ts                     # CCLoader v2 entry point (`main` stage, waits for modsLoaded)
├─ multiplayer.ts              # orchestrator: connect, GUI hijack, entity registry, version
├─ config.ts / configFile.ts   # server-list config loading
├─ connection.ts               # IConnection interface (the wire protocol surface)
├─ connectors/SocketIOConnector.ts  # socket.io implementation of IConnection
├─ simplify.d.ts               # typings for the Simplify library bundled with CCLoader v2
├─ loadScreenHook.ts           # LEGACY: reused the Load-game menu (now ui/serverList.ts)
├─ types.d.ts                  # shared Vec2/Vec3 shapes
├─ i18n.ts                     # UI strings (en / zh-CN / zh-TW, …)
├─ mpEntity.ts / player.ts / server.ts / ballInfo.ts / entityDefinition.ts
├─ models/identifyResult.ts
├─ util/areaUtil.ts            # area path / type / unlock helpers
├─ listeners/
│  ├─ game/                    # watch LOCAL game state → broadcast changes
│  │  ├─ entityListener.ts  playerListener.ts
│  │  ├─ onPlayerMove/Animation/HealthChange.ts
│  │  ├─ onEntityMove/Animation/HealthChange/StateChange/TargetChange.ts
│  │  ├─ onEntitySpawn.ts onKill.ts
│  │  └─ onMapEnter.ts onMapLoaded.ts onTeleport.ts
│  └─ connection/              # apply REMOTE state → local world
│     ├─ onSetHost.ts onPlayerChangeMap.ts onRegisterEntity.ts onKillEntity.ts
│     ├─ onThrowBall.ts onUpdatePosition/Animation/AnimationTimer.ts
│     └─ onUpdateEntity{Position,Animation,State,Target,Health}.ts
├─ sync/                       # higher-level multiplayer systems
│  ├─ netSync.ts               # host enemy stream, puppets, combat relay
│  ├─ storySync.ts             # story / quest sync controller
│  ├─ puzzleSync.ts            # dungeon puzzle entities
│  ├─ cutsceneRelay.ts         # gather-on-trigger story moments
│  ├─ cutsceneActorGuard.ts    # missing scene actors + unstuck
│  ├─ tempPartyBot.ts          # temporary cutscene companions
│  ├─ dreamFxGuard.ts          # orphaned dream FX / rumble cleanup
│  ├─ tradeSync.ts             # player trade
│  ├─ bubbleSync.ts / ghostChests.ts / skillGuard.ts / saveUploadQueue.ts
│  ├─ wireSchema.ts / pvpIsolation.ts
└─ ui/                         # DOM / in-game UI
   ├─ serverList.ts  mpOptions.ts  chatBox.ts  socialMenuInject.ts
   ├─ socialOverlay.ts  quickMenuInject.ts  netBadge.ts  uiScale.ts
   ├─ teammateIndicators.ts  mapTeamAvatars.ts  itemUseIndicator.ts
   ├─ healSync.ts  aimLineIndicators.ts  saveButtons.ts  toasts.ts
   ├─ unstuckButton.ts  versionDisplay.ts  deathLineHud.ts  shopDiag.ts
```

## Network protocol

Plain socket.io events. Client→server and server→client use the same event
names; the server relays to the relevant room members. The handshake:

```
client → server  "handshake"          { username, password?, version, client }
server → client  "handshakeResponse"  { success, host, username, mapName, …tuning }
```

`handshakeResponse` also carries server gameplay tuning (monster HP/ATK scales,
soft-death revive, trade rules, relay rate caps, `blockedMaps`, …). After
handshake the save is streamed as paced `saveDownload` parts.

High-level event groups (not exhaustive — the wire is large):

| Group | Examples | Notes |
| --- | --- | --- |
| Session | `changeMap` / `onPlayerChangeMap`, `setHost`, `logout` | membership + host migration |
| Avatar | `updatePosition`, `updateAnimation`, `playerState` | "me" avatar + compact player block |
| Enemies | `entityState`, `registerEntity` / `killEntity`, `enemyAttack`, `enemySound`, `enemyFx` | host-authoritative |
| Combat | `throwBall`, `combatHit`, `combatResult`, `latePerfectGuard`, `skillFx` | hits, guards, skills |
| Dungeon | `puzzleState`, `elevatorSync`, `bombState` / `bombHandoff`, `bubbleState` | puzzle entities |
| Story | `cutsceneTrigger`, `cutsceneEntity`, `bossPhase`, `bossDefeat`, `questKill`, `spawnVar` | story / boss / quest |
| Social | `party*`, `friend*`, `trade*` | party, friends, trading |
| Saves | `saveChunk`, `saveDownload`, `saveMirrorRestore` | cloud save + mirror rollback |
| Meta | `mpPing` / `netPing`, `netSchemaPref`, admin acks | ping, schema, admin |

## Porting notes (1.1.0 → 1.4.2, on CCLoader v2)

This is the substance of the "adaptation to the latest version". The mod stays
on **CCLoader v2** and keeps using the **Simplify** library that ships with it,
so the loading mechanism and most of the plumbing are unchanged. The real work
was **updating the code for the 1.1.0 → 1.4.2 game changes** and modernising
the build.

**Loading mechanism (unchanged — CCLoader v2)**
- Still a classic script loaded via the manifest's `main` stage, bootstrapped
  off the global `modsLoaded` DOM event, with `ccmodDependencies` declaring the
  runtime deps (`ccloader`, `crosscode`, `simplify`). A `package.json` manifest
  is also kept in sync for npm.

**Build tooling (modernised)**
- webpack → **esbuild**, emitting a single classic (IIFE) script `dist/mod.js`
  that v2 runs directly. Runtime socket.io is still fetched from the relay
  server at connect time via `simplify.loadScript` (matching client/server
  library versions); the npm package is used for TypeScript types.
- Hand-maintained `src/@types/*` →
  [`ultimate-crosscode-typedefs`](https://github.com/CCDirectLink/ultimate-crosscode-typedefs)
  (CrossCode 1.4.0), vendored under `vendor/`, plus a small local
  `src/simplify.d.ts` for the Simplify global.

**1.1→1.4 type/API tightenings fixed**
- `IMultiplayerEntity` no longer widens `Enemy.target` (now `sc.BasicCombatant`);
  it's an intersection type instead.
- `player.currentAnim` may be an animation-set object now → normalised to a name.
- `loadLevel`/`teleport` re-bound through the concrete `sc.CrossCode` type.
- `MapData` → `sc.MapModel.Map`; map-entity `settings` read loosely.
- Network-driven action/event-step payloads (`SHOOT_PROXY`, `DO_ACTION`,
  `spawnEntity` `skipHook`) are cast, since those internal shapes drift per
  version and are part of the mod's own wire protocol.

**Bug fixed along the way**
- `onEntityStateChange` stored the browser global `window.status` instead of the
  entity state (`this.last = status`), so entity-state updates fired every
  frame. Now stores the real state.

**Server**
- Game-agnostic socket.io relay, but heavily extended for Next (accounts,
  cloud saves + mirrors, parties, friends, trading, admin UI, progress wall,
  rate caps). Requires matching client **3.0.3**.

## Known limitations

- **Title-screen button hijack.** `initializeGUI()` relabels a title-screen
  button by a *fixed index* (`buttons[1]` or `[2]` depending on platform). It
  warns instead of crashing if the layout changed.
- **Later story areas.** Content past the current progress wall
  (`autumn-fall.path-01` and beyond) is not fully playtested yet.
- **DLC / New Game+ content.** Enemy types and maps added after 1.1.0 use the
  same generic sync path but may still need tuning.
- `ig.game.teleport` / `spawnEntity` are wrapped by direct assignment; other
  mods doing the same could conflict.
- The in-game F8 debug command box is **disabled for players** (tester-only
  surface; it could desync the server).

If you test on a live install, the browser console (`[multiplayer] …` logs) is
the first place to look.

## Troubleshooting

- **"Could not locate the title-screen button to hijack"** — the title screen
  layout differs; adjust `buttonNumber` in `multiplayer.ts`.
- **No servers in the picker** — `config/config.json` wasn't present; add one
  or reinstall the mod folder.
- **"Could not login"** — that username is already connected to the server, or
  the password is wrong / the account is locked.
- **Version mismatch** — client and server must both be **3.0.3**.
- **Mod doesn't appear / doesn't load in CCLoader v2** — confirm the manifest's
  `main` points at `dist/mod.js`, that `dist/mod.js` was actually built, and
  that the `simplify` mod is installed and enabled (it's listed under
  `ccmodDependencies`).
- **"Could not find our own mod via simplify.getMod()"** — the mod folder must
  be named/detected as `multiplayer` (the manifest `name`), which is what
  Simplify looks up.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE)
file for details.
