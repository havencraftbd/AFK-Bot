# 🎫 HavenCraft Website ↔ Discord Support Ticket Bot


---

## Run SQL in Supabase

1. Go to your **[Supabase Dashboard](https://supabase.com/dashboard)**.
2. Select your project and open **SQL Editor** from the left sidebar.
3. Click **New Query**, paste the entire contents of [`schema.sql`](./schema.sql), and click **Run**.
4. This creates:
   - `public.tickets` table
   - `public.ticket_messages` table
   - Enables Row-Level Security (RLS)
   - Enables **Supabase Realtime** so messages stream live to the browser.

---
