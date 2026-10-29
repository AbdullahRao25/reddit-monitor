-- Recovered history for accounts that have gone dark.
-- One-time migration, safe to re-run:
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- Server-only access via the service-role key, like the other tables.
--
-- Why this is NOT content_items:
--
-- content_items is the checker's own record of what it saw in Reddit's public
-- listings, and the checker unions it into every check to decide what has been
-- removed since. Rows that came from somewhere else must never enter that
-- comparison: an archived item that is not in today's listing is not evidence
-- of a removal, it is just an item the archive had and the listing does not.
-- Mixing the two would manufacture removals on every check. They stay apart.
--
-- These rows are a third party's copy of public Reddit content, not Reddit's
-- records and not this monitor's observations. `source` says where each row
-- came from so that distinction survives in the data.

create table if not exists archived_items (
  account_id          uuid not null references accounts (id) on delete cascade,
  item_id             text not null,          -- Reddit fullname: t3_xxx (post) or t1_xxx (comment)
  kind                text not null check (kind in ('post', 'comment')),
  subreddit           text,
  permalink           text,
  title               text,                   -- posts only; a comment has none
  body                text,                   -- selftext / comment body as the archive captured it
  score               integer,
  removed_by_category text,                   -- 'reddit' = site-wide/admin, 'moderator', 'author', ...
  created_at          timestamptz,            -- when the item was posted
  source              text not null,          -- which archive this came from
  first_seen_at       timestamptz not null default now(),  -- first recovery that contained it
  fetched_at          timestamptz not null default now(),  -- latest recovery that contained it
  primary key (account_id, item_id)
);

create index if not exists archived_items_account_created_idx
  on archived_items (account_id, created_at desc);

alter table archived_items enable row level security;
