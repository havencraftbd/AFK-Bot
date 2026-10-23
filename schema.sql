-- ==============================================================================
-- HavenCraft Website ↔ Discord Support Ticket System Database Schema
-- Run this script in your Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ==============================================================================

-- 1. Create Tickets Table
CREATE TABLE IF NOT EXISTS public.tickets (
    id BIGSERIAL PRIMARY KEY,
    ticket_code TEXT UNIQUE NOT NULL,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    discord_thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- 'open' or 'closed'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Ticket Messages Table
CREATE TABLE IF NOT EXISTS public.ticket_messages (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT REFERENCES public.tickets(id) ON DELETE CASCADE,
    sender TEXT NOT NULL, -- 'player' or 'staff'
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Set Replica Identity for Supabase Realtime broadcast payload integrity
ALTER TABLE public.tickets REPLICA IDENTITY FULL;
ALTER TABLE public.ticket_messages REPLICA IDENTITY FULL;

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;

-- 5. Strict Row Level Security (RLS) Policies
-- Protects player emails, usernames, and private messages from data scrapers.
-- All database queries from web users flow securely through /api/contact using service_role.

-- Drop all insecure permissive policies
DROP POLICY IF EXISTS "Public read tickets" ON public.tickets;
DROP POLICY IF EXISTS "Public insert tickets" ON public.tickets;
DROP POLICY IF EXISTS "Public update tickets" ON public.tickets;
DROP POLICY IF EXISTS "Public read ticket_messages" ON public.ticket_messages;
DROP POLICY IF EXISTS "Public insert ticket_messages" ON public.ticket_messages;
DROP POLICY IF EXISTS "Allow anon read staff messages" ON public.ticket_messages;

-- A. Tickets Table:
-- Absolutely NO public direct read, insert, update, or delete via REST API.
-- Only the backend /api/contact (with service_role) and haven-bot can access.

-- B. Ticket Messages Table:
-- Web clients can ONLY select staff messages (for instant real-time live streaming of staff replies).
-- Player messages and insertions are restricted and must flow through authenticated /api/contact.
CREATE POLICY "Allow anon read staff messages" ON public.ticket_messages
FOR SELECT TO anon, authenticated
USING (sender = 'staff');

-- 6. Add Tables to Supabase Realtime Publication
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tickets'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.tickets;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ticket_messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_messages;
    END IF;
END $$;
