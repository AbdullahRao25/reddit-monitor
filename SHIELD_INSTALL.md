# Account Shield — Additive Integration Patch

This ZIP is an **addition** to your existing Reddit Monitor + Preventer. It does NOT replace `redditHtml.js`, `content.js`, or any other existing scraper fixes. There is **no LinkedIn scraper**.

## What is actually implemented

- **Managed submission firewall:** preflight decisions (approve, review, hold) combining Monitor and Preventer evidence, manual community rules, active account holds, and cross-account overlap.
- **Persistent draft queue:** approve with reason, hold, cancel, recheck, and *record* that an operator separately published something. No automatic Reddit publication.
- **Automatic circuit breaker:** creates an account hold for confirmed restrictions, critical risk or 3+ newly removed items. Three consecutive collection errors produce a *review-required* hold, not a shadowban determination.
- **Manual holds & releases:** each change is logged. Releasing an account hold doesn't auto-approve previously held drafts.
- **Public-listing verification:** for a draft marked published, checks the monitored user's public listing. A missing result is **UNKNOWN**, never automatically classified as removed. This check is limited by public HTML and listing length.
- **Manual outcome log:** record observed visibility, removal or uncertainty with attribution to the operator.
- **Cross-account overlap detection:** detects duplicate texts or repeated links in the tool's managed drafts; no covert coordination.
- **Incident & recovery tracking:** create incidents, mark reviewing/appealed/resolved, and retain evidence notes and audit history.
- **Connection diagnostics:** on-demand database/browser/scheduler status using the existing status endpoint.
- **Chrome browser companion:** a Manifest V3 local dashboard launcher with live hold counts. It does **not** intercept submissions or access Reddit cookies.
- **Detection research lab:** 300 synthetic accounts and a configurable local classifier. Does not query or reproduce Reddit's private classifier.

## Step-by-step installation (Windows / VS Code)

1. **Back up** `D:\Desktops\Project Reddit\reddit-monitor` (especially recent edits from Claude).
2. Extract `Reddit_Account_Shield.zip`. Open the extracted `reddit-monitor` directory and copy **all its contents into the existing** `D:\Desktops\Project Reddit\reddit-monitor`, merging folders. These contents are only **new files**; no existing backend code should be overwritten.
3. Open a NEW VS Code PowerShell terminal and run:

   ```powershell
   cd "D:\Desktops\Project Reddit\reddit-monitor"
   node scripts/install-shield.mjs
   ```

   The installer validates the expected insertion points **before writing**, adds the integration code to your current files, and stores automatic backups in `.shield-install-backup`. Run it a second time safely: it reports that the integration is already installed.
4. Go to **Supabase → your Reddit-tool project → SQL Editor → New query**. Open `supabase/shield.sql` in VS Code, copy all of it, paste into Supabase, click **Run**. Expect `Success. No rows returned`. Keep your `.env` out of chat and Git.
5. Back in your terminal, run:

   ```powershell
   npm test
   npm run test:frontend-api
   npm run build
   npm run dev
   ```

6. Open `http://127.0.0.1:5173/#/shield`. Use **Live API** mode. Add a monitored Reddit account in Monitor first, then create a draft in Shield to see its real decision and warnings. A submission cannot be published by Shield.

### Optional Chrome companion

Open `chrome://extensions` in your AdsPower/Chrome-based browser, enable **Developer mode**, select **Load unpacked** and choose the project's `shield-extension` directory. The extension uses localhost only. It displays hold/draft counts and opens the Shield page.

## Integration routes

- `GET /api/shield/overview` — queue, holds, incidents, events and account summaries
- `GET /api/shield/audit`, `GET /api/shield/collisions`
- `POST /api/shield/drafts` — create a preflighted, auditable draft
- `POST /api/shield/drafts/:id/decision` — `recheck`, `approve`, `hold`, `cancel`, `mark_published`
- `POST /api/shield/drafts/:id/verify` — conservative listing visibility check
- `GET|POST /api/shield/drafts/:id/outcomes` — operator-supplied outcome records
- `POST /api/shield/holds`, `POST /api/shield/holds/:id/release`
- `POST /api/shield/incidents`, `PATCH /api/shield/incidents/:id`

Only the app server communicates with Supabase; all new tables use RLS with no browser policies. **The app still has no user authentication and binds to 127.0.0.1. Never expose port 4000 to the public internet.**

## Verification and scope limitations

The integration was applied twice (idempotency check) in a clean copy of the *previously uploaded* backend+Preventer snapshot. All 151 backend tests and all 11 frontend adapter tests passed in that snapshot, including the new Shield tests. New/changed JSX was parsed successfully with Babel. An actual Vite build was not possible in the Linux test container because the only available packages came from a Windows upload and lack Linux Rollup binaries; run `npm run build` locally on Windows.

**Important version note:** We have not received your newest local `redditHtml.js` and `checker.js` changes from Claude. This patch deliberately does **not overwrite** any of your active files. The small installer adds Shield code to those files at known insertion points, and aborts before changing files if an expected point is missing. It does not attempt to reproduce the latest Reddit-specific fixes. If it reports a missing insertion point, do not manually replace the file with an older version—share the error for a targeted patch.

This product cannot prevent or reverse Reddit-side bans, modify Reddit's internal classifier, bypass Reddit's enforcement, or guarantee immunity to restrictions. It can **hold submissions managed within its own workflow**, log moderation outcomes, and support policy-compliant reviews and appeals. Monitoring relies on sampled public content and may miss content that isn't accessible.
