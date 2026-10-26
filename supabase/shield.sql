-- Account Shield: one-time additive migration; idempotent and server-access only.
-- No Reddit credentials or browser sessions are stored.
create table if not exists shield_holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  reason text not null, code text not null default 'manual', source text not null default 'operator',
  created_at timestamptz not null default now(), released_at timestamptz,
  released_reason text
);
create unique index if not exists shield_one_active_hold on shield_holds(account_id) where released_at is null;
create index if not exists shield_holds_newest on shield_holds(created_at desc);

create table if not exists shield_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  subreddit text not null, kind text not null check(kind in ('post','comment')),
  title text not null default '', body text not null default '', url text not null default '',
  rules_text text not null default '',
  state text not null check(state in ('review','approved','held','cancelled','published')) default 'review',
  last_decision jsonb not null default '{}'::jsonb,
  permalink text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists shield_drafts_newest on shield_drafts(created_at desc);
create index if not exists shield_drafts_account on shield_drafts(account_id,created_at desc);

create table if not exists shield_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references accounts(id) on delete cascade,
  draft_id uuid references shield_drafts(id) on delete set null,
  event_type text not null, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists shield_events_newest on shield_events(created_at desc);

create table if not exists shield_outcomes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  draft_id uuid not null references shield_drafts(id) on delete cascade,
  visibility text not null check(visibility in ('visible','removed','unknown')),
  note text not null default '',
  source text not null default 'manual',
  created_at timestamptz not null default now()
);
create index if not exists shield_outcomes_draft on shield_outcomes(draft_id,created_at desc);

alter table shield_holds enable row level security;
alter table shield_drafts enable row level security;
alter table shield_events enable row level security;
alter table shield_outcomes enable row level security;
-- Intentionally no anon/authenticated client policies. Express service-role only.

create table if not exists shield_incidents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  summary text not null,
  notes text not null default '',
  status text not null default 'open' check(status in ('open','reviewing','appealed','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shield_incidents_newest on shield_incidents(created_at desc);
alter table shield_incidents enable row level security;
