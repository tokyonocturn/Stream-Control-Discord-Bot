# OBS Discord Control Bot

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-ES2020-F7DF1E?logo=javascript&logoColor=black)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Version](https://img.shields.io/badge/version-2.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A two client Discord bot that lets you and your moderators run your stream from a phone. It connects straight to OBS over its WebSocket server, so you can start or stop your stream and recording, switch scenes, enable or disable sources, and add or edit browser sources, all from a Discord slash command. A companion Twitch bot bridges Twitch chat into Discord, keeps a subscriber role in sync, and updates your Twitch title and category.

It was built for one specific problem: sometimes you are not sitting at your PC when something needs to change on stream. This bot is the remote.

## Built with

- **JavaScript** on **Node.js** (v18+)
- [discord.js](https://discord.js.org/) — both Discord bots (slash commands, voice)
- [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) — the OBS remote-control connection
- [@discordjs/voice](https://github.com/discordjs/voice) + FFmpeg — piping OBS audio into a Discord voice channel for `/obsjoin`
- Native `ws` and `https` — the Twitch IRC chat bridge and Twitch Helix API calls (no extra Twitch SDK)

## Features

**Master bot, `/obs`**
- `/obs action` start stream, stop stream, start record, stop record, or switch to any scene (autocompleted live from whatever is currently in OBS)
- `/obs sources` list every source in the current scene with its enabled or disabled status
- `/obs toggle` enable or disable a specific source, with live autocomplete of source names
- `/obs browser-add` add a new browser source to the current scene
- `/obs browser-url` change the URL an existing browser source loads, for example swapping a VDO.Ninja link, with autocomplete
- `/obs source-add` **(v2.0.0)** add any OBS input type to the current scene, not just browser source — Application Audio Capture, Audio Input/Output Capture, Color, Display Capture, Game Capture, Image, Image Slide Show, Media, Scene, Text (GDI+ and legacy FreeType 2), Video Capture Device, VLC Video, and Window Capture. Has a `settings_json` option as an escape hatch for anything not covered by the built-in fields
- `/obs properties-get` / `/obs properties-set` **(v2.0.0)** view or edit any source's Properties as JSON, autocompleted from whatever inputs currently exist in OBS
- `/obs filters` / `/obs filter-toggle` **(v2.0.0)** list a source's filters and enable/disable them, with autocomplete for both source and filter name
- `/obs audio` **(v2.0.0)** full Audio Mixer access — mute/unmute, volume (dB), balance, sync offset, monitoring type, and per-track routing — matching Advanced Audio Properties
- `/obs profile` / `/obs scene-collection` **(v2.0.0)** switch your whole Profile or Scene Collection, not just the active scene
- `/obs studio-mode` **(v2.0.0)** enable or disable Studio Mode
- `/obs transition` **(v2.0.0)** change the current scene transition and/or its duration
- `/obs virtualcam` / `/obs replay-buffer` **(v2.0.0)** start, stop, toggle, or save these from your phone alongside stream/record

All `/obs` autocomplete (scenes, sources, filters, profiles, scene collections, transitions) is live against OBS — nothing is hardcoded, so renaming or adding things in OBS shows up the next time you type the command, no bot restart needed.

**Command auditing (new in v2.0.0)** — set `COMMAND_LOG_CHANNEL_ID` and every command run on either bot gets logged there: who ran it, the exact command and options, and whether they had permission. This is separate from `CHANNEL_MOD_ACTIONS`, which only logs OBS changes that actually took effect.

**Twitch bot**
- `/obsjoin` pulls the bot into a Discord voice channel and streams OBS audio into the VC through a virtual audio cable and ffmpeg
- `/twitchcategory`, `/twitchname` update your Twitch category and title from Discord
- `/link`, `/unlink` let members link their Twitch account for automatic sub role syncing
- `/delete` bulk delete messages in a channel
- Automatic Twitch chat to Discord bridge
- Automatic Twitch subscriber to Discord role sync, every 30 minutes
- Mirrors messages from specific channels into log channels for a record of what happened

Every command that can change your stream, `/obs`, `/obsjoin`, `/twitchcategory`, `/twitchname`, is gated: it only works for server admins or the roles listed in `ALLOWED_ROLE_IDS`.

## Requirements

- Node.js 18 or newer
- FFmpeg installed and available on your system PATH, used for `/obsjoin` audio streaming
- OBS Studio with the built in WebSocket server enabled (Tools, WebSocket Server Settings, OBS 28 and newer)
- Two Discord bot applications, see the walkthrough below
- One Twitch application, see the walkthrough below, only needed if you want the Twitch features

This bot runs two Discord clients in one process: a master bot for OBS control, and a Twitch bot for chat and subscriber features. That means two separate applications in the Discord Developer Portal, each with its own token.

## Creating the Discord bot applications

You need to repeat this twice, once for the master bot and once for the Twitch bot. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click "New Application" for each one.

1. **Name the application.** Something recognizable is fine, for example `YourServerName OBS Control` and `YourServerName Twitch Bridge`.

2. **Go to the Bot tab** and add a bot user if one was not created automatically. Under the Token section, click "Reset Token" to generate one, then copy it immediately. Discord only shows it once. This is the value that goes into `DISCORD_TOKEN` for the master bot and `TWITCH_BOT_TOKEN` for the second bot.

3. **Enable Privileged Gateway Intents**, still on the Bot tab. This bot needs:
   - Server Members Intent
   - Message Content Intent

   Presence Intent is not used by this bot and can stay off.

4. **Go to the Installation tab.** Under Installation Contexts, check "Guild Install." Under Default Install Settings, Guild Install, set:
   - Scopes: `applications.commands` and `bot`
   - Permissions: at minimum, Send Messages, Manage Messages (needed by `/delete`), Manage Threads. If you would rather not think about individual permissions, Administrator covers everything the bot needs and is the simplest option for a single server bot you control.

5. **Copy the install link Discord generates** (it is shown on the Installation tab), open it in a browser, and add the bot to your server.

6. Repeat steps 1 through 5 for the second application.

## Creating the Twitch application

Only needed if you want the Twitch chat bridge, subscriber sync, or `/twitchcategory` and `/twitchname` commands.

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console) and click "Register Your Application."

2. **Name it** something like `yourservername discord bot`.

3. **OAuth Redirect URLs:** enter `http://localhost:3000/callback`. You will not actually run anything on that URL, it is only required so Twitch can issue you a token through its standard OAuth flow.

4. **Category:** Application Integration.

5. **Client Type:** Confidential.

6. Once created, your **Client ID** is shown on the application page. This is `TWITCH_CLIENT_ID`. Click "New Secret" to generate a client secret if you plan to refresh tokens yourself; the bot itself only needs a valid access token, not the secret.

7. **Get an access token** with the scopes this bot needs: `channel:read:subscriptions` and `channel:manage:broadcast`, plus chat read access for the IRC bridge. The simplest way is a token generator such as [twitchtokengenerator.com](https://twitchtokengenerator.com/), using the Client ID and Client Secret from your application and selecting those scopes. The resulting access token goes into `TWITCH_ACCESS_TOKEN`.

8. **Find your broadcaster ID**, the numeric Twitch user ID for your channel, using a lookup tool such as [streamweasels.com/tools/convert-twitch-username-to-user-id](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/). This goes into `TWITCH_BROADCASTER_ID`.

## Discord server (guild) setup

The bot expects a handful of roles and channels to already exist in your server. Enable Developer Mode first (User Settings, Advanced, Developer Mode), then right click any server, role, or channel to Copy ID.

**Roles**
| Purpose | Env variable |
|---|---|
| One or more roles allowed to run OBS/admin commands (your mod team) | `ALLOWED_ROLE_IDS`, comma separated if more than one |
| Role auto granted to linked, active Twitch subscribers | `TWITCH_SUB_ROLE_ID` |

**Channels**
| Purpose | Env variable |
|---|---|
| General bot logs | `LOG_CHANNEL_ID` |
| Donation info mirror | `CHANNEL_DONO_INFO` |
| Active subscriber list, kept updated | `CHANNEL_ACTIVE_SUBS` |
| Twitch chat bridge output | `CHANNEL_TWITCH_CHAT` |
| OBS and moderation action log | `CHANNEL_MOD_ACTIONS` |
| Optional: full command audit log (every command, allowed or denied) | `COMMAND_LOG_CHANNEL_ID` |

Give your mod role access to whichever text channels they will run commands from; `/obs`, `/obsjoin`, `/twitchcategory`, and `/twitchname` work in any channel the bot can see, they do not need to happen in a dedicated channel.

## Setup

1. **Clone the repo and install dependencies**
   ```bash
   git clone <https://github.com/tokyonocturn/Stream-Control-Discord-Bot.git>
   cd <your repo folder>
   npm install
   ```

2. **Copy the environment template and fill it in**
   ```bash
   cp .env.example .env
   ```
   See Environment variables below for what each value means and where to find it.

3. **Enable the OBS WebSocket server.** In OBS: Tools, WebSocket Server Settings, enable the server, set or confirm a password, and note the port (default `4455`). Put the password in `OBS_PASSWORD` and the machine's IP in `OBS_IP` (use `127.0.0.1` if the bot runs on the same machine as OBS).

4. **Run the bot**
   ```bash
   npm start
   ```
   On every startup, the bot connects to OBS, scans it for the full list of current scenes and the sources inside each one, and logs what it found to the console so you can confirm the connection is working. It then registers `/obs` to your server with a scene choice on `/obs action` for every scene it detected. Nothing about your scene layout is hardcoded: rename, add, or remove scenes in OBS, restart the bot, and the command list updates to match. Everything else that depends on live OBS state — sources, filters, profiles, scene collections, transitions — is looked up through autocomplete every time those commands run, so they always reflect what is in OBS right now with no restart needed.

   If OBS is unreachable when the bot starts, `/obs action` and `/obs toggle` will still register but will report an error until OBS is reachable and the bot is restarted, or until you run `/obs action` again after reconnecting.

## Environment variables

Copy `.env.example` to `.env` and fill in every value; the bot will not start correctly with any of these missing.

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token for the master (OBS control) Discord application |
| `TWITCH_BOT_TOKEN` | Bot token for the Twitch integration Discord application |
| `TWITCH_CLIENT_ID` | Client ID of your Twitch application |
| `TWITCH_ACCESS_TOKEN` | OAuth access token for the Twitch API and IRC |
| `TWITCH_BROADCASTER_ID` | Your numeric Twitch user/broadcaster ID |
| `TWITCH_CHANNEL_NAME` | Twitch channel name to bridge chat from |
| `TWITCH_BOT_USERNAME` | Username the bot logs into Twitch IRC as |
| `TARGET_GUILD_ID` | Discord server (guild) ID the bot operates in |
| `LOG_CHANNEL_ID` | Channel ID for general bot logs |
| `TWITCH_SUB_ROLE_ID` | Discord role ID granted to active Twitch subscribers |
| `ALLOWED_ROLE_IDS` | Comma separated Discord role IDs allowed to use admin/OBS commands |
| `CHANNEL_DONO_INFO` | Channel ID mirrored for donation info |
| `CHANNEL_ACTIVE_SUBS` | Channel ID where the active subscriber list is posted and updated |
| `CHANNEL_TWITCH_CHAT` | Channel ID the Twitch chat bridge posts into |
| `CHANNEL_MOD_ACTIONS` | Channel ID where moderation and OBS action logs are posted |
| `COMMAND_LOG_CHANNEL_ID` | Optional. Channel ID for a full audit log of every command run on either bot, who ran it, and whether it was allowed or denied. Leave blank to disable |
| `OBS_IP` | IP address of the machine running OBS |
| `OBS_PORT` | OBS WebSocket port, default `4455` |
| `OBS_PASSWORD` | OBS WebSocket server password |
| `AUDIO_DEVICE` | Optional. Windows audio device name for `/obsjoin`. Defaults to `CABLE Output (VB-Audio Virtual Cable)` if left blank |

Versioning

This project follows semantic versioning: vMAJOR.MINOR.PATCH, for example v1.0.0.

MAJOR a breaking change. Something in .env, a command, or how the bot behaves changed in a way that could stop an existing setup from working. Read the release notes before updating.
MINOR a new feature. Something was added, existing commands still work the same way. Safe to update.
PATCH a bug fix only, nothing new added. Always safe to update.

Every tagged version has its own entry on the repo's Releases page listing exactly what changed since the previous tag. That page is the changelog, check there before pulling a new version if you want to know what is different.

**v2.0.0** adds ten new `/obs` subcommands (source-add, properties-get/set, filters, filter-toggle, audio, profile, scene-collection, studio-mode, transition, virtualcam, replay-buffer). No existing command, option, or `.env` variable changed behavior, so every existing setup keeps working exactly as before — the major bump reflects the size of the update rather than a breaking change.

## What `/obs` can and can't reach

`/obs` covers everything OBS exposes over its WebSocket remote-control protocol. Two different kinds of things are out of scope, for two different reasons:

**Not reachable at all, by any Discord bot.** These live only in OBS's local UI and config files and aren't exposed as a remote-control request, so no amount of bot code can add them: Plugin Manager, Captions, Automatic Scene Switcher, Output Timer, Scripts, dock/layout changes (Horizontal Layout, hide/show inactive sources), WebSocket Server Settings itself, and nearly everything under Settings → General, Hotkeys, and Advanced (process priority, renderer, color format/space, network options, projectors, system tray, preview options).

**Reachable, deliberately left out of this release.** Stream Service Settings (this would mean handling your stream key inside a Discord command) and base/output Video Settings (resolution/FPS — changing these while live can crash OBS's render pipeline). Open an issue if you want either added behind extra confirmation prompts.

## How your mods can use this

The whole point of this bot is that stream control does not live only on your PC anymore. A trusted mod role, set in `ALLOWED_ROLE_IDS`, can run these commands from their phone at any time, without touching your computer.

**You have had too much to drink and pass out on stream.** A mod sees it happening in chat or on the voice call. From their phone, they run `/obs toggle source:Webcam state:Disable` (or `/obs scene name:Be Right Back`) to cut your feed for privacy immediately, then `/obs action choice:Stop Record` or `/obs action choice:Stop Stream` if the situation calls for ending things entirely. None of this requires anyone to be near your keyboard.

**You are IRL streaming through VDO.Ninja and have zero access to your desktop, laptop, or PC.** Your phone is the stream. If your VDO.Ninja room link needs to change mid stream, for example your session gets disconnected and you get handed a new room code, a mod runs `/obs browser-url source:VDO Ninja url:https://vdo.ninja/?view=NEWCODE` and the browser source in OBS updates instantly, no PC required. The same applies to adding a brand new overlay or camera feed mid stream with `/obs browser-add`.

**Something looks wrong on screen and you cannot get to your setup fast enough.** `/obs sources` shows a mod exactly what is live in the current scene, so they can identify and disable the right source with `/obs toggle` instead of guessing. If it's a filter causing it (a chroma key, a color correction), `/obs filters source:Webcam` shows what's applied, and `/obs filter-toggle` turns the offending one off without touching anything else.

**Your mic is clipping or someone forgot to unmute Desktop Audio.** A mod runs `/obs audio source:Mic/Aux action:Set Volume (dB) value:-6` or `/obs audio source:Desktop Audio action:Mute` right from Advanced Audio Properties' Discord equivalent, no walking over to the PC.

**You're switching from a solo stream setup to a co-op one mid-session.** `/obs scene-collection name:Duo Setup` swaps your entire scene collection, and `/obs profile name:Co-op Audio` switches audio/output profiles to match, both from a phone.

In every case, the action is logged with the mod's name and what they did to the channel set in `CHANNEL_MOD_ACTIONS`, so there is always a record of who changed what and when.

## Notes on data files

- `twitch_links.json` stores each Discord user's linked Twitch username and is created automatically the first time someone runs `/link`. It is git ignored since it contains real user data, see `twitch_links.example.json` for the expected shape.
- `ffmpeg_debug.log` is written by `/obsjoin` and is also git ignored.

## Disclaimer

This bot grants meaningful control over your stream, to whoever holds the roles in `ALLOWED_ROLE_IDS`: starting and stopping stream and recording, editing scenes, sources, filters, and audio, switching profiles and scene collections, and bulk deleting messages. `/obs source-add`, `/obs properties-set`, and `/obs audio` can also write raw settings straight into OBS (via the optional `settings_json` fields), so treat that role list the same way you'd treat direct access to your OBS install. Keep it tight, and never commit your `.env` file.
