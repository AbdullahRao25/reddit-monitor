# Reddit Vote Tracker — targeted repair

## What this patch fixes

- Only `post_votes.csv` and `comment_votes.csv` (including Windows `(1)` copies) are accepted by the Votes upload control. Previously `saved_comments.csv` or unrelated `posts.csv` could be misidentified.
- Recognizes common older/short Reddit permalink formats in vote exports.
- Verifies an item ID matches the URL, preventing wrong vote associations.
- Adds a local, read-only CSV diagnosis command (prints only counts, headers, and skip reasons).
- Adds regression tests for the above.

## Fundamental limitation

This project uses public Reddit profile HTML for account monitoring. Other people's upvotes and downvotes are private. The Votes tab **cannot fetch them** using only a Reddit username. It intentionally imports `post_votes.csv` and `comment_votes.csv` exported by the account owner. Nothing in this patch changes that limitation. It also does not store cookies or passwords or publish/vote on Reddit.

## Install on your Windows machine

1. Back up `D:\Desktops\Project Reddit\reddit-monitor`.
2. Extract this ZIP. Copy the *contents of its* `reddit-monitor` folder into your existing project `D:\Desktops\Project Reddit\reddit-monitor`, accepting replacement of only the patch's listed files. No `.env`, database, or Reddit scraper files are included.
3. In PowerShell at the project root, run: `npm test` and `npm run test:frontend-api` and `npm run build`.
4. Restart `npm run dev` if needed. The existing `supabase/votes.sql` migration does not need to run again.
5. Request the account owner's data at https://www.reddit.com/settings/data-request and import the two vote CSV files from that archive in the account's Votes tab, in **Live API** mode.

## Diagnose a vote export locally before importing

In a PowerShell terminal at the project root:

```powershell
node scripts/diagnose-votes.mjs "C:\path\to\post_votes.csv" "C:\path\to\comment_votes.csv"
```

This never sends the file to Reddit, Supabase, ChatGPT, or a remote host. It prints only the names of the columns, counts of upvotes and downvotes, and counts of any skipped rows. It does **not** print vote links or item IDs.

If `error` is non-null or `skipped` contains unexpected entries, inspect the *column names only* and avoid uploading private voting history to support chats. Valid exports from another Reddit version may need a small parser adjustment.

## Tests in preparation

The full backend suite passed 181/181 and frontend API tests passed 14/14 in the review environment. A production Vite build could not be run in that environment because its install of Vite was incomplete; please run `npm run build` locally (it worked previously for your project).
