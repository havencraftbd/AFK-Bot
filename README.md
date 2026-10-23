# 🎫 HavenCraft Website ↔ Discord Support Ticket Bot

This is the lightweight Discord bot that connects your HavenCraft website's support tickets with your Discord server.

---

## 🚀 Step 1: Run SQL in Supabase

1. Go to your **[Supabase Dashboard](https://supabase.com/dashboard)**.
2. Select your project and open **SQL Editor** from the left sidebar.
3. Click **New Query**, paste the entire contents of [`schema.sql`](./schema.sql), and click **Run**.
4. This creates:
   - `public.tickets` table
   - `public.ticket_messages` table
   - Enables Row-Level Security (RLS)
   - Enables **Supabase Realtime** so messages stream live to the browser.

---

## 🤖 Step 2: Create Discord Bot & Get Credentials

1. Go to **[Discord Developer Portal](https://discord.com/developers/applications)**.
2. Click **New Application** -> name it `HavenCraft Support` -> click **Create**.
3. Go to the **Bot** tab on the left:
   - Click **Reset Token** and copy the token (this is your `DISCORD_BOT_TOKEN`).
   - Under **Privileged Gateway Intents**, enable:
     - ✅ **Message Content Intent** (Important!)
     - ✅ **Server Members Intent**
4. Go to **OAuth2** -> **URL Generator**:
   - Under **Scopes**: select `bot`.
   - Under **Bot Permissions**: select:
     - `Send Messages`
     - `Create Public Threads`
     - `Send Messages in Threads`
     - `Manage Threads`
     - `Read Message History`
     - `Add Reactions`
   - Copy the generated URL and open it in your browser to invite the bot to your HavenCraft Discord server!
5. In your Discord server:
   - Create a text channel named `#support-tickets` (or whatever channel you want).
   - Right-click the channel and copy its ID (enable Developer Mode in Discord settings if you don't see Copy ID).
   - This is your `DISCORD_TICKET_CHANNEL_ID`.

---

## 🖥️ Step 3: Setup & Run on Your VPS

Connect to your VPS via SSH or Terminal and follow these simple steps:

### 1. Install Node.js & PM2 (if not already installed)
```bash
# Ubuntu / Debian:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

### 2. Put the Bot Files on your VPS
You can upload the `haven-discord-bot` folder to `/home/haven-bot` or `/root/haven-bot`:
```bash
cd /home/haven-bot
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Create your `.env` configuration file
```bash
cp .env.example .env
nano .env
```
Fill in your credentials:
```env
DISCORD_BOT_TOKEN=your_copied_bot_token
DISCORD_TICKET_CHANNEL_ID=your_support_channel_id
SUPABASE_URL=https://rbrrkphtobxcmnzshnqj.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_role_secret_key
```
Press `Ctrl + O` then `Enter` to save, and `Ctrl + X` to exit.

### 5. Start the Bot 24/7 with PM2
```bash
pm2 start bot.js --name "haven-ticket-bot"
pm2 save
pm2 startup
```

### 6. View Logs anytime:
```bash
pm2 logs haven-ticket-bot
```

You should see:
```text
✅ HavenCraft Ticket Bot logged in as HavenCraft Support#1234
📡 Connected to Discord Channel ID: 123456789...
⚡ Listening for website support tickets via Supabase Realtime...
```

That's it! Your 24/7 Live Ticket Bridge is running!
