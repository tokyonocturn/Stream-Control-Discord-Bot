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
    modActions: process.env.CHANNEL_MOD_ACTIONS
};

const EMBED_COLOR = 0xAAFFFF;

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
    // --- Autocomplete for source names (toggle / browser-url) ---
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'obs') return;
        const focused = interaction.options.getFocused(true);

        if (focused.name !== 'source') {
            return interaction.respond([]).catch(() => {});
        }

        try {
            if (!obs.identified) await connectOBS();

            const sub = interaction.options.getSubcommand();
            let names = [];

            if (sub === 'toggle') {
                const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
                const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
                names = sceneItems.map(item => item.sourceName);
            } else if (sub === 'browser-url') {
                const { inputs } = await obs.call('GetInputList', { inputKind: 'browser_source' });
                names = inputs.map(input => input.inputName);
            }

            const query = (focused.value || '').toLowerCase();
            const filtered = names
                .filter(name => name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(name => ({ name, value: name }));

            await interaction.respond(filtered);
        } catch (err) {
            console.error('OBS autocomplete error:', err.message);
            await interaction.respond([]).catch(() => {});
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'obs') return;

    if (!hasAccess(interaction.member)) {
        return interaction.reply({ content: '❌ Nice try, twin. You don\'t have permission to use this.', flags: [MessageFlags.Ephemeral] });
    }

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
        return interaction.reply({ content: '❌ Nice try, twin. You don\'t have permission to use this.', flags: [MessageFlags.Ephemeral] });
    }

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