-- Vote history imported from each account's Reddit data export
-- (post_votes.csv / comment_votes.csv). One-time migration, safe to re-run:
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- Server-only access via the service-role key, like the other tables.

create table if not exists account_votes (
  account_id    uuid not null references accounts (id) on delete cascade,
  item_id       text not null,          -- Reddit fullname: t3_xxx (post) or t1_xxx (comment)
  kind          text not null check (kind in ('post', 'comment')),
  direction     text not null check (direction in ('up', 'down')),
  subreddit     text,
  permalink     text,
  title         text,                   -- from the permalink's slug; the export has no titles
  first_seen_at timestamptz not null default now(),  -- first import that contained this vote
  updated_at    timestamptz not null default now(),  -- latest import that contained it
  primary key (account_id, item_id)
);
create index if not exists account_votes_item_idx on account_votes (item_id);
alter table account_votes enable row level security;

-- Votes on items that more than one monitored account voted on.
-- security_invoker keeps the table's RLS in force for whoever queries the
-- view. Without it the view runs as its owner, bypasses RLS, and would hand
-- every vote to anyone holding the public anon key.
create or replace view shared_account_votes with (security_invoker = true) as
  select v.*
  from account_votes v
  where exists (
    select 1 from account_votes o where o.item_id = v.item_id and o.account_id <> v.account_id
  );
revoke all on shared_account_votes from anon, authenticated;
