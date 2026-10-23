import { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType,
    PermissionFlagsBits
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Always load .env from the bot's own directory regardless of where PM2 starts it
dotenv.config({ path: join(__dirname, '.env') });

// Process-level crash prevention: keep PM2 process running steadily
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [Bot Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [Bot Uncaught Exception]:', err);
});

// Ensure global WebSocket is available for Node 20 environment
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket;
}

// 1. Validate Environment Variables
const {
    DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID,
    DISCORD_CATEGORY_ID,
    DISCORD_TICKET_CHANNEL_ID,
    DISCORD_STAFF_ROLE_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
} = process.env;

const TARGET_ID = DISCORD_TICKET_CHANNEL_ID || DISCORD_CATEGORY_ID;

if (!DISCORD_BOT_TOKEN || !TARGET_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ [Config Error] Missing required environment variables in .env file!');
    console.error('Please check: DISCORD_BOT_TOKEN, DISCORD_CATEGORY_ID (or DISCORD_TICKET_CHANNEL_ID), SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// 2. Initialize Supabase Admin Client with explicit ws transport for Node 20
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: {
        transport: WebSocket,
        websocket: WebSocket
    }
});

// 3. Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember]
});

// Set to deduplicate tickets closed via staff in Discord or already processed
const handledClosedTickets = new Set();

// Sets to track messages originating from Discord to prevent echoing back into Discord
const discordOriginMessageKeys = new Set();
const discordOriginMessageIds = new Set();

// Helper: Close a Ticket (Triggered by Discord Staff)
async function closeTicket(ticketId, channel, closedByName) {
    try {
        const tIdNum = Number(ticketId);
        const tIdStr = String(ticketId);

        if (handledClosedTickets.has(tIdNum) || handledClosedTickets.has(tIdStr)) {
            console.log(`[closeTicket skipped - already handled] ${ticketId}`);
            if (channel && channel.isThread && channel.isThread()) {
                await channel.setLocked(true).catch(() => {});
                await channel.setArchived(true).catch(() => {});
            }
            return;
        }
        handledClosedTickets.add(tIdNum);
        handledClosedTickets.add(tIdStr);

        // Check if ticket is already marked closed or already has close message in DB
        const { data: dbTicket } = await supabase
            .from('tickets')
            .select('status')
            .eq('id', ticketId)
            .single();

        const { data: existingCloseMsgs } = await supabase
            .from('ticket_messages')
            .select('id')
            .eq('ticket_id', ticketId)
            .ilike('message', '%closed%')
            .limit(1);

        // Update DB status
        await supabase
            .from('tickets')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('id', ticketId);

        // Insert system closing message for the website player ONLY if not already present
        if (!existingCloseMsgs || existingCloseMsgs.length === 0) {
            await supabase
                .from('ticket_messages')
                .insert({
                    ticket_id: ticketId,
                    sender: 'staff',
                    sender_name: 'HavenCraft System',
                    message: `🔒 This support ticket was closed by staff (${closedByName}). Thank you for contacting HavenCraft!`
                });
        }

        // Notify and clean up in Discord
        if (channel) {
            if (channel.isThread && channel.isThread()) {
                if (channel.archived) {
                    await channel.setArchived(false, 'Closing ticket').catch(() => {});
                }

                const closeEmbed = new EmbedBuilder()
                    .setTitle('🔒 Ticket Closed by Staff')
                    .setDescription(`This ticket was resolved and closed by **${closedByName}**.\n\nAll chat history is securely saved in the database.\nThis thread is now locked and archived.`)
                    .setColor(0xff5252)
                    .setTimestamp();

                const deleteRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`delete_thread_${ticketId}`)
                        .setLabel('Delete Thread Now')
                        .setEmoji('🗑️')
                        .setStyle(ButtonStyle.Danger)
                );

                await channel.send({
                    embeds: [closeEmbed],
                    components: [deleteRow]
                }).catch(() => {});

                // Lock and Archive the thread (hidden from Discord sidebar)
                await channel.setLocked(true, 'Ticket resolved').catch(() => {});
                await channel.setArchived(true, 'Ticket resolved').catch(() => {});

                // Auto-close any duplicate sibling threads that share this exact ticket name
                if (channel.parent) {
                    try {
                        const activeThreads = await channel.parent.threads.fetchActive().catch(() => null);
                        if (activeThreads && activeThreads.threads) {
                            for (const [, th] of activeThreads.threads) {
                                if (th.name === channel.name && th.id !== channel.id) {
                                    console.log(`[Auto-closing duplicate sibling thread] ${th.name} (${th.id})`);
                                    await th.setLocked(true, 'Duplicate ticket resolved').catch(() => {});
                                    await th.setArchived(true, 'Duplicate ticket resolved').catch(() => {});
                                }
                            }
                        }
                    } catch (e) {}
                }
            } else {
                await channel.send({
                    content: `🔒 **Ticket #${ticketId} has been closed by ${closedByName}.**\n⏳ *This channel will be automatically deleted in 5 seconds...*`
                }).catch(() => {});
                setTimeout(async () => {
                    await channel.delete('Ticket resolved and closed').catch(() => {});
                }, 5000);
            }
        }
    } catch (err) {
        console.error(`[Close Ticket Error for ID ${ticketId}]:`, err);
    }
}

// Helper: Handle Ticket Closed by Player on the Website
async function handleTicketClosedByPlayer(ticket) {
    if (!ticket || !ticket.id) return;
    const tIdNum = Number(ticket.id);
    const tIdStr = String(ticket.id);

    if (handledClosedTickets.has(tIdNum) || handledClosedTickets.has(tIdStr)) {
        return;
    }
    handledClosedTickets.add(tIdNum);
    handledClosedTickets.add(tIdStr);

    try {
        let discordThreadId = ticket.discord_thread_id;
        let ticketCode = ticket.ticket_code;
        let userName = ticket.user_name;

        if (!discordThreadId) {
            const { data: dbTicket } = await supabase
                .from('tickets')
                .select('discord_thread_id, ticket_code, user_name')
                .eq('id', ticket.id)
                .single();

            if (dbTicket) {
                discordThreadId = dbTicket.discord_thread_id;
                ticketCode = dbTicket.ticket_code || ticketCode;
                userName = dbTicket.user_name || userName;
            }
        }

        if (!discordThreadId) return;

        const channel = await client.channels.fetch(discordThreadId).catch((err) => {
            console.error(`❌ Could not fetch channel/thread ${discordThreadId}:`, err.message);
            return null;
        });

        if (!channel) return;

        // Unarchive thread if it was already archived
        if (channel.isThread && channel.isThread() && channel.archived) {
            await channel.setArchived(false, 'Ticket closed notification').catch(() => {});
        }

        const closeEmbed = new EmbedBuilder()
            .setTitle(`🔒 Ticket Closed by Player • \`${ticketCode || 'HC-SUPPORT'}\``)
            .setDescription(`👤 **Player:** \`${userName || 'Player'}\` marked this ticket as **Resolved & Closed** from the website.\n\n📁 All chat history has been securely saved in the database.\nStaff may delete this thread or leave it for record keeping.`)
            .setColor(0xff9800) // Warm Amber
            .setFooter({ text: 'HavenCraft Support Bridge • Player Closed Ticket' })
            .setTimestamp();

        const deleteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`delete_thread_${ticket.id}`)
                .setLabel('Delete Thread Now')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            embeds: [closeEmbed],
            components: [deleteRow]
        }).catch((err) => {
            console.error('[Error sending player close embed]:', err.message);
        });

        // Grace period: Wait 30 seconds before locking/archiving so that
        // if player submits a star rating immediately, it appears cleanly inside the active thread!
        setTimeout(async () => {
            try {
                if (channel.isThread && channel.isThread()) {
                    await channel.setLocked(true, 'Ticket resolved by player').catch(() => {});
                    await channel.setArchived(true, 'Ticket resolved by player').catch(() => {});
                }
            } catch (e) {}
        }, 30000);

    } catch (err) {
        console.error(`[Error in handleTicketClosedByPlayer for ticket ${ticket.id}]:`, err);
    }
}

// Helper: Handle Player Star Rating Feedback (CSAT)
const handledRatingTickets = new Set();
async function handleRatingMessage(msg) {
    if (!msg || !msg.ticket_id) return;
    const ticketKey = String(msg.ticket_id);
    if (handledRatingTickets.has(ticketKey)) return;
    handledRatingTickets.add(ticketKey);

    try {
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('discord_thread_id, ticket_code, user_name')
            .eq('id', msg.ticket_id)
            .single();

        if (error || !ticket || !ticket.discord_thread_id) return;

        const channel = await client.channels.fetch(ticket.discord_thread_id).catch(() => null);
        if (!channel) return;

        // Unarchive thread if archived so the rating embed posts cleanly
        if (channel.isThread && channel.isThread() && channel.archived) {
            await channel.setArchived(false, 'Customer star rating received').catch(() => {});
        }

        // Parse star rating and comment
        // Stored format: "⭐ Player Rating: ⭐⭐⭐⭐⭐ (5/5)\n📝 Comment: ..."
        const rawText = msg.message || '';
        const ratingMatch = rawText.match(/Rating:\s*([^\n]+)/i);
        const ratingScore = ratingMatch ? ratingMatch[1].trim() : '5/5 Stars';
        const commentMatch = rawText.match(/Comment:\s*(.+)$/is);
        const comment = commentMatch ? commentMatch[1].trim() : null;

        const ratingEmbed = new EmbedBuilder()
            .setTitle(`⭐ Customer Rating Received • \`${ticket.ticket_code || 'HC-SUPPORT'}\``)
            .setDescription(`The player has rated their support experience on the website!`)
            .setColor(0xffd700) // Rich Gold
            .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(ticket.user_name || 'steve')}/100`)
            .addFields(
                { name: '👤 Player', value: `\`${ticket.user_name || 'Player'}\``, inline: true },
                { name: '🌟 Satisfaction Score', value: `**${ratingScore}**`, inline: true }
            );

        if (comment) {
            ratingEmbed.addFields({
                name: '💬 Player Feedback',
                value: `>>> ${comment}`,
                inline: false
            });
        }

        ratingEmbed.setFooter({ text: 'HavenCraft Support QA • Submitted via Website' })
            .setTimestamp();

        await channel.send({
            embeds: [ratingEmbed]
        }).catch((err) => {
            console.error('[Error sending rating embed]:', err.message);
        });

        // Lock & Archive thread after 8 seconds
        setTimeout(async () => {
            try {
                if (channel.isThread && channel.isThread()) {
                    await channel.setLocked(true, 'Ticket resolved with rating').catch(() => {});
                    await channel.setArchived(true, 'Ticket resolved with rating').catch(() => {});
                }
            } catch (e) {}
        }, 8000);

    } catch (err) {
        console.error('[Error handling rating message]:', err);
    }
}

// In-memory concurrency lock to prevent duplicate thread creation
const activeCreationLocks = new Set();

// Helper: Create Discord Channel or Private Thread for a Ticket
async function createDiscordTicketThread(ticket) {
    if (!ticket || !ticket.id) return;

    // Guard 1: Concurrency lock
    if (activeCreationLocks.has(ticket.id)) {
        return;
    }
    activeCreationLocks.add(ticket.id);

    try {
        // Guard 2: Check latest database state
        const { data: latestTicket } = await supabase
            .from('tickets')
            .select('discord_thread_id')
            .eq('id', ticket.id)
            .single();

        if (latestTicket && latestTicket.discord_thread_id) {
            return;
        }

        const target = await client.channels.fetch(TARGET_ID).catch((err) => {
            console.error(`❌ Could not fetch channel/category ${TARGET_ID}:`, err.message);
            return null;
        });

        if (!target) {
            console.error(`❌ Target Discord channel/category not found for ID: ${TARGET_ID}`);
            return;
        }

        const staffRoleIds = (DISCORD_STAFF_ROLE_ID || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);

        // Clean thread/channel name: ticket-hc-1001-username
        const cleanName = `ticket-${ticket.ticket_code}-${ticket.user_name}`
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, '-')
            .slice(0, 35);

        // Fetch initial message from ticket_messages if exists
        let initialMessageText = '';
        const { data: firstMsgs } = await supabase
            .from('ticket_messages')
            .select('message')
            .eq('ticket_id', ticket.id)
            .order('created_at', { ascending: true })
            .limit(1);

        if (firstMsgs && firstMsgs.length > 0) {
            initialMessageText = firstMsgs[0].message;
        }

        let ticketDiscordChannel = null;

        // MODE 1: Category -> Dedicated text channel
        if (target.type === ChannelType.GuildCategory) {
            const guild = target.guild;
            const permissionOverwrites = [
                {
                    id: guild.id, // @everyone role
                    deny: [PermissionFlagsBits.ViewChannel] // 🔒 Private
                },
                {
                    id: client.user.id, // Bot itself
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                }
            ];

            for (const roleId of staffRoleIds) {
                permissionOverwrites.push({
                    id: roleId,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                });
            }

            const existingChannel = guild.channels.cache.find(c => c.name === `🎫・${cleanName}` && c.parentId === target.id);
            if (existingChannel) {
                console.log(`[Reusing Existing Discord Channel] #${ticket.ticket_code} -> ID: ${existingChannel.id}`);
                ticketDiscordChannel = existingChannel;
            } else {
                ticketDiscordChannel = await guild.channels.create({
                    name: `🎫・${cleanName}`,
                    type: ChannelType.GuildText,
                    parent: target.id,
                    topic: `HavenCraft Web Ticket #${ticket.ticket_code} | User: ${ticket.user_name} (${ticket.user_email})`,
                    permissionOverwrites: permissionOverwrites
                });
            }

        } else {
            // MODE 2: Text Channel (Tickets v2 Style) -> Private Thread
            // Check if thread with this cleanName already exists under parent channel
            try {
                const activeThreads = await target.threads.fetchActive().catch(() => null);
                const existingThread = activeThreads?.threads?.find(t => t.name === cleanName);
                if (existingThread) {
                    console.log(`[Reusing Existing Discord Thread] #${ticket.ticket_code} -> ID: ${existingThread.id}`);
                    ticketDiscordChannel = existingThread;
                }
            } catch (fetchErr) {
                console.warn('[Warning checking existing threads]:', fetchErr.message);
            }

            if (!ticketDiscordChannel) {
                // PrivateThread does NOT post any announcement in the parent channel.
                ticketDiscordChannel = await target.threads.create({
                    name: cleanName,
                    autoArchiveDuration: 1440, // 24 hours
                    type: ChannelType.PrivateThread, // 🔒 100% Private Thread!
                    invitable: false,
                    reason: `HavenCraft Support Ticket #${ticket.ticket_code} for ${ticket.user_name}`
                });
            }

        }

        if (!ticketDiscordChannel) return;

        // Update database with discord thread ID
        await supabase
            .from('tickets')
            .update({ discord_thread_id: ticketDiscordChannel.id })
            .eq('id', ticket.id);

        // If thread was reused, check if it already has messages to avoid duplicate welcome embeds
        const existingThreadMsgs = await ticketDiscordChannel.messages.fetch({ limit: 1 }).catch(() => null);
        if (existingThreadMsgs && existingThreadMsgs.size > 0) {
            console.log(`[Ticket Channel Already Initialized] Skipping duplicate welcome embed for #${ticket.ticket_code}`);
            return;
        }

        // Extract discordTag if player provided one
        const discordMatch = initialMessageText.match(/(?:Discord Username|Discord):\s*`?([^\n`]+)`?/i);
        const playerDiscord = discordMatch ? discordMatch[1].trim().replace(/^@/, '') : null;

        // Extract image attachment if present in initial message
        const imgRegex = /(https?:\/\/[^\s<>"'\)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"'\)]*)?)/i;
        const imgMatch = initialMessageText.match(imgRegex);
        if (imgMatch) {
            initialMessageText = initialMessageText.replace(imgRegex, '').trim();
        }

        // Build Ticket Information Embed (For Staff Team)
        const embed = new EmbedBuilder()
            .setTitle(`🎫 New Support Ticket • \`${ticket.ticket_code}\``)
            .setColor(0x00c896) // HavenCraft emerald
            .setThumbnail('https://havencraft.pro/logo/logo.webp')
            .addFields(
                { name: '👤 Minecraft IGN', value: `\`${ticket.user_name}\``, inline: true },
                { name: '💬 Discord', value: playerDiscord ? `\`${playerDiscord}\`` : '*Not provided*', inline: true },
                { name: '📧 Email Address', value: `\`${ticket.user_email}\``, inline: true },
                { name: '📌 Subject', value: `**${ticket.subject}**`, inline: false }
            );

        if (imgMatch) {
            embed.setImage(imgMatch[1]);
        }

        if (initialMessageText) {
            embed.addFields({
                name: '💬 Initial Message',
                value: `>>> ${initialMessageText.slice(0, 1000)}`,
                inline: false
            });
        }

        embed.addFields({
            name: '⚡ Live Status',
            value: '🟢 **Open (Waiting for Staff Reply)**',
            inline: true
        });

        embed.setFooter({ text: 'HavenCraft Support Bridge • Any staff reply in this thread streams live to the player!' })
            .setTimestamp();

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`close_ticket_${ticket.id}`)
                .setLabel('Close Ticket')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger)
        );

        const pingText = staffRoleIds.length > 0 ? staffRoleIds.map(id => `<@&${id}>`).join(' ') : '@here';

        // Send embed cleanly without text banner clutter
        await ticketDiscordChannel.send({
            embeds: [embed],
            components: [actionRow]
        });

        // Ping staff roles so they get notified and added to thread, then delete ping immediately
        if (pingText) {
            ticketDiscordChannel.send({
                content: pingText,
                allowedMentions: { roles: staffRoleIds }
            }).then(msg => {
                setTimeout(() => msg.delete().catch(() => {}), 1200);
            }).catch(() => {});
        }

        console.log(`✅ [Discord Ticket Ready] #${ticket.ticket_code} -> Channel/Thread ID: ${ticketDiscordChannel.id}`);

    } catch (err) {
        console.error(`[Error creating Discord channel/thread for ticket ${ticket.ticket_code}]:`, err);
    } finally {
        // Keep lock for 30s to prevent background polling duplicate calls
        setTimeout(() => activeCreationLocks.delete(ticket.id), 30000);
    }
}

// Background Sync: Pick up any pending tickets that were missed
async function syncPendingTickets() {
    try {
        // Only pick up tickets older than 5 seconds that still have no thread ID
        const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
        const { data: pendingTickets, error } = await supabase
            .from('tickets')
            .select('*')
            .is('discord_thread_id', null)
            .lt('created_at', fiveSecondsAgo)
            .eq('status', 'open');

        if (error || !pendingTickets || pendingTickets.length === 0) return;

        for (const ticket of pendingTickets) {
            if (activeCreationLocks.has(ticket.id)) continue;
            console.log(`[Auto-Syncing Missed Ticket] #${ticket.ticket_code} (${ticket.user_name})`);
            await createDiscordTicketThread(ticket);
        }
    } catch (err) {
        // Silently retry next cycle
    }
}

// 4. Handle Discord Ready Event
client.once('ready', async () => {
    console.log(`✅ HavenCraft Ticket Bot logged in as ${client.user.tag}`);

    const target = await client.channels.fetch(TARGET_ID).catch(() => null);
    if (target) {
        if (target.type === ChannelType.GuildCategory) {
            console.log(`📂 Mode: Private Ticket Channels under Category "${target.name}" (${target.id})`);
        } else {
            console.log(`📡 Mode: Private Threads under #${target.name} (${target.id}) (Tickets v2 Style)`);
        }
    } else {
        console.warn(`⚠️ Warning: Channel/Category with ID ${TARGET_ID} not found in Discord!`);
    }

    if (DISCORD_STAFF_ROLE_ID) {
        console.log(`🛡️ Configured Staff Roles: ${DISCORD_STAFF_ROLE_ID}`);
    }
    console.log(`⚡ Connected with WebSocket support. Listening for website support tickets...`);

    // Setup Supabase Realtime Listener
    setupSupabaseRealtime();

    // Run initial sync for any unhandled tickets
    await syncPendingTickets();

    // Periodic safety sync every 15 seconds
    setInterval(syncPendingTickets, 15000);
});

// 5. Setup Supabase Realtime Subscriptions
function setupSupabaseRealtime() {
    const channel = supabase.channel('havencraft-ticket-bot-bridge');

    channel
        // A. Listen for NEW TICKETS from website
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'tickets' 
        }, async (payload) => {
            const ticket = payload.new;
            console.log(`[New Ticket Received] ${ticket.ticket_code} by ${ticket.user_name}`);
            await createDiscordTicketThread(ticket);
        })

        // B. Listen for TICKET STATUS UPDATES (e.g. ticket closed by player from website)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'tickets'
        }, async (payload) => {
            const newTicket = payload.new;
            const oldTicket = payload.old;
            if (!newTicket) return;

            // Trigger when status changed to 'closed'
            if (newTicket.status === 'closed' && (!oldTicket || oldTicket.status !== 'closed')) {
                console.log(`[Ticket Status Changed to Closed] ${newTicket.ticket_code || newTicket.id}`);
                await handleTicketClosedByPlayer(newTicket);
            }
        })

        // C. Listen for NEW MESSAGES from PLAYER and SYSTEM (e.g. Star Ratings)
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'ticket_messages' 
        }, async (payload) => {
            const msg = payload.new;
            if (!msg) return;

            // C1. Handle Player CSAT Star Rating
            if (msg.sender === 'system' && typeof msg.message === 'string' && msg.message.includes('Player Rating:')) {
                console.log(`[Player Rating Received] Ticket ID: ${msg.ticket_id}`);
                await handleRatingMessage(msg);
                return;
            }

            // C2. Prevent Discord echo loop:
            // If this staff message was sent from Discord itself, skip forwarding to Discord!
            if (msg.sender === 'staff') {
                const dedupKey = `${msg.ticket_id}:${(msg.message || '').trim()}`;
                const msgIdNum = Number(msg.id);
                const msgIdStr = String(msg.id);

                if (
                    (msg.id && (discordOriginMessageIds.has(msgIdNum) || discordOriginMessageIds.has(msgIdStr))) ||
                    discordOriginMessageKeys.has(dedupKey)
                ) {
                    return; // Already posted in Discord by staff
                }
            }

            // Only forward player messages or dashboard staff messages (ignore system/status logs)
            if (msg.sender !== 'player' && msg.sender !== 'staff') return;

            try {
                const { data: ticket, error } = await supabase
                    .from('tickets')
                    .select('discord_thread_id, ticket_code, created_at')
                    .eq('id', msg.ticket_id)
                    .single();

                if (error || !ticket || !ticket.discord_thread_id) return;

                // Deduplicate initial message for player: If this message matches initial ticket creation,
                // it is already displayed inside the embed.
                if (msg.sender === 'player') {
                    const msgTime = new Date(msg.created_at).getTime();
                    const ticketTime = new Date(ticket.created_at).getTime();
                    if (Math.abs(msgTime - ticketTime) < 3000) {
                        const { count } = await supabase
                            .from('ticket_messages')
                            .select('*', { count: 'exact', head: true })
                            .eq('ticket_id', msg.ticket_id);
                        if (count === 1) {
                            return; // Embed already has this message!
                        }
                    }
                }

                const targetChannel = await client.channels.fetch(ticket.discord_thread_id).catch(() => null);
                if (!targetChannel) return;

                // If thread was archived, unarchive to receive incoming message
                if (targetChannel.isThread && targetChannel.isThread() && targetChannel.archived) {
                    await targetChannel.setArchived(false, `Incoming ${msg.sender} message`).catch(() => {});
                }

                // Extract image URLs (including [image:URL] syntax from Admin Dashboard and direct URLs)
                const imgRegex = /\[image:(https?:\/\/[^\]]+)\]|(https?:\/\/[^\s<>"'\)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"'\)]*)?)/gi;
                const matches = [];
                let match;
                while ((match = imgRegex.exec(msg.message)) !== null) {
                    const url = match[1] || match[2];
                    if (url && !matches.includes(url)) {
                        matches.push(url);
                    }
                }

                // Extract voice audio attachment if present ([voice:URL])
                const voiceRegex = /\[voice:(https?:\/\/[^\]]+)\]/gi;
                const voiceMatch = voiceRegex.exec(msg.message);

                let cleanText = (msg.message || '')
                    .replace(/\[image:https?:\/\/[^\]]+\]/gi, '')
                    .replace(/\[voice:https?:\/\/[^\]]+\]/gi, '')
                    .replace(/(https?:\/\/[^\s<>"'\)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"'\)]*)?)/gi, '')
                    .trim();

                const sendPayload = {
                    allowedMentions: { parse: [] }
                };

                const files = [...matches];
                if (voiceMatch && voiceMatch[1]) {
                    files.push(voiceMatch[1]);
                }
                if (files.length > 0) {
                    sendPayload.files = files; // Discord.js attaches the actual media files natively!
                }

                // Clean icon and sender formatting (just the name as requested)
                const icon = msg.sender === 'staff' ? '🛡️' : '💬';

                if (cleanText) {
                    sendPayload.content = `${icon} **${msg.sender_name}:** ${cleanText}`;
                } else if (voiceMatch && voiceMatch[1]) {
                    sendPayload.content = `${icon} **${msg.sender_name}** *(Voice Message)*:`;
                } else if (files.length > 0) {
                    sendPayload.content = `${icon} **${msg.sender_name}:**`;
                } else {
                    sendPayload.content = `${icon} **${msg.sender_name}:** ${msg.message}`;
                }

                await targetChannel.send(sendPayload).catch((sendErr) => {
                    console.error('[Error sending message to Discord channel]:', sendErr.message);
                });

            } catch (err) {
                console.error('[Error forwarding message to Discord]:', err);
            }
        })
        .subscribe((status) => {
            console.log(`[Supabase Realtime Status]: ${status}`);
        });
}

// 6. Handle Discord Staff Replies inside the Ticket Channel / Thread
client.on('messageCreate', async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    const channelId = message.channel.id;

    try {
        // Check if this channel/thread belongs to an active HavenCraft ticket
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('discord_thread_id', channelId)
            .single();

        if (error || !ticket) return; // Not a ticket channel/thread

        const staffName = message.member?.displayName || message.author.username;

        // Check for quick staff close command: /close
        if (message.content.trim().toLowerCase() === '/close') {
            await closeTicket(ticket.id, message.channel, staffName);
            return;
        }

        // Check for quick staff delete command: /delete
        if (message.content.trim().toLowerCase() === '/delete') {
            await message.reply('🗑️ Deleting thread in 3 seconds...');
            setTimeout(async () => {
                await message.channel.delete('Thread deleted by staff').catch(() => {});
            }, 3000);
            return;
        }

        // If ticket is already closed
        if (ticket.status === 'closed') {
            await message.reply({
                content: '⚠️ This ticket is already closed. Use `/delete` if you want to remove this thread.'
            }).catch(() => {});
            return;
        }

        // Capture text content, attachments, and stickers
        let messageText = message.content ? message.content.trim() : '';

        if (message.attachments && message.attachments.size > 0) {
            const attachmentUrls = message.attachments.map(att => att.url).join('\n');
            messageText = messageText ? `${messageText}\n${attachmentUrls}` : attachmentUrls;
        }

        if (message.stickers && message.stickers.size > 0) {
            const stickerUrls = message.stickers.map(st => st.url).join('\n');
            messageText = messageText ? `${messageText}\n${stickerUrls}` : stickerUrls;
        }

        if (!messageText) return;

        // Track in-memory signature to prevent echoing back when Realtime triggers
        const dedupKey = `${ticket.id}:${messageText.trim()}`;
        discordOriginMessageKeys.add(dedupKey);
        setTimeout(() => discordOriginMessageKeys.delete(dedupKey), 30000);

        // Insert staff message into Supabase -> streams to website player and admin dashboard in real-time
        const { data: insertedMsg, error: insertError } = await supabase
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender: 'staff',
                sender_name: staffName,
                message: messageText
            })
            .select('id')
            .maybeSingle();

        if (insertedMsg && insertedMsg.id) {
            discordOriginMessageIds.add(Number(insertedMsg.id));
            discordOriginMessageIds.add(String(insertedMsg.id));
            setTimeout(() => {
                discordOriginMessageIds.delete(Number(insertedMsg.id));
                discordOriginMessageIds.delete(String(insertedMsg.id));
            }, 60000);
        }

        if (insertError) {
            console.error('[Supabase insert staff message error]:', insertError);
        }

    } catch (err) {
        console.error('[Error handling staff message]:', err);
    }
});

// 7. Handle Button Interactions (e.g. Close Ticket & Delete Thread Buttons)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // A. Close Ticket Button
    if (interaction.customId.startsWith('close_ticket_')) {
        const ticketId = interaction.customId.replace('close_ticket_', '');
        const staffName = interaction.member?.displayName || interaction.user.username;

        await interaction.deferUpdate().catch(() => {});
        await closeTicket(ticketId, interaction.channel, staffName);
        return;
    }

    // B. Delete Thread Button
    if (interaction.customId.startsWith('delete_thread_')) {
        const channel = interaction.channel;
        if (!channel) return;

        // Unarchive before replying or acknowledge safely to avoid error 50083
        if (channel.isThread && channel.isThread() && channel.archived) {
            await channel.setArchived(false).catch(() => {});
        }

        await interaction.reply({ content: '🗑️ Deleting thread in 2 seconds...', ephemeral: true }).catch(async () => {
            await interaction.deferUpdate().catch(() => {});
        });

        setTimeout(async () => {
            try {
                if (channel && typeof channel.delete === 'function') {
                    await channel.delete('Thread deleted by staff').catch(() => {});
                }
            } catch (e) { }
        }, 2000);
        return;
    }
});

// 8. Connect Bot to Discord
client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('❌ Failed to login to Discord:', err.message);
});
