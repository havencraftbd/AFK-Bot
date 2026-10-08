import { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType 
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// 1. Validate Environment Variables
const {
    DISCORD_BOT_TOKEN,
    DISCORD_TICKET_CHANNEL_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_TICKET_CHANNEL_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ [Config Error] Missing required environment variables in .env file!');
    console.error('Please check: DISCORD_BOT_TOKEN, DISCORD_TICKET_CHANNEL_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// 2. Initialize Supabase Admin Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});

// 3. Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
});

// Helper: Close a Ticket
async function closeTicket(ticketId, channel, closedByName) {
    try {
        // Update DB status
        await supabase
            .from('tickets')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('id', ticketId);

        // Insert system closing message for the website player
        await supabase
            .from('ticket_messages')
            .insert({
                ticket_id: ticketId,
                sender: 'staff',
                sender_name: 'HavenCraft System',
                message: `🔒 This support ticket was closed by staff (${closedByName}). Thank you for contacting HavenCraft!`
            });

        // Notify in Discord thread
        if (channel && channel.isThread()) {
            await channel.send({
                content: `🔒 **Ticket #${ticketId} has been closed by ${closedByName}.**\nThis thread will now be locked and archived.`
            });
            await channel.setLocked(true, 'Ticket resolved');
            await channel.setArchived(true, 'Ticket resolved');
        }
    } catch (err) {
        console.error(`[Close Ticket Error for ID ${ticketId}]:`, err);
    }
}

// 4. Handle Discord Ready Event
client.once('ready', async () => {
    console.log(`✅ HavenCraft Ticket Bot logged in as ${client.user.tag}`);
    console.log(`📡 Connected to Discord Channel ID: ${DISCORD_TICKET_CHANNEL_ID}`);
    console.log(`⚡ Listening for website support tickets via Supabase Realtime...`);

    // Setup Supabase Realtime Listener
    setupSupabaseRealtime();
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

            try {
                const parentChannel = await client.channels.fetch(DISCORD_TICKET_CHANNEL_ID);
                if (!parentChannel) {
                    console.error(`Parent channel not found with ID: ${DISCORD_TICKET_CHANNEL_ID}`);
                    return;
                }

                // Create a private/public thread in the support channel
                const thread = await parentChannel.threads.create({
                    name: `🎫・${ticket.ticket_code}-${ticket.user_name}`.slice(0, 100),
                    autoArchiveDuration: 1440, // 24 hours
                    type: ChannelType.PublicThread,
                    reason: `Website support ticket for ${ticket.user_name}`
                });

                // Update ticket with discord_thread_id
                await supabase
                    .from('tickets')
                    .update({ discord_thread_id: thread.id })
                    .eq('id', ticket.id);

                // Build rich embed
                const embed = new EmbedBuilder()
                    .setTitle(`🎫 New Support Ticket • \`${ticket.ticket_code}\``)
                    .setColor(0x00c896) // HavenCraft emerald
                    .setThumbnail('https://havencraft.pro/logo/logo.webp')
                    .addFields(
                        { name: '👤 Player / Username', value: `\`${ticket.user_name}\``, inline: true },
                        { name: '📧 Email Address', value: `\`${ticket.user_email}\``, inline: true },
                        { name: '📌 Subject', value: `**${ticket.subject}**`, inline: false },
                        { name: '⚡ Live Status', value: '🟢 **Open (Waiting for Staff Reply)**', inline: true }
                    )
                    .setFooter({ text: 'HavenCraft Support Bridge • Any staff reply in this thread appears live on the website!' })
                    .setTimestamp();

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`close_ticket_${ticket.id}`)
                        .setLabel('Close Ticket')
                        .setEmoji('🔒')
                        .setStyle(ButtonStyle.Danger)
                );

                await thread.send({
                    content: `📢 **New Ticket Opened!** <@&admin> / Staff can reply directly below to chat with **${ticket.user_name}** live on the website!`,
                    embeds: [embed],
                    components: [actionRow]
                });

            } catch (err) {
                console.error('[Error creating Discord thread for ticket]:', err);
            }
        })

        // B. Listen for NEW MESSAGES from PLAYER on the website
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'ticket_messages' 
        }, async (payload) => {
            const msg = payload.new;
            // Only forward player messages to Discord (staff messages originated in Discord already)
            if (msg.sender !== 'player') return;

            try {
                // Fetch the ticket to find the Discord thread ID
                const { data: ticket, error } = await supabase
                    .from('tickets')
                    .select('discord_thread_id, ticket_code')
                    .eq('id', msg.ticket_id)
                    .single();

                if (error || !ticket || !ticket.discord_thread_id) return;

                const thread = await client.channels.fetch(ticket.discord_thread_id).catch(() => null);
                if (!thread) return;

                await thread.send({
                    content: `💬 **[Website • ${msg.sender_name}]:** ${msg.message}`
                });

            } catch (err) {
                console.error('[Error forwarding player message to Discord]:', err);
            }
        })
        .subscribe((status) => {
            console.log(`[Supabase Realtime Status]: ${status}`);
        });
}

// 6. Handle Discord Staff Replies inside the Thread
client.on('messageCreate', async (message) => {
    // Ignore bots or system messages
    if (message.author.bot) return;

    // Must be inside a Discord Thread
    if (!message.channel.isThread()) return;

    const threadId = message.channel.id;

    try {
        // Check if this thread belongs to an active HavenCraft ticket
        const { data: ticket, error } = await supabase
            .from('tickets')
            .select('*')
            .eq('discord_thread_id', threadId)
            .single();

        if (error || !ticket) return; // Not a ticket thread

        // If ticket is already closed, inform staff
        if (ticket.status === 'closed') {
            await message.reply({
                content: '⚠️ This ticket is already closed. Reopen it or create a new ticket.'
            });
            return;
        }

        // Check for quick staff close command: /close
        if (message.content.trim().toLowerCase() === '/close') {
            const staffName = message.member?.displayName || message.author.username;
            await closeTicket(ticket.id, message.channel, staffName);
            return;
        }

        // Insert staff message into Supabase -> pushes in real-time to the player's browser
        const staffName = message.member?.displayName || message.author.username;
        const { error: insertError } = await supabase
            .from('ticket_messages')
            .insert({
                ticket_id: ticket.id,
                sender: 'staff',
                sender_name: staffName,
                message: message.content
            });

        if (insertError) {
            console.error('[Supabase insert staff message error]:', insertError);
            await message.react('❌');
        } else {
            // Confirm to staff with a small checkmark reaction
            await message.react('✅');
        }

    } catch (err) {
        console.error('[Error handling staff message]:', err);
    }
});

// 7. Handle Button Interactions (e.g. Close Ticket Button)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('close_ticket_')) {
        const ticketId = interaction.customId.replace('close_ticket_', '');
        const staffName = interaction.member?.displayName || interaction.user.username;

        await interaction.deferUpdate();
        await closeTicket(ticketId, interaction.channel, staffName);
    }
});

// 8. Connect Bot to Discord
client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('❌ Failed to login to Discord:', err.message);
});
