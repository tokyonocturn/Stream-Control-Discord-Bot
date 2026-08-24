# OBS Discord Control Bot

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-ES2020-F7DF1E?logo=javascript&logoColor=black)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Version](https://img.shields.io/badge/version-2.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A two client Discord bot that lets you and your moderators run your stream from a phone. It connects straight to OBS over its WebSocket server, so you can start or stop your stream and recording, switch scenes, enable or disable sources, and add or edit browser sources, all from a Discord slash command. A companion Twitch bot bridges Twitch chat into Discord, keeps a subscriber role in sync, and updates your Twitch title and category.

It was built for one specific problem: sometimes you are not sitting at your PC when something needs to change on stream. This bot is the remote.

## Built with

- **JavaScript** on **Node.js** (v18+)
- [discord.js](https://discord.js.org/) — both Discord bots (slash commands, voice)
- [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) — the OBS remote-control connection
- [@discordjs/voice](https://github.com/discordjs/voice) + FFmpeg — piping OBS audio into a Discord voice channel for `/obsjoin`
- Native `ws` and `https` — the Twitch IRC chat bridge and Twitch Helix API calls (no extra Twitch SDK)

## Platform support

| Platform | Status |
|---|---|
| Windows 10 | ✅ Fully supported, what this bot is built and tested against |
| Windows 11 | ✅ Fully supported — nothing in this bot is Windows-10-specific; DirectShow, WASAPI, and VB-Cable all work the same on 11 |
| Linux | ⚠️ Partial — see below |
| macOS | ❌ Untested |

Most of `/obs` talks to OBS purely over its WebSocket API, which looks identical to the bot no matter what OS OBS itself is running on — `action`, `sources`, `toggle`, `browser-add/url`, `properties-get/set`, `filters`, `filter-toggle`, `audio`, `profile`, `scene-collection`, `studio-mode`, `transition`, `virtualcam`, and `replay-buffer` should all work against a Linux (or Mac) OBS install already. The Twitch bot side (chat bridge, sub sync, `/link`, `/delete`) is pure Node and has no OS dependency either.

Two things are genuinely Windows-only right now:

1. **`/obsjoin`** hardcodes `-f dshow` (DirectShow) for FFmpeg and defaults `AUDIO_DEVICE` to a VB-Cable name. Linux needs `-f pulse` (or `alsa`) and different device naming; this hasn't been ported.
2. **A few `/obs source-add` types** — Video Capture Device, Game Capture, and the Audio Input/Output/Application Audio Capture types — use Windows-only OBS input kinds (`dshow_input`, `game_capture`, `wasapi_*`). Linux OBS uses different kind IDs for capture (`v4l2_input`, PipeWire/Pulse-based audio) and has no real equivalent to Game Capture.

If you're running OBS on Linux, everything except those two items should work today. Linux support for `/obsjoin` and the Windows-only source types is on the radar but not yet built or tested.

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

**Kick integration (v2.3.0, optional)**
- `/kickcategory`, `/kickname` update your Kick category and title from Discord
- `/linkkick`, `/unlinkkick` let members link their Kick account for automatic sub role syncing
- Kick chat bridged into Discord, plus a follow log, both via Kick's webhook events (not a poll — see setup below, this needs a public HTTPS URL pointed at the bot)
- Sub/gift-sub role sync, granted as Kick delivers subscription webhook events

**YouTube integration (v2.3.0, optional)**
- `/youtubecategory`, `/youtubename` update your active live broadcast's category and title from Discord
- `/linkyoutube`, `/unlinkyoutube` let members link their YouTube channel ID for automatic member role syncing
- YouTube Live Chat bridged into Discord via polling (no public URL needed, unlike Kick)
- Member role sync every 30 minutes — **only works if your channel has Memberships enabled**, see caveats below

All `/obs` autocomplete (scenes, sources, filters, profiles, scene collections, transitions) is live against OBS — nothing is hardcoded, so renaming or adding things in OBS shows up the next time you type the command, no bot restart needed.

**Command auditing (v2.0.0)** — set `COMMAND_LOG_CHANNEL_ID` and every command run on either bot gets logged there: who ran it, the exact command and options, and whether they had permission. This is separate from `CHANNEL_MOD_ACTIONS`, which only logs OBS changes that actually took effect.

Every command that can change your stream, `/obs`, `/obsjoin`, `/twitchcategory`, `/twitchname`, `/kickcategory`, `/kickname`, `/youtubecategory`, `/youtubename`, is gated: it only works for server admins or the roles listed in `ALLOWED_ROLE_IDS`.

Kick and YouTube are both fully optional — leave their env vars blank and the bot runs exactly as before, no errors, no extra ports opened.

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

## Creating the Kick application (optional)

Only needed if you want `/kickcategory`, `/kickname`, Kick chat bridging, or Kick sub role sync. Skip this whole section and leave the `KICK_*` variables blank if you don't stream to Kick.

1. Open [kick.com/settings/developer](https://kick.com/settings/developer). You'll need 2FA enabled on your Kick account first if it isn't already.

2. Click **New Application** and name it something like `StreamControlDiscordBot`.

3. **App description:** something like *"A custom Discord bot pair that gives you remote control over OBS (scenes, streaming, recording, sources, browser sources) straight from Discord slash commands, plus Twitch, Kick, and YouTube integration: subscriber role syncing, live chat bridging into Discord, and stream title/category updates."*

4. **Redirect URL:** `https://localhost:3005` for local token generation (see step 6). This does not need to be reachable from the internet — it's separate from the webhook URL in step 7.

5. **Scopes:** enable `user:read`, `channel:read`, `channel:write`, and `events:subscribe`.

6. Once created, copy the **Client ID** and **Client Secret** into `KICK_CLIENT_ID` and `KICK_CLIENT_SECRET`. Then run through Kick's Authorization Code + PKCE flow once to get a refresh token — [Kick's own guide](https://docs.kick.com/getting-started/generating-tokens-oauth2-flow) walks through this, or use a PKCE-aware token generator. Put the resulting refresh token in `KICK_REFRESH_TOKEN`; the bot refreshes the access token itself from there on.

7. **Set up your webhook URL in the same developer app settings.** This is what actually delivers chat/follow/sub events to the bot — Kick does not support polling for these, only signed webhook pushes. Point it at wherever `KICK_WEBHOOK_PORT` (default `3005`) is reachable from the public internet: a reverse proxy on your router, a service like ngrok/Cloudflare Tunnel, or a VPS if the bot doesn't run on your gaming PC. If this points nowhere reachable, everything else (category/title updates) still works — you just won't get Kick chat bridging or sub role sync.

8. **Find your numeric Kick user ID** (not your username) — call `GET https://api.kick.com/public/v1/users` with your access token, or check your Kick profile page's underlying data. This goes into `KICK_BROADCASTER_USER_ID`.

**Known caveats, read before relying on this:**
- Kick's webhook signature format and the exact event names for gifted/renewal subs weren't something I could verify against a live Kick app while building this — `chat.message.sent` and `channel.followed` are confirmed against Kick's docs, the subscription event names are a best guess. If sub role sync doesn't fire, check your console output when a real sub happens and compare the event name against what's in the code (`startKickWebhookServer` in `index.js`).
- If every webhook gets rejected as an invalid signature, set `KICK_VERIFY_WEBHOOK_SIGNATURE=false` in `.env` as a temporary workaround and open an issue with what you're seeing.

## Creating the YouTube application (optional)

Only needed if you want `/youtubecategory`, `/youtubename`, YouTube Live Chat bridging, or member role sync. Skip this whole section and leave the `YOUTUBE_*` variables blank if you don't stream to YouTube.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project (or use an existing one), and enable the **YouTube Data API v3** under APIs & Services → Library.

2. Under APIs & Services → OAuth consent screen, set it up for external/testing use (you don't need Google's app review for personal use — just add your own Google account as a test user).

3. Under APIs & Services → Credentials, create an **OAuth client ID** of type "Desktop app" or "Web application." If Web application, add `http://localhost:3000/callback` (or similar) as an authorized redirect URI for the one-time token exchange.

4. Copy the **Client ID** and **Client Secret** into `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.

5. **Get a refresh token once**, using the standard Google OAuth2 flow with scope `https://www.googleapis.com/auth/youtube` (title/category/chat) — and additionally `https://www.googleapis.com/auth/youtube.channel-memberships.creator` if you also want member role sync. [Google's OAuth2 playground](https://developers.google.com/oauthplayground) is the fastest way to do this for a one-person setup: paste in your client ID/secret under its settings gear, authorize with the scopes above, and copy the refresh token it gives you into `YOUTUBE_REFRESH_TOKEN`.

**Known caveats, read before relying on this:**
- Member role sync uses YouTube's separate Members API, which only works if your channel actually has Memberships enabled by YouTube (not all channels qualify) and needs the extra scope above. If it's not available for your channel, leave `YOUTUBE_SUB_ROLE_ID` blank — everything else (title/category/chat) works independently of this.
- YouTube categories are a fixed platform list (Gaming, Entertainment, Music, etc.), not free text like Twitch/Kick — `/youtubecategory` will tell you if the name you typed doesn't match one exactly.
- Title/category updates only work while you have an active live broadcast — start streaming to YouTube first.

## Discord server (guild) setup

The bot expects a handful of roles and channels to already exist in your server. Enable Developer Mode first (User Settings, Advanced, Developer Mode), then right click any server, role, or channel to Copy ID.

**Roles**
| Purpose | Env variable |
|---|---|
| One or more roles allowed to run OBS/admin commands (your mod team) | `ALLOWED_ROLE_IDS`, comma separated if more than one |
| Role auto granted to linked, active Twitch subscribers | `TWITCH_SUB_ROLE_ID` |
| Optional: role auto granted to linked Kick subscribers | `KICK_SUB_ROLE_ID` |
| Optional: role auto granted to linked YouTube channel members | `YOUTUBE_SUB_ROLE_ID` |

**Channels**
| Purpose | Env variable |
|---|---|
| General bot logs | `LOG_CHANNEL_ID` |
| Donation info mirror | `CHANNEL_DONO_INFO` |
| Active subscriber list, kept updated | `CHANNEL_ACTIVE_SUBS` |
| Twitch chat bridge output | `CHANNEL_TWITCH_CHAT` |
| Optional: Kick chat bridge output | `CHANNEL_KICK_CHAT` |
| Optional: YouTube Live Chat bridge output | `CHANNEL_YOUTUBE_CHAT` |
| OBS and moderation action log | `CHANNEL_MOD_ACTIONS` |
| Optional: full command audit log (every command, allowed or denied) | `COMMAND_LOG_CHANNEL_ID` |

Give your mod role access to whichever text channels they will run commands from; `/obs`, `/obsjoin`, `/twitchcategory`, `/twitchname`, `/kickcategory`, `/kickname`, `/youtubecategory`, and `/youtubename` work in any channel the bot can see, they do not need to happen in a dedicated channel.

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
| `KICK_CLIENT_ID` | Optional. Client ID of your Kick application |
| `KICK_CLIENT_SECRET` | Optional. Client Secret of your Kick application |
| `KICK_REFRESH_TOKEN` | Optional. OAuth refresh token for the Kick API, obtained once |
| `KICK_BROADCASTER_USER_ID` | Optional. Your numeric Kick user ID |
| `KICK_SUB_ROLE_ID` | Optional. Discord role ID granted to linked Kick subscribers |
| `KICK_WEBHOOK_PORT` | Optional. Port the bot listens on for Kick webhook events, default `3005` |
| `KICK_VERIFY_WEBHOOK_SIGNATURE` | Optional. Set to `false` to skip Kick webhook signature verification, default `true` |
| `YOUTUBE_CLIENT_ID` | Optional. Client ID of your Google Cloud OAuth application |
| `YOUTUBE_CLIENT_SECRET` | Optional. Client Secret of your Google Cloud OAuth application |
| `YOUTUBE_REFRESH_TOKEN` | Optional. OAuth refresh token for the YouTube Data API, obtained once |
| `YOUTUBE_SUB_ROLE_ID` | Optional. Discord role ID granted to linked, active YouTube channel members |
| `TARGET_GUILD_ID` | Discord server (guild) ID the bot operates in |
| `LOG_CHANNEL_ID` | Channel ID for general bot logs |
| `TWITCH_SUB_ROLE_ID` | Discord role ID granted to active Twitch subscribers |
| `ALLOWED_ROLE_IDS` | Comma separated Discord role IDs allowed to use admin/OBS commands |
| `CHANNEL_DONO_INFO` | Channel ID mirrored for donation info |
| `CHANNEL_ACTIVE_SUBS` | Channel ID where the active subscriber list is posted and updated |
| `CHANNEL_TWITCH_CHAT` | Channel ID the Twitch chat bridge posts into |
| `CHANNEL_KICK_CHAT` | Optional. Channel ID the Kick chat bridge posts into |
| `CHANNEL_YOUTUBE_CHAT` | Optional. Channel ID the YouTube Live Chat bridge posts into |
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
- `kick_links.json` / `youtube_links.json` work the same way for `/linkkick` and `/linkyoutube` — created automatically, git ignored.
- `ffmpeg_debug.log` is written by `/obsjoin` and is also git ignored.

## Disclaimer

This bot grants meaningful control over your stream, to whoever holds the roles in `ALLOWED_ROLE_IDS`: starting and stopping stream and recording, editing scenes, sources, filters, and audio, switching profiles and scene collections, updating your title/category on Twitch/Kick/YouTube, and bulk deleting messages. `/obs source-add`, `/obs properties-set`, and `/obs audio` can also write raw settings straight into OBS (via the optional `settings_json` fields), so treat that role list the same way you'd treat direct access to your OBS install. If you enable Kick, its webhook server (`KICK_WEBHOOK_PORT`) needs to be reachable from the public internet — only expose that one port, not your whole machine. Keep it tight, and never commit your `.env` file.