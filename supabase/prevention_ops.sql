-- Prevention Operations: operator-only review queue; zero automatic Reddit actions.
-- Additive and idempotent. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;
create table if not exists prevention_review_queue (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  draft_id uuid references shield_drafts(id) on delete set null,
  reason text not null,
  state text not null default 'held' check(state in ('held','released','cleared')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completion_reason text
);
create index if not exists prevention_review_queue_account on prevention_review_queue(account_id,created_at desc);
create index if not exists prevention_review_queue_held on prevention_review_queue(created_at desc) where state='held';
alter table prevention_review_queue enable row level security;
-- No browser access policies. The existing Express server uses the service-role key.
