-- One-time migration for the Preventer. Safe to re-run.
-- Execute in Supabase SQL Editor before using the new Preventer endpoints.
-- API access remains server-only via service-role credentials.
create table if not exists prevention_profiles (
  account_id uuid primary key references accounts(id) on delete cascade,
  email_verified boolean,
  two_factor_enabled boolean,
  rules_reviewed boolean,
  notes text not null default '',
  updated_at timestamptz not null default now()
);
alter table prevention_profiles enable row level security;
