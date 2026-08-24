require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType } = require('@discordjs/voice');
const { OBSWebSocket } = require('obs-websocket-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { spawn } = require('child_process');

// Configuration & Channel IDs (all pulled from .env — see .env.example)
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const INTERVAL_30_MIN = 30 * 60 * 1000;
const TWITCH_CHANNEL_NAME = process.env.TWITCH_CHANNEL_NAME;
const TWITCH_SUB_ROLE_ID = process.env.TWITCH_SUB_ROLE_ID;

// Allowed Roles for Admin Commands (comma-separated list of role IDs in .env)
const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

const CHANNELS = {
    donoInfo: process.env.CHANNEL_DONO_INFO,
    activeSubs: process.env.CHANNEL_ACTIVE_SUBS,
    twitchChat: process.env.CHANNEL_TWITCH_CHAT,
    modActions: process.env.CHANNEL_MOD_ACTIONS,
    commandLog: process.env.COMMAND_LOG_CHANNEL_ID
};

const EMBED_COLOR = 0xAAFFFF;

// --- Source type catalogue for /obs source-add ---
// Maps the friendly name shown in Discord to the internal OBS "input kind" id.
// These kind ids are what OBS itself uses internally (obs-websocket just passes
// them straight through to CreateInput), so they're stable across OBS installs
// on the same platform. "Scene" is handled specially below since adding an
// existing scene into another scene is a CreateSceneItem call, not CreateInput.
const SOURCE_TYPES = [
    { name: 'Application Audio Capture (BETA)', value: 'wasapi_process_output_capture' },
    { name: 'Audio Input Capture', value: 'wasapi_input_capture' },
    { name: 'Audio Output Capture', value: 'wasapi_output_capture' },
    { name: 'Browser Source', value: 'browser_source' },
    { name: 'Color Source', value: 'color_source_v3' },
    { name: 'Display Capture', value: 'monitor_capture' },
    { name: 'Game Capture', value: 'game_capture' },
    { name: 'Image', value: 'image_source' },
    { name: 'Image Slide Show', value: 'slideshow' },
    { name: 'Media Source', value: 'ffmpeg_source' },
    { name: 'Scene', value: 'scene' },
    { name: 'Text (GDI+)', value: 'text_gdiplus_v3' },
    { name: 'Video Capture Device', value: 'dshow_input' },
    { name: 'VLC Video Source', value: 'vlc_source' },
    { name: 'Window Capture', value: 'window_capture' },
    { name: 'Text (FreeType 2) [Legacy]', value: 'text_ft2_source_v2' }
];

// Builds a best-effort inputSettings object for a given OBS input kind from the
// simple, common options exposed in the slash command. Anything unusual or
// advanced (playlists, exact device ids, capture-mode flags, etc.) can be
// layered on top with the optional raw "settings_json" option, which is
// shallow-merged in last so it always wins.
function buildSourceSettings(type, { url, device, width, height, text, settingsJson } = {}) {
    let settings = {};
    switch (type) {
        case 'browser_source':
            settings = { url: url || 'https://example.com', width: width || 1920, height: height || 1080 };
            break;
        case 'color_source_v3':
            settings = { width: width || 1920, height: height || 1080 };
            break;
        case 'image_source':
            settings = { file: url || device || '' };
            break;
        case 'ffmpeg_source':
            settings = { local_file: url || '', is_local_file: true };
            break;
        case 'dshow_input':
            settings = device ? { video_device_id: device } : {};
            break;
        case 'window_capture':
            settings = device ? { window: device } : {};
            break;
        case 'monitor_capture':
            settings = device ? { monitor_id: device } : {};
            break;
        case 'game_capture':
            settings = device ? { capture_mode: 'window', window: device } : { capture_mode: 'any_fullscreen' };
            break;
        case 'text_gdiplus_v3':
        case 'text_ft2_source_v2':
            settings = { text: text || '' };
            break;
        case 'vlc_source':
            settings = url ? { playlist: [{ value: url, selected: false, hidden: false }] } : {};
            break;
        case 'wasapi_input_capture':
        case 'wasapi_output_capture':
        case 'wasapi_process_output_capture':
            settings = device ? { device_id: device } : {};
            break;
        default:
            settings = {};
    }

    if (settingsJson) {
        let parsed;
        try {
            parsed = JSON.parse(settingsJson);
        } catch (e) {
            throw new Error(`settings_json wasn't valid JSON: ${e.message}`);
        }
        settings = { ...settings, ...parsed };
    }

    return settings;
}

// Audio mixer actions available on /obs audio, mirroring Advanced Audio Properties.
const AUDIO_ACTIONS = [
    { name: 'Mute', value: 'mute' },
    { name: 'Unmute', value: 'unmute' },
    { name: 'Toggle Mute', value: 'toggle-mute' },
    { name: 'Set Volume (dB)', value: 'set-volume' },
    { name: 'Set Balance (0.0 left – 1.0 right)', value: 'set-balance' },
    { name: 'Set Sync Offset (ms)', value: 'set-sync-offset' },
    { name: 'Set Monitoring', value: 'set-monitoring' },
    { name: 'Toggle Audio Track (1-6)', value: 'toggle-track' }
];

const MONITOR_TYPES = [
    { name: 'Monitor Off', value: 'OBS_MONITORING_TYPE_NONE' },
    { name: 'Monitor Only (mute output)', value: 'OBS_MONITORING_TYPE_MONITOR_ONLY' },
    { name: 'Monitor and Output', value: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }
];

const LINKS_FILE = path.join(__dirname, 'twitch_links.json');

function loadLinks() {
    try {
        if (fs.existsSync(LINKS_FILE)) {
            return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load linked accounts:', e);
    }
    return {};
}

function saveLinks(links) {
    try {
        fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
    } catch (e) {
        console.error('Failed to save linked accounts:', e);
    }
}

// Helper to check if user has admin perms OR one of the special role IDs
function hasAccess(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return member.roles.cache.some(role => ALLOWED_ROLE_IDS.includes(role.id));
}

// Renders every option a slash command was invoked with (including nested
// subcommands/subcommand groups) into a short "name:value" string for logging.
function formatInteractionOptions(interaction) {
    try {
        const raw = interaction.options?.data || [];
        const parts = [];

        function walk(options) {
            for (const opt of options) {
                // Subcommand / subcommand group: descend into its nested options
                if (opt.options && opt.options.length) {
                    parts.push(opt.name);
                    walk(opt.options);
                } else if (opt.value !== undefined) {
                    parts.push(`${opt.name}:${opt.value}`);
                }
            }
        }

        walk(raw);
        return parts.join(' ');
    } catch (e) {
        return '';
    }
}

// Logs every command invocation (regardless of success/failure/permission
// result) to the channel set in COMMAND_LOG_CHANNEL_ID, if configured. This is
// a full audit trail, separate from CHANNEL_MOD_ACTIONS (which only logs OBS
// changes that actually took effect).
async function logCommandUsage(interaction, { allowed = true } = {}) {
    if (!CHANNELS.commandLog) return;
    try {
        const guild = interaction.guild;
        if (!guild) return;
        const logChannel = await guild.channels.fetch(CHANNELS.commandLog).catch(() => null);
        if (!logChannel) return;

        const optionsText = formatInteractionOptions(interaction);
        const commandLine = `/${interaction.commandName}${optionsText ? ' ' + optionsText : ''}`;

        const embed = new EmbedBuilder()
            .setDescription(`${allowed ? '📋' : '⛔'} **${interaction.user.tag}** ran \`${commandLine}\` in <#${interaction.channelId}>${allowed ? '' : ' — **denied** (no permission)'}`)
            .setColor(allowed ? EMBED_COLOR : 0xFF5555)
            .setTimestamp();

        await logChannel.send({ embeds: [embed] });
    } catch (e) {
        console.error('Failed to send command log message:', e.message);
    }
}

// OBS WebSocket Client Setup
const obs = new OBSWebSocket();
const OBS_IP = process.env.OBS_IP;
const OBS_PORT = process.env.OBS_PORT || '4455';
const OBS_PASSWORD = process.env.OBS_PASSWORD;

async function connectOBS() {
    try {
        if (!obs.identified) {
            await obs.connect(`ws://${OBS_IP}:${OBS_PORT}`, OBS_PASSWORD);
            console.log('Connected to OBS WebSocket successfully!');
            await scanObsState();
        }
    } catch (error) {
        console.error('Failed to connect to OBS WebSocket:', error.message);
    }
}

// Scans and logs every scene and its sources on connect, so you can confirm
// the bot can see your current OBS setup before you try controlling it.
async function scanObsState() {
    try {
        const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
        console.log(`[OBS Scan] Connected scene collection has ${scenes.length} scene(s). Current: "${currentProgramSceneName}"`);

        for (const scene of scenes) {
            const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene.sceneName });
            const sourceNames = sceneItems.map(item => item.sourceName).join(', ') || '(no sources)';
            console.log(`  - Scene "${scene.sceneName}": ${sceneItems.length} source(s) -> ${sourceNames}`);
        }
    } catch (error) {
        console.error('[OBS Scan] Failed to scan scenes/sources:', error.message);
    }
}

// Re-scan any time OBS reconnects (e.g. after OBS restarts) so the bot's
// picture of scenes/sources stays fresh without a bot restart.
obs.on('ConnectionOpened', () => {
    scanObsState().catch(() => {});
});

connectOBS();

async function getTwitchGameId(gameName) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.twitch.tv',
            path: `/helix/games?name=${encodeURIComponent(gameName)}`,
            method: 'GET',
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.data && json.data.length > 0) {
                        resolve(json.data[0].id);
                    } else {
                        reject(new Error('Twitch category/game not found.'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', err => reject(err));
        req.end();
    });
}

async function updateTwitchChannelInfo(payload) {
    return new Promise((resolve, reject) => {
        const dataString = JSON.stringify(payload);
        const options = {
            hostname: 'api.twitch.tv',
            path: `/helix/channels?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}`,
            method: 'PATCH',
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': dataString.length
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 204) {
                resolve(true);
            } else {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => reject(new Error(`Twitch API Error (${res.statusCode}): ${data}`)));
            }
        });

        req.on('error', err => reject(err));
        req.write(dataString);
        req.end();
    });
}

async function getTwitchSubscribers() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.twitch.tv',
            path: `/helix/subscriptions?broadcaster_id=${process.env.TWITCH_BROADCASTER_ID}`,
            method: 'GET',
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${process.env.TWITCH_ACCESS_TOKEN}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error(`${json.error} - ${json.message}`));
                    } else if (json.data) {
                        resolve(json.data);
                    } else {
                        resolve([]);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', err => reject(err));
        req.end();
    });
}

async function syncTwitchSubscribersToDiscord(client) {
    try {
        const guild = client.guilds.cache.get(TARGET_GUILD_ID);
        if (!guild) return;

        const subs = await getTwitchSubscribers();
        const subLogChannel = await guild.channels.fetch(CHANNELS.activeSubs).catch(() => null);
        const generalLogChannel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

        let subRole = await guild.roles.fetch(TWITCH_SUB_ROLE_ID).catch(() => null);
        if (!subRole) {
            console.error(`❌ Could not find the role with ID ${TWITCH_SUB_ROLE_ID}!`);
            return;
        }

        const linkedAccounts = loadLinks(); 
        const subTwitchIds = new Set(subs.map(sub => sub.user_name.toLowerCase()));

        const subNamesList = [];
        const newlyAssigned = [];
        
        await guild.members.fetch().catch(() => {});
        const members = guild.members.cache;

        for (const [memberId, member] of members) {
            const linkedTwitchUser = linkedAccounts[memberId]?.toLowerCase();
            const isSub = linkedTwitchUser && subTwitchIds.has(linkedTwitchUser);

            if (isSub && !member.roles.cache.has(subRole.id)) {
                await member.roles.add(subRole).catch(err => console.error('Failed to add role:', err.message));
                newlyAssigned.push(`• **${member.user.username}** (Twitch: \`${linkedTwitchUser}\`) got the sub role!`);
            } else if (!isSub && member.roles.cache.has(subRole.id)) {
                await member.roles.remove(subRole).catch(err => console.error('Failed to remove role:', err.message));
            }

            if (isSub) {
                subNamesList.push(`• **${member.user.username}** (Twitch: \`${linkedTwitchUser}\`)`);
            }
        }

        if (newlyAssigned.length > 0 && generalLogChannel) {
            const logEmbed = new EmbedBuilder()
                .setTitle('🟣 Twitch Subscriber Role Assigned')
                .setDescription(`The following active subscribers were granted the role:\n\n${newlyAssigned.join('\n')}`)
                .setColor(EMBED_COLOR)
                .setTimestamp();
            await generalLogChannel.send({ embeds: [logEmbed] });
        }

        if (subLogChannel) {
            const embed = new EmbedBuilder()
                .setTitle('🟣 Active Twitch Subscribers Sync')
                .setDescription(subNamesList.length > 0 ? subNamesList.join('\n') : 'No linked active subscribers found.')
                .setColor(EMBED_COLOR)
                .setTimestamp();

            const messages = await subLogChannel.messages.fetch({ limit: 5 }).catch(() => null);
            if (messages && messages.size > 0) {
                const botMsg = messages.find(m => m.author.id === client.user.id);
                if (botMsg) {
                    await botMsg.edit({ embeds: [embed] }).catch(() => {});
                    return;
                }
            }
            await subLogChannel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('Error syncing Twitch subscribers:', e.message);
    }
}

function startTwitchChatBridge(client) {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    ws.on('open', () => {
        const token = process.env.TWITCH_ACCESS_TOKEN ? `oauth:${process.env.TWITCH_ACCESS_TOKEN.replace('oauth:', '')}` : 'oauth:dummy';
        ws.send(`PASS ${token}`);
        ws.send(`NICK ${process.env.TWITCH_BOT_USERNAME}`);
        ws.send(`CAP REQ :twitch.tv/tags twitch.tv/commands`);
        ws.send(`JOIN #${TWITCH_CHANNEL_NAME.toLowerCase()}`);
        console.log(`Connected to Twitch IRC bridge for channel: #${TWITCH_CHANNEL_NAME}`);
    });

    ws.on('message', async (data) => {
        const messageStr = data.toString().trim();

        if (messageStr.startsWith('PING')) {
            ws.send('PONG :tmi.twitch.tv');
            return;
        }

        if (messageStr.includes('PRIVMSG')) {
            const match = messageStr.match(/display-name=([^;]+);.*PRIVMSG #[^ ]+ :(.+)/);
            if (match) {
                const username = match[1];
                const content = match[2].trim();

                try {
                    const guild = client.guilds.cache.get(TARGET_GUILD_ID);
                    if (!guild) return;
                    const twitchChatChannel = await guild.channels.fetch(CHANNELS.twitchChat).catch(() => null);
                    if (twitchChatChannel) {
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: `[Twitch] ${username}` })
                            .setDescription(content)
                            .setColor(0x9146FF)
                            .setTimestamp();
                        await twitchChatChannel.send({ embeds: [embed] });
                    }
                } catch (err) {
                    console.error('Error forwarding Twitch chat to Discord:', err.message);
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('Twitch chat bridge disconnected. Reconnecting in 5 seconds...');
        setTimeout(() => startTwitchChatBridge(client), 5000);
    });

    ws.on('error', (err) => {
        console.error('Twitch chat bridge error:', err.message);
    });
}

async function buildMasterCommands() {
    // Scan OBS for the current scene list on every startup, so the /obs action
    // dropdown always reflects whatever scenes actually exist right now.
    let sceneChoices = [];
    try {
        if (!obs.identified) await connectOBS();
        const { scenes } = await obs.call('GetSceneList');
        // Discord caps a single option at 25 choices total; reserve 4 slots for
        // start/stop stream/record and keep the rest for scenes.
        sceneChoices = scenes
            .slice(0, 21)
            .map(s => ({ name: `Scene: ${s.sceneName}`, value: s.sceneName }));
        console.log(`Scanned OBS: found ${scenes.length} scene(s)${scenes.length > 21 ? ' (only the first 21 fit in the dropdown)' : ''}.`);
    } catch (err) {
        console.error('Could not reach OBS to scan scenes at startup — /obs action will only offer stream/record controls until the bot is restarted with OBS reachable:', err.message);
    }

    return [
        new SlashCommandBuilder()
            .setName('obs')
            .setDescription('Control OBS stream, recording, scenes, and sources from your phone')
            .addSubcommand(sub =>
                sub.setName('action')
                    .setDescription('Start/stop stream or recording, or switch scenes')
                    .addStringOption(option =>
                        option.setName('choice')
                            .setDescription('Action or scene to execute')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Start Stream', value: 'start_stream' },
                                { name: 'Stop Stream', value: 'stop_stream' },
                                { name: 'Start Record', value: 'start_record' },
                                { name: 'Stop Record', value: 'stop_record' },
                                ...sceneChoices
                            )
                    )
            )
            .addSubcommand(sub =>
                sub.setName('sources')
                    .setDescription('List every source in the current scene and whether it is enabled')
            )
            .addSubcommand(sub =>
                sub.setName('toggle')
                    .setDescription('Enable or disable a source in the current scene')
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Source to toggle (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option =>
                        option.setName('state')
                            .setDescription('Enable or disable the source')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Disable', value: 'disable' },
                                { name: 'Enable', value: 'enable' }
                            )
                    )
            )
            .addSubcommand(sub =>
                sub.setName('browser-add')
                    .setDescription('Add a new browser source to the current scene')
                    .addStringOption(option => option.setName('name').setDescription('Name for the new browser source').setRequired(true))
                    .addStringOption(option => option.setName('url').setDescription('URL for the browser source to load').setRequired(true))
                    .addIntegerOption(option => option.setName('width').setDescription('Width in px (default 1920)').setRequired(false))
                    .addIntegerOption(option => option.setName('height').setDescription('Height in px (default 1080)').setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('browser-url')
                    .setDescription('Change the URL loaded by an existing browser source')
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Browser source to update (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option => option.setName('url').setDescription('New URL to load').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('source-add')
                    .setDescription('Add any OBS source type to the current scene')
                    .addStringOption(option =>
                        option.setName('type')
                            .setDescription('Source type to create')
                            .setRequired(true)
                            .addChoices(...SOURCE_TYPES)
                    )
                    .addStringOption(option =>
                        option.setName('name')
                            .setDescription('Name for the new source (or, for type: Scene, the existing scene to add)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option => option.setName('url').setDescription('URL/file path (browser, media, image, VLC)').setRequired(false))
                    .addStringOption(option => option.setName('device').setDescription('Device/window/monitor id (capture sources)').setRequired(false))
                    .addStringOption(option => option.setName('text').setDescription('Text content (Text/GDI+/FreeType sources)').setRequired(false))
                    .addIntegerOption(option => option.setName('width').setDescription('Width in px (browser/color source)').setRequired(false))
                    .addIntegerOption(option => option.setName('height').setDescription('Height in px (browser/color source)').setRequired(false))
                    .addStringOption(option => option.setName('settings_json').setDescription('Advanced: raw JSON merged into the source settings').setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('properties-get')
                    .setDescription("Show a source's current settings (Properties) as JSON")
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Source to inspect (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('properties-set')
                    .setDescription("Update a source's settings (Properties) from JSON")
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Source to update (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option => option.setName('settings_json').setDescription('JSON object of settings fields to change').setRequired(true))
            )
            .addSubcommand(sub =>
                sub.setName('filters')
                    .setDescription('List the filters on a source and whether each is enabled')
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Source to inspect (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('filter-toggle')
                    .setDescription('Enable or disable a filter on a source')
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Source the filter is on (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option =>
                        option.setName('filter')
                            .setDescription('Filter to toggle (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option =>
                        option.setName('state')
                            .setDescription('Enable or disable the filter')
                            .setRequired(true)
                            .addChoices({ name: 'Disable', value: 'disable' }, { name: 'Enable', value: 'enable' })
                    )
            )
            .addSubcommand(sub =>
                sub.setName('audio')
                    .setDescription('Audio Mixer controls: volume, mute, balance, sync offset, monitoring, tracks')
                    .addStringOption(option =>
                        option.setName('source')
                            .setDescription('Audio source to control (start typing to search)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option =>
                        option.setName('action')
                            .setDescription('What to change')
                            .setRequired(true)
                            .addChoices(...AUDIO_ACTIONS)
                    )
                    .addStringOption(option =>
                        option.setName('value')
                            .setDescription('Value for the action (dB / 0-1 / ms / monitor type / track #), where needed')
                            .setRequired(false)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('profile')
                    .setDescription('Switch the active OBS Profile')
                    .addStringOption(option =>
                        option.setName('name')
                            .setDescription('Profile to switch to')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('scene-collection')
                    .setDescription('Switch the active OBS Scene Collection')
                    .addStringOption(option =>
                        option.setName('name')
                            .setDescription('Scene collection to switch to')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('studio-mode')
                    .setDescription('Enable or disable Studio Mode')
                    .addStringOption(option =>
                        option.setName('state')
                            .setDescription('Enable or disable')
                            .setRequired(true)
                            .addChoices({ name: 'Enable', value: 'enable' }, { name: 'Disable', value: 'disable' })
                    )
            )
            .addSubcommand(sub =>
                sub.setName('transition')
                    .setDescription('Change the current scene transition and/or its duration')
                    .addStringOption(option =>
                        option.setName('name')
                            .setDescription('Transition to use')
                            .setRequired(false)
                            .setAutocomplete(true)
                    )
                    .addIntegerOption(option => option.setName('duration_ms').setDescription('Transition duration in ms').setRequired(false))
            )
            .addSubcommand(sub =>
                sub.setName('virtualcam')
                    .setDescription('Start, stop, or toggle the Virtual Camera')
                    .addStringOption(option =>
                        option.setName('state')
                            .setDescription('Action')
                            .setRequired(true)
                            .addChoices({ name: 'Start', value: 'start' }, { name: 'Stop', value: 'stop' }, { name: 'Toggle', value: 'toggle' })
                    )
            )
            .addSubcommand(sub =>
                sub.setName('replay-buffer')
                    .setDescription('Start, stop, or save the Replay Buffer')
                    .addStringOption(option =>
                        option.setName('state')
                            .setDescription('Action')
                            .setRequired(true)
                            .addChoices({ name: 'Start', value: 'start' }, { name: 'Stop', value: 'stop' }, { name: 'Save', value: 'save' })
                    )
            )
    ];
}

const twitchCommands = [
    new SlashCommandBuilder()
        .setName('obsjoin')
        .setDescription('Pulls the Twitch bot into VC and streams Track 6 audio from OBS'),
    new SlashCommandBuilder()
        .setName('twitchcategory')
        .setDescription('Change your Twitch stream category/game')
        .addStringOption(option => option.setName('game').setDescription('Exact game/category name on Twitch').setRequired(true)),
    new SlashCommandBuilder()
        .setName('twitchname')
        .setDescription('Change your Twitch stream title')
        .addStringOption(option => option.setName('title').setDescription('New stream title').setRequired(true)),
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Twitch username to get your sub role automatically')
        .addStringOption(option => option.setName('username').setDescription('Your exact Twitch username').setRequired(true)),
    new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Unlink your connected Twitch account'),
    new SlashCommandBuilder()
        .setName('delete')
        .setDescription('Delete a specified amount of messages in the channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option => option.setName('count').setDescription('Number of messages to delete (1-100)').setRequired(true))
];

// Define Clients Explicitly
const masterClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const twitchClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- MASTER BOT SETUP ---
masterClient.once('clientReady', async () => {
    console.log(`[Master Bot] Logged in as ${masterClient.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        const masterCommands = await buildMasterCommands();
        await rest.put(Routes.applicationGuildCommands(masterClient.user.id, TARGET_GUILD_ID), { body: masterCommands });
        console.log('Master commands registered successfully.');
    } catch (err) {
        console.error('Failed to register master commands:', err);
    }
});

masterClient.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.guildId !== TARGET_GUILD_ID) return;

    let targetLogId = null;
    if (message.channelId === CHANNELS.donoInfo) {
        targetLogId = CHANNELS.donoInfo;
    } else if (message.channelId === CHANNELS.twitchChat) {
        targetLogId = CHANNELS.twitchChat;
    } else if (message.channelId === CHANNELS.modActions) {
        targetLogId = CHANNELS.modActions;
    }

    if (targetLogId) {
        try {
            const targetChannel = await message.guild.channels.fetch(targetLogId).catch(() => null);
            if (targetChannel) {
                const embed = new EmbedBuilder()
                    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                    .setDescription(message.content || '[Attached Media/Embed]')
                    .setColor(EMBED_COLOR)
                    .setTimestamp();
                await targetChannel.send({ embeds: [embed] });
            }
        } catch (err) {
            console.error('Error auto-mirroring message:', err);
        }
    }
});

masterClient.on('interactionCreate', async interaction => {
    // --- Autocomplete: source/filter/profile/scene-collection/transition names, live from OBS ---
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'obs') return;
        const focused = interaction.options.getFocused(true);
        const sub = interaction.options.getSubcommand();
        const query = (focused.value || '').toLowerCase();

        function respondNames(names) {
            const filtered = names
                .filter(name => name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(name => ({ name, value: name }));
            return interaction.respond(filtered).catch(() => {});
        }

        try {
            if (!obs.identified) await connectOBS();

            // "value" on /obs audio depends on which action was picked
            if (focused.name === 'value' && sub === 'audio') {
                const action = interaction.options.getString('action');
                if (action === 'set-monitoring') {
                    const opts = MONITOR_TYPES.filter(m => m.name.toLowerCase().includes(query)).slice(0, 25);
                    return await interaction.respond(opts).catch(() => {});
                } else if (action === 'toggle-track') {
                    const opts = [1, 2, 3, 4, 5, 6].map(n => ({ name: `Track ${n}`, value: String(n) }));
                    return await interaction.respond(opts).catch(() => {});
                }
                return await interaction.respond([]).catch(() => {});
            }

            // "name" option: means different things depending on the subcommand
            if (focused.name === 'name') {
                if (sub === 'source-add') {
                    const type = interaction.options.getString('type');
                    if (type === 'scene') {
                        const { scenes } = await obs.call('GetSceneList');
                        return await respondNames(scenes.map(s => s.sceneName));
                    }
                    return await interaction.respond([]).catch(() => {});
                } else if (sub === 'profile') {
                    const { profiles } = await obs.call('GetProfileList');
                    return await respondNames(profiles);
                } else if (sub === 'scene-collection') {
                    const { sceneCollections } = await obs.call('GetSceneCollectionList');
                    return await respondNames(sceneCollections);
                } else if (sub === 'transition') {
                    const { transitions } = await obs.call('GetSceneTransitionList');
                    return await respondNames(transitions.map(t => t.transitionName));
                }
                return await interaction.respond([]).catch(() => {});
            }

            // "filter" option: filters that exist on the already-picked source
            if (focused.name === 'filter' && sub === 'filter-toggle') {
                const sourceName = interaction.options.getString('source');
                if (!sourceName) return await interaction.respond([]).catch(() => {});
                const { filters } = await obs.call('GetSourceFilterList', { sourceName });
                return await respondNames(filters.map(f => f.filterName));
            }

            // "source" option: scope depends on the subcommand
            if (focused.name === 'source') {
                let names = [];
                if (sub === 'toggle') {
                    const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
                    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
                    names = sceneItems.map(item => item.sourceName);
                } else if (sub === 'browser-url') {
                    const { inputs } = await obs.call('GetInputList', { inputKind: 'browser_source' });
                    names = inputs.map(input => input.inputName);
                } else {
                    // properties-get, properties-set, filters, filter-toggle, audio:
                    // any input in OBS, not just the current scene
                    const { inputs } = await obs.call('GetInputList');
                    names = inputs.map(input => input.inputName);
                }
                return await respondNames(names);
            }

            await interaction.respond([]).catch(() => {});
        } catch (err) {
            console.error('OBS autocomplete error:', err.message);
            await interaction.respond([]).catch(() => {});
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'obs') return;

    if (!hasAccess(interaction.member)) {
        await logCommandUsage(interaction, { allowed: false });
        return interaction.reply({ content: '❌ Nice try, twin. You don\'t have permission to use this.', flags: [MessageFlags.Ephemeral] });
    }

    await logCommandUsage(interaction);

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    async function logObsAction(text) {
        try {
            const logChannel = await interaction.guild.channels.fetch(CHANNELS.modActions).catch(() => null);
            if (logChannel) {
                const logEmbed = new EmbedBuilder().setDescription(text).setColor(EMBED_COLOR).setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
            }
        } catch (e) {
            console.error('Failed to send OBS log message:', e.message);
        }
    }

    try {
        if (!obs.identified) {
            await connectOBS();
        }

        if (subcommand === 'action') {
            const action = interaction.options.getString('choice');
            let responseText = '';
            if (action === 'start_stream') {
                await obs.call('StartStream');
                responseText = '🔴 Stream started remotely from your phone.';
            } else if (action === 'stop_stream') {
                await obs.call('StopStream');
                responseText = '⏹️ Stream stopped.';
            } else if (action === 'start_record') {
                await obs.call('StartRecord');
                responseText = '⏺️ Recording started.';
            } else if (action === 'stop_record') {
                await obs.call('StopRecord');
                responseText = '⏹️ Recording saved/stopped.';
            } else {
                await obs.call('SetCurrentProgramScene', { sceneName: action });
                responseText = `🎨 Switched OBS scene to: **${action}**`;
            }

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs action ${action}\`: ${responseText}`);

        } else if (subcommand === 'sources') {
            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
            const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });

            if (!sceneItems.length) {
                await interaction.editReply(`📭 No sources found in scene **${currentProgramSceneName}**.`);
                return;
            }

            const sorted = [...sceneItems].sort((a, b) => b.sceneItemIndex - a.sceneItemIndex);
            const lines = sorted.map(item => `${item.sceneItemEnabled ? '🟢' : '🔴'}  ${item.sourceName}`);

            const embed = new EmbedBuilder()
                .setTitle(`🎬 Sources in "${currentProgramSceneName}"`)
                .setDescription(lines.join('\n'))
                .setColor(EMBED_COLOR)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'toggle') {
            const sourceName = interaction.options.getString('source');
            const state = interaction.options.getString('state');
            const enabled = state === 'enable';

            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
            const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
            const item = sceneItems.find(i => i.sourceName === sourceName);

            if (!item) {
                await interaction.editReply(`❌ Couldn't find source **${sourceName}** in scene **${currentProgramSceneName}**. Use \`/obs sources\` to see what's there.`);
                return;
            }

            await obs.call('SetSceneItemEnabled', {
                sceneName: currentProgramSceneName,
                sceneItemId: item.sceneItemId,
                sceneItemEnabled: enabled
            });

            const responseText = `${enabled ? '🟢 Enabled' : '🔴 Disabled'} **${sourceName}** in **${currentProgramSceneName}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs toggle\`: ${responseText}`);

        } else if (subcommand === 'browser-add') {
            const name = interaction.options.getString('name');
            const url = interaction.options.getString('url');
            const width = interaction.options.getInteger('width') || 1920;
            const height = interaction.options.getInteger('height') || 1080;

            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');

            await obs.call('CreateInput', {
                sceneName: currentProgramSceneName,
                inputName: name,
                inputKind: 'browser_source',
                inputSettings: { url, width, height },
                sceneItemEnabled: true
            });

            const responseText = `🌐 Added browser source **${name}** (${width}x${height}) to **${currentProgramSceneName}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs browser-add\`: ${responseText}\n${url}`);

        } else if (subcommand === 'browser-url') {
            const sourceName = interaction.options.getString('source');
            const url = interaction.options.getString('url');

            await obs.call('SetInputSettings', {
                inputName: sourceName,
                inputSettings: { url },
                overlay: true
            });

            const responseText = `🔗 Updated **${sourceName}** to load a new URL.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs browser-url\` on **${sourceName}**:\n${url}`);

        } else if (subcommand === 'source-add') {
            const type = interaction.options.getString('type');
            const name = interaction.options.getString('name');
            const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');

            let responseText;
            if (type === 'scene') {
                if (name === currentProgramSceneName) {
                    await interaction.editReply(`❌ Can't add **${name}** to itself.`);
                    return;
                }
                await obs.call('CreateSceneItem', {
                    sceneName: currentProgramSceneName,
                    sourceName: name,
                    sceneItemEnabled: true
                });
                responseText = `🎬 Added scene **${name}** into **${currentProgramSceneName}**.`;
            } else {
                const url = interaction.options.getString('url');
                const device = interaction.options.getString('device');
                const text = interaction.options.getString('text');
                const width = interaction.options.getInteger('width');
                const height = interaction.options.getInteger('height');
                const settingsJson = interaction.options.getString('settings_json');

                const inputSettings = buildSourceSettings(type, { url, device, width, height, text, settingsJson });
                const typeLabel = SOURCE_TYPES.find(t => t.value === type)?.name || type;

                await obs.call('CreateInput', {
                    sceneName: currentProgramSceneName,
                    inputName: name,
                    inputKind: type,
                    inputSettings,
                    sceneItemEnabled: true
                });
                responseText = `✨ Added **${typeLabel}** source **${name}** to **${currentProgramSceneName}**.`;
            }

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs source-add\`: ${responseText}`);

        } else if (subcommand === 'properties-get') {
            const sourceName = interaction.options.getString('source');
            const { inputSettings, inputKind } = await obs.call('GetInputSettings', { inputName: sourceName });

            let json = JSON.stringify(inputSettings, null, 2);
            if (json.length > 3800) json = json.slice(0, 3800) + '\n… (truncated)';

            const embed = new EmbedBuilder()
                .setTitle(`⚙️ Properties: ${sourceName} (${inputKind})`)
                .setDescription('```json\n' + json + '\n```')
                .setColor(EMBED_COLOR)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'properties-set') {
            const sourceName = interaction.options.getString('source');
            const settingsJson = interaction.options.getString('settings_json');

            let inputSettings;
            try {
                inputSettings = JSON.parse(settingsJson);
            } catch (e) {
                await interaction.editReply(`❌ settings_json wasn't valid JSON: ${e.message}`);
                return;
            }

            await obs.call('SetInputSettings', { inputName: sourceName, inputSettings, overlay: true });

            const responseText = `⚙️ Updated properties on **${sourceName}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs properties-set\` on **${sourceName}**:\n\`\`\`json\n${settingsJson}\n\`\`\``);

        } else if (subcommand === 'filters') {
            const sourceName = interaction.options.getString('source');
            const { filters } = await obs.call('GetSourceFilterList', { sourceName });

            if (!filters.length) {
                await interaction.editReply(`📭 **${sourceName}** has no filters.`);
                return;
            }

            const lines = filters.map(f => `${f.filterEnabled ? '🟢' : '🔴'}  ${f.filterName} _(${f.filterKind})_`);
            const embed = new EmbedBuilder()
                .setTitle(`🧪 Filters on "${sourceName}"`)
                .setDescription(lines.join('\n'))
                .setColor(EMBED_COLOR)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } else if (subcommand === 'filter-toggle') {
            const sourceName = interaction.options.getString('source');
            const filterName = interaction.options.getString('filter');
            const state = interaction.options.getString('state');
            const enabled = state === 'enable';

            await obs.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: enabled });

            const responseText = `${enabled ? '🟢 Enabled' : '🔴 Disabled'} filter **${filterName}** on **${sourceName}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs filter-toggle\`: ${responseText}`);

        } else if (subcommand === 'audio') {
            const sourceName = interaction.options.getString('source');
            const action = interaction.options.getString('action');
            const value = interaction.options.getString('value');
            let responseText;

            if (action === 'mute' || action === 'unmute') {
                const muted = action === 'mute';
                await obs.call('SetInputMute', { inputName: sourceName, inputMuted: muted });
                responseText = `${muted ? '🔇 Muted' : '🔊 Unmuted'} **${sourceName}**.`;
            } else if (action === 'toggle-mute') {
                const { inputMuted } = await obs.call('ToggleInputMute', { inputName: sourceName });
                responseText = `${inputMuted ? '🔇 Muted' : '🔊 Unmuted'} **${sourceName}**.`;
            } else if (action === 'set-volume') {
                const db = parseFloat(value);
                if (Number.isNaN(db)) { await interaction.editReply('❌ `value` needs to be a number of dB, e.g. `-6`.'); return; }
                await obs.call('SetInputVolume', { inputName: sourceName, inputVolumeDb: db });
                responseText = `🔊 Set **${sourceName}** volume to **${db} dB**.`;
            } else if (action === 'set-balance') {
                const bal = parseFloat(value);
                if (Number.isNaN(bal) || bal < 0 || bal > 1) { await interaction.editReply('❌ `value` needs to be between `0.0` (left) and `1.0` (right).'); return; }
                await obs.call('SetInputAudioBalance', { inputName: sourceName, inputAudioBalance: bal });
                responseText = `⚖️ Set **${sourceName}** balance to **${bal}**.`;
            } else if (action === 'set-sync-offset') {
                const ms = parseInt(value, 10);
                if (Number.isNaN(ms)) { await interaction.editReply('❌ `value` needs to be a whole number of milliseconds.'); return; }
                await obs.call('SetInputAudioSyncOffset', { inputName: sourceName, inputAudioSyncOffset: ms });
                responseText = `🕒 Set **${sourceName}** sync offset to **${ms} ms**.`;
            } else if (action === 'set-monitoring') {
                const monitorType = MONITOR_TYPES.find(m => m.value === value || m.name === value)?.value;
                if (!monitorType) { await interaction.editReply('❌ Pick a monitoring value from the autocomplete list.'); return; }
                await obs.call('SetInputAudioMonitorType', { inputName: sourceName, monitorType });
                responseText = `🎚️ Set **${sourceName}** monitoring to **${MONITOR_TYPES.find(m => m.value === monitorType).name}**.`;
            } else if (action === 'toggle-track') {
                const track = parseInt(value, 10);
                if (Number.isNaN(track) || track < 1 || track > 6) { await interaction.editReply('❌ `value` needs to be a track number, 1-6.'); return; }
                const { inputAudioTracks } = await obs.call('GetInputAudioTracks', { inputName: sourceName });
                const key = String(track);
                const newState = !inputAudioTracks[key];
                await obs.call('SetInputAudioTracks', { inputName: sourceName, inputAudioTracks: { [key]: newState } });
                responseText = `${newState ? '🟢 Enabled' : '🔴 Disabled'} **${sourceName}** on audio track **${track}**.`;
            } else {
                await interaction.editReply('❌ Unknown audio action.');
                return;
            }

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs audio ${action}\` on **${sourceName}**: ${responseText}`);

        } else if (subcommand === 'profile') {
            const name = interaction.options.getString('name');
            await obs.call('SetCurrentProfile', { profileName: name });
            const responseText = `👤 Switched Profile to **${name}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs profile\`: ${responseText}`);

        } else if (subcommand === 'scene-collection') {
            const name = interaction.options.getString('name');
            await obs.call('SetCurrentSceneCollection', { sceneCollectionName: name });
            const responseText = `📁 Switched Scene Collection to **${name}**.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs scene-collection\`: ${responseText}`);

        } else if (subcommand === 'studio-mode') {
            const state = interaction.options.getString('state');
            const enabled = state === 'enable';
            await obs.call('SetStudioModeEnabled', { studioModeEnabled: enabled });
            const responseText = `${enabled ? '🟢 Enabled' : '🔴 Disabled'} Studio Mode.`;
            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs studio-mode\`: ${responseText}`);

        } else if (subcommand === 'transition') {
            const name = interaction.options.getString('name');
            const durationMs = interaction.options.getInteger('duration_ms');

            if (!name && !durationMs) {
                await interaction.editReply('❌ Give a transition name, a duration, or both.');
                return;
            }

            if (name) await obs.call('SetCurrentSceneTransition', { transitionName: name });
            if (durationMs) await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs });

            const parts = [];
            if (name) parts.push(`transition to **${name}**`);
            if (durationMs) parts.push(`duration to **${durationMs}ms**`);
            const responseText = `🔀 Set ${parts.join(' and ')}.`;

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs transition\`: ${responseText}`);

        } else if (subcommand === 'virtualcam') {
            const state = interaction.options.getString('state');
            let responseText;
            if (state === 'start') { await obs.call('StartVirtualCam'); responseText = '📷 Virtual Camera started.'; }
            else if (state === 'stop') { await obs.call('StopVirtualCam'); responseText = '📷 Virtual Camera stopped.'; }
            else { const { outputActive } = await obs.call('ToggleVirtualCam'); responseText = `📷 Virtual Camera ${outputActive ? 'started' : 'stopped'}.`; }

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs virtualcam ${state}\`: ${responseText}`);

        } else if (subcommand === 'replay-buffer') {
            const state = interaction.options.getString('state');
            let responseText;
            if (state === 'start') { await obs.call('StartReplayBuffer'); responseText = '⏮️ Replay Buffer started.'; }
            else if (state === 'stop') { await obs.call('StopReplayBuffer'); responseText = '⏮️ Replay Buffer stopped.'; }
            else { await obs.call('SaveReplayBuffer'); responseText = '💾 Replay saved.'; }

            await interaction.editReply(responseText);
            await logObsAction(`🎛️ **${interaction.user.tag}** used \`/obs replay-buffer ${state}\`: ${responseText}`);
        }
    } catch (err) {
        console.error('OBS Websocket command error:', err);
        let errorMsg = err.code === 500 ? `⚠️ OBS action notice: Action failed or is already active.` : `❌ Failed to execute action: ${err.message}.`;
        await interaction.editReply(errorMsg);
    }
});


// --- TWITCH BOT SETUP ---
twitchClient.once('clientReady', async () => {
    console.log(`[Twitch Bot] Logged in as ${twitchClient.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.TWITCH_BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(twitchClient.user.id, TARGET_GUILD_ID), { body: twitchCommands });
        console.log('Twitch commands registered successfully.');
        
        startTwitchChatBridge(twitchClient);
        await syncTwitchSubscribersToDiscord(twitchClient);
        setInterval(() => {
            syncTwitchSubscribersToDiscord(twitchClient).catch(err => console.error('Error syncing subs:', err));
        }, INTERVAL_30_MIN);
    } catch (err) {
        console.error('Failed to register twitch commands:', err);
    }
});

twitchClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, user, channel } = interaction;
    
    const protectedTwitchCommands = ['obsjoin', 'twitchcategory', 'twitchname'];
    if (protectedTwitchCommands.includes(commandName) && !hasAccess(member)) {
        await logCommandUsage(interaction, { allowed: false });
        return interaction.reply({ content: '❌ Nice try, twin. You don\'t have permission to use this.', flags: [MessageFlags.Ephemeral] });
    }

    await logCommandUsage(interaction);

    async function logAction(text, channelId = LOG_CHANNEL_ID) {
        try {
            const guild = interaction.guild;
            if (guild) {
                const logChannel = await guild.channels.fetch(channelId).catch(() => null);
                if (logChannel) {
                    const embed = new EmbedBuilder().setDescription(text).setColor(EMBED_COLOR).setTimestamp();
                    await logChannel.send({ embeds: [embed] });
                }
            }
        } catch (e) {
            console.error('Failed to send log message:', e.message);
        }
    }

    if (commandName === 'link') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const twitchName = interaction.options.getString('username').trim();
        const links = loadLinks();
        links[user.id] = twitchName;
        saveLinks(links);

        await interaction.editReply(`✅ Successfully linked your Discord to Twitch account: **${twitchName}**! Running sub sync now...`);
        await logAction(`🔗 **${user.tag}** linked their Twitch account to \`${twitchName}\`.`);
        await syncTwitchSubscribersToDiscord(twitchClient);
    }

    if (commandName === 'unlink') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const links = loadLinks();
        let responseText = '';
        if (links[user.id]) {
            delete links[user.id];
            saveLinks(links);
            responseText = `🗑️ Unlinked your Twitch account. Your sub role will be dropped on the next sync cycle.`;
        } else {
            responseText = `⚠️ You don't have a linked Twitch account.`;
        }
        await interaction.editReply(responseText);
        await logAction(`unlink **${user.tag}** unlinked their Twitch account.`);
        await syncTwitchSubscribersToDiscord(twitchClient);
    }

    if (commandName === 'delete') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const count = interaction.options.getInteger('count');
        if (count < 1 || count > 100) {
            return interaction.editReply('❌ Pick a number between 1 and 100, twin.');
        }

        try {
            const deleted = await channel.bulkDelete(count, true);
            await interaction.editReply(`🧹 Cleared **${deleted.size}** messages.`);
            await logAction(`🧹 **${user.tag}** deleted **${deleted.size}** messages in <#${channel.id}>.`, CHANNELS.modActions);
        } catch (err) {
            console.error('Delete command error:', err);
            await interaction.editReply(`❌ Failed to delete messages: ${err.message}`);
        }
    }

    if (commandName === 'obsjoin') {
        const voiceChannel = member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: 'Hop in a voice channel first, twin.', flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply();

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                group: twitchClient.user.id,
                selfDeaf: false
            });

            const player = createAudioPlayer();
            let ffmpegArgs = [
                '-f', 'dshow',
                '-audio_buffer_size', '50',
                '-i', `audio=${process.env.AUDIO_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)'}`,
                '-acodec', 'libopus',
                '-b:a', '128k',
                '-ar', '48000',
                '-ac', '2',
                '-f', 'ogg',
                'pipe:1'
            ];

            let ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            ffmpegProcess.on('error', (err) => console.error('FFmpeg primary audio source failed:', err));

            const logStream = fs.createWriteStream(path.join(__dirname, 'ffmpeg_debug.log'), { flags: 'a' });
            ffmpegProcess.stderr.pipe(logStream);

            const resource = createAudioResource(ffmpegProcess.stdout, { inputType: StreamType.OggOpus });
            player.play(resource);
            connection.subscribe(player);

            player.on('error', error => console.error('Audio player error:', error));

            await interaction.editReply(`🎧 Twitch bot joined **${voiceChannel.name}**! (Audio mode active)`);
            await logAction(`🎧 **${user.tag}** used \`/obsjoin\`: Connected Twitch bot into **${voiceChannel.name}**.`);
        } catch (err) {
            console.error('OBS Join Audio Error:', err);
            await interaction.editReply(`❌ Failed to stream audio into VC: ${err.message}`);
        }
    }

    if (commandName === 'twitchcategory') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const gameName = interaction.options.getString('game');
        try {
            const gameId = await getTwitchGameId(gameName);
            await updateTwitchChannelInfo({ game_id: gameId });
            await interaction.editReply(`🟣 Twitch category updated to: **${gameName}**`);
            await logAction(`🟣 **${user.tag}** updated Twitch category to: **${gameName}**`, CHANNELS.twitchChat);
        } catch (err) {
            console.error('Twitch Category Error:', err);
            await interaction.editReply(`❌ Failed to update Twitch category: ${err.message}`);
        }
    }

    if (commandName === 'twitchname') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const title = interaction.options.getString('title');
        try {
            await updateTwitchChannelInfo({ title: title });
            await interaction.editReply(`🟣 Twitch stream title updated to: **${title}**`);
            await logAction(`🟣 **${user.tag}** updated Twitch title to: **${title}**`, CHANNELS.twitchChat);
        } catch (err) {
            console.error('Twitch Title Error:', err);
            await interaction.editReply(`❌ Failed to update Twitch title: ${err.message}`);
        }
    }
});

// Login both clients independently
masterClient.login(process.env.DISCORD_TOKEN).catch(err => console.error('Failed to login master bot:', err.message));
twitchClient.login(process.env.TWITCH_BOT_TOKEN).catch(err => console.error('Failed to login twitch bot:', err.message));
