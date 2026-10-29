-- Active shield gate: one-time additive migration; idempotent and server-access only.
-- Run it in the Supabase SQL editor, like the other migrations here.
--
-- One row per gated action that was held. A pacing hold can outlast a server
-- restart (dev restarts on every .env save), so the queue is a table and not
-- an in-memory list: an in-memory queue would drop pending actions and let the
-- whole burst fire at once on restart — the exact tell the gate exists to hide.
-- Passing actions are not queued; they are audited to shield_events instead.
create table if not exists stealth_gate_queue (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  action text not null,
  payload jsonb,
  verdict text not null default 'hold',
  reasons text[] not null default '{}',
  next_safe_at timestamptz,
  token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_reason text
);
create index if not exists stealth_gate_queue_newest on stealth_gate_queue(created_at desc);
create index if not exists stealth_gate_queue_account on stealth_gate_queue(account_id, created_at desc);
-- Pacing reads only the released rows of one account, newest first.
create index if not exists stealth_gate_queue_released on stealth_gate_queue(account_id, released_at desc)
  where released_at is not null;

alter table stealth_gate_queue enable row level security;
-- Intentionally no anon/authenticated client policies. Express service-role only.
