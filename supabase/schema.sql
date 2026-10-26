-- Reddit account health monitor - database schema.
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement is idempotent.

create extension if not exists pgcrypto;

-- One row per monitored Reddit account.
create table if not exists accounts (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null,
  label               text,
  notes               text,
  paused              boolean not null default false,
  status              text not null default 'pending'
                      check (status in ('pending', 'active', 'shadowbanned', 'suspended', 'not_found', 'error')),
  risk_score          integer check (risk_score between 0 and 100),
  risk_level          text check (risk_level in ('low', 'elevated', 'high', 'critical')),
  link_karma          integer,
  comment_karma       integer,
  -- Posts/comments from the last 30 days seen on the latest check, and how
  -- many of them were removed.
  items_sampled       integer,
  items_removed       integer,
  last_checked_at     timestamptz,
  -- Last time the profile was publicly visible. A later "not found" with this
  -- set means shadowban; without it, the username may simply be wrong.
  last_seen_active_at timestamptz,
  created_at          timestamptz not null default now()
);
create unique index if not exists accounts_username_key on accounts (lower(username));

-- Stealth mode: per-account opt-in for the evasion layer (fingerprint
-- management + warm-up scheduler). When ON, the dashboard shows stealth
-- recommendations in addition to the default compliance-oriented ones.
alter table accounts add column if not exists stealth_mode boolean not null default false;
alter table accounts add column if not exists fingerprint jsonb;
-- The early-risk level from the last check, so an alert can tell whether the
-- level went up (and fire on the escalation to critical, not just the first
-- crossing).
alter table accounts add column if not exists early_risk_level text check (early_risk_level in ('low', 'elevated', 'high', 'critical'));

-- Warm-up log: one row per warm-up action performed by the scheduler.
create table if not exists warmup_log (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  action          text not null,
  performed_at    timestamptz not null default now()
);
create index if not exists warmup_log_account_idx on warmup_log (account_id, performed_at desc);

-- One row per health check run (history for charts and trend detection).
create table if not exists health_checks (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references accounts (id) on delete cascade,
  checked_at         timestamptz not null default now(),
  status             text not null,
  link_karma         integer,
  comment_karma      integer,
  account_created_at timestamptz,
  has_verified_email boolean,
  items_sampled      integer not null default 0,
  items_removed      integer not null default 0,
  newly_removed      integer not null default 0,
  risk_score         integer,
  risk_level         text,
  factors            jsonb not null default '[]',
  recommendations    jsonb not null default '[]',
  error              text
);
create index if not exists health_checks_account_idx on health_checks (account_id, checked_at desc);

-- Stealth mode: the early shadowban risk assessment (score, level, and the
-- top signal) computed on each check, so the dashboard can chart it and
-- fire an early-warning alert before the account is actually shadowbanned.
alter table health_checks add column if not exists early_risk jsonb;

-- Posts and comments seen on each account, re-checked so removals that
-- happen after posting are caught.
create table if not exists content_items (
  id                  text primary key,          -- Reddit fullname: t3_xxx (post) or t1_xxx (comment)
  account_id          uuid not null references accounts (id) on delete cascade,
  kind                text not null check (kind in ('post', 'comment')),
  subreddit           text,
  permalink           text,
  title               text,
  excerpt             text,
  url_domain          text,
  link_url            text,
  score               integer,
  created_at          timestamptz not null,
  removal_status      text not null default 'visible',
  removed_by_category text,
  first_seen_at       timestamptz not null default now(),
  last_checked_at     timestamptz,
  removal_detected_at timestamptz
);
create index if not exists content_items_account_idx on content_items (account_id, created_at desc);

create table if not exists alerts (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts (id) on delete cascade,
  created_at      timestamptz not null default now(),
  severity        text not null check (severity in ('info', 'warning', 'critical')),
  type            text not null,
  message         text not null,
  details         jsonb not null default '{}',
  acknowledged_at timestamptz
);
create index if not exists alerts_account_idx on alerts (account_id, created_at desc);
create index if not exists alerts_open_idx on alerts (created_at desc) where acknowledged_at is null;

-- The browser never talks to Supabase directly: only the Node server does,
-- using the service-role key, which bypasses RLS. Enabling RLS with no
-- policies means the public anon key can read nothing, even if it leaks.
alter table accounts      enable row level security;
alter table health_checks enable row level security;
alter table content_items enable row level security;
alter table alerts        enable row level security;
alter table warmup_log    enable row level security;
