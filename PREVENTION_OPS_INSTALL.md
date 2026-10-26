# Prevention Operations — Additive Patch

## What this adds

- **Prevention Operations** sidebar view and dashboard: internal risk trends, manual safety plans, durable review queue, and voting-data provenance.
- **Backend** `server/src/prevention/{ops,routes}.js`: routes for overview, per-account analysis, review queue create/list/release/clear, and separate private-vote vs public-score summaries.
- **Database** `supabase/prevention_ops.sql`: `prevention_review_queue` table with RLS enabled, no browser policies.
- **Tests**: `server/test/preventionOps*.test.js` and `client/test/preventionOps-api.test.js`.

This does **not** fetch private votes from a logged-out Reddit profile, manipulate Reddit enforcement, spoof fingerprints, post, vote, or generate synthetic engagement. The optional mathematical score projection is *not* a predicted ban date.

## Installation (Windows VS Code)

1. **Back up your existing `reddit-monitor` directory.**
2. Extract this ZIP. Open its `reddit-monitor` folder and copy its contents into your existing `D:\Desktops\Project Reddit\reddit-monitor` folder. **Merge folders, but do not overwrite local modified files.** This package adds new files only. If Windows asks to replace an existing file, stop and compare.
3. In VS Code PowerShell in that project folder, run:

   ```powershell
   node scripts/install-prevention-ops.mjs --check
   node scripts/install-prevention-ops.mjs
   ```

   The installer **fails without changing files** if existing app/API integration points differ from the reviewed snapshot. It saves originals under `.prevention-ops-backup/<timestamp>` when applying. It is idempotent.
4. Supabase Dashboard → SQL Editor → New query. Paste the **entire** `supabase/prevention_ops.sql` file and click Run. It should report `Success. No rows returned`.
5. Verify:

   ```powershell
   npm test
   npm run test:frontend-api
   npm run build
   npm run dev
   ```

6. Open http://127.0.0.1:5173/ and choose **Prevention Operations** in the sidebar.

The new review queue is **not** a posting queue. Releasing a review only changes its status; it never sends a Reddit action or approves a Shield draft.

## New API endpoints

| Method | Path | What happens |
| --- | --- | --- |
| GET | `/api/prevention/overview` | Reads accounts, checks, safety holds, queued reviews from Supabase |
| GET | `/api/accounts/:id/prevention` | Reads history and computes trend/checklist |
| GET | `/api/accounts/:id/prevention/vote-sources` | Separates owner-imported vote records from public content scores |
| GET | `/api/accounts/:id/prevention/reviews` | Lists review queue |
| POST | `/api/accounts/:id/prevention/reviews` | Creates a held review row |
| POST | `/api/accounts/:id/prevention/reviews/:reviewId/release` | Marks a review released; never posts |
| POST | `/api/accounts/:id/prevention/reviews/:reviewId/clear` | Marks a review cleared; never posts |

## Safe to run continuously vs watch manually

| Feature | Safe unattended? | Requests to Reddit? |
| --- | --- | --- |
| Health trend (from stored data) | Yes | None |
| Checklist based on monitoring history | Yes | None |
| Vote-source summary | Yes | None |
| Queue list and status | Yes | None |
| Create/release/clear a manual review | Operator-initiated | None |
| **Existing** scheduled Monitor | Network-dependent; inspect Reddit usage/limits | **Yes** — existing public profile reads |

## Scope and known limits

- Reviewed the latest attached project snapshot. The snapshot does **not** contain `server/src/stealth/gate.js`. This patch intentionally doesn't overwrite or integrate an unseen newer Gate implementation.
- All *new* operations are local API + Supabase only. They do not send HTTP requests to Reddit. Existing Monitor checks continue to do so on their existing schedule.
- Reddit does not reveal who voted via a post/comment's public net score. This feature does not claim otherwise.
- Current account data needs successful Monitor checks before trend signals can be estimated. Fewer than four checks spanning at least a day result in “insufficient data.”
- Risk score is an internal estimate, not Reddit CQS; do not interpret a trend crossing as a shadowban prediction.
- No new synthetic-human posting schedule, fingerprint evasion or artificial warm-up has been added.

## Verified in this workspace

- `node --test server/test/preventionOps.test.js server/test/preventionOpsRoutes.test.js client/test/preventionOps-api.test.js`: **15/15 passed**.
- `node --check` for changed backend JavaScript and new API adapter: passed.
- JSX parsed with TypeScript parser: no syntax diagnostics for new component and updated App.
- Installer dry-run and apply tested on clean source snapshot, including repeated application.
- Full `npm test` / Vite build **not run here** because npm dependencies could not be installed (registry unavailable/timed out). Run on your local machine.
