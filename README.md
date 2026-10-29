# Reddit Account Health

Public-reader troubleshooting, cached health diagnostics, cooldown behavior and
verification steps: [Reader diagnostics](READER_DIAGNOSTICS.md).

Manual CAPTCHA verification and its dashboard controls are disabled by default.
To enable them later on a local desktop, set `REDDIT_MANUAL_VERIFICATION=true`
and restart the monitor. Then use **Solve CAPTCHA / open reader**, complete
verification yourself in the monitor's browser, and choose **I solved it — resume
checks**. Checks reuse that browser session. Keep it signed out of Reddit so
results reflect public visibility.

Watches your Reddit accounts the way other people see them, raises alarms when
one is shadowbanned, suspended or drifting toward it, and says what to do.

- **Backend:** Node.js + Express (`server/`)
- **Frontend:** React + Vite (`client/`)
- **Database:** Supabase / Postgres (`supabase/schema.sql`)

## How detection works

Everything is read through Reddit's API with an *application-only* token, which
sees Reddit exactly as a logged-out visitor does. No account passwords are
stored or needed.

| Signal | How it's detected |
|---|---|
| Shadowban | The profile returns "not found" to outsiders after having been visible before. (A shadowbanned account still looks normal to its owner, which is why you can't spot it while logged in.) |
| Suspension | The profile reports `is_suspended`. |
| Removed posts/comments | Recent posts/comments are re-checked through `/api/info` on every run for 30 days, so removals that happen hours after posting are caught. Posts say who removed them (moderators, AutoModerator, Reddit's spam filter, admins); comments only show `[removed]`. |
| Risk factors | Removal rate, spam-filter removals, one site dominating the account's activity, the same link posted to many subreddits, copy-pasted comments, posting bursts, account age, low/negative karma, downvoted comments, unverified email, falling karma. |

Each factor adds points to a 0–100 score: **low** (<25), **elevated** (25–49),
**high** (50–74), **critical** (75+). Shadowbanned and suspended accounts are 100.
The factor list and the points for each are in `server/src/risk.js`.

Recommendations follow Reddit's own rules and processes: confirm, appeal, check
subreddit rules, ask moderators, stop the behaviour the spam filter reacts to.
By default the tool deliberately does **not** suggest ways to avoid detection —
that is the opt-in **stealth mode** below.

### Stealth mode (opt-in per account)

Turn it on per account from the account detail page (or `PATCH /api/accounts/:id`
with `stealth_mode: true`). It layers an evasion toolkit on top of the normal
monitoring, for accounts you want to keep alive and hard to fingerprint:

- **Fingerprint.** Store a browser `userAgent` / `timezone` / `viewport` /
  `locale` for the account. A consistency score flags mismatches against what
  the account's own posting pattern implies (timezone vs. posting hours, a
  non-browser UA). `GET/PUT /api/accounts/:id/stealth/fingerprint`.
- **Stealth recommendations.** When a stealth account is checked, extra
  guidance (fix the fingerprint mismatch, pause while restricted, reduce
  activity at high risk) is appended to the usual compliance recommendations.

Proxy rotation is **not** part of this app — it's assumed you already have your
own proxy providers. The stored fingerprint is what you feed to those proxies.

### Alerts

Alerts fire on changes, not on every check: an account becoming shadowbanned,
suspended or not found; risk rising to high or to critical; new spam-filter
removals; three or more new removals since the last check; three failed checks
in a row; and an account becoming visible again. An open alert of the same type
suppresses repeats for 24 hours.

They appear on the dashboard (with a banner on every page while a critical one
is open), as desktop notifications while the dashboard is open, and optionally
in Discord or Slack via `ALERT_WEBHOOK_URL`.

### Limits worth knowing

- "Not found" can also mean the account was deleted. The dashboard can't tell
  the two apart; you can.
- An account that was never seen as visible is reported as **not found** rather
  than shadowbanned (it could be a typo, or shadowbanned since creation).
- Only the newest 100 posts and 100 comments are fetched per check (Reddit's
  listing limit). Older items that were already being tracked keep being
  re-checked for 30 days.
- The risk score is a heuristic built from public signals. It flags what Reddit
  is known to react to; it can't see Reddit's internal spam scores.

## Setup

1. **Install** (Node 20+):
   ```
   npm install
   ```
2. **Database.** Create a Supabase project, open **SQL Editor → New query**,
   paste `supabase/schema.sql` and click **Run**. Then run the optional
   migrations the same way, for the features you want: `supabase/votes.sql`
   (vote tracking), `supabase/shield.sql` (the draft queue and the audit
   trail), `supabase/preventer.sql` and `supabase/prevention_ops.sql` (the
   Preventer), and `supabase/gate.sql` (the active gate). Each is idempotent
   and safe to re-run; a feature whose migration is missing answers 503 and
   names the file.
3. **Authorized Reddit API access (OAuth mode).** Reddit requires explicit
   approval for Data API access; creating a client ID alone does not establish
   approval. Follow the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
   and, if your external app is not supported by Devvit, use the
   [access-request form](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164).
   Once approved, use the credentials for that application and the
   [Data API authentication guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).
   The existing HTML reader does not need API credentials, but a browser
   verification page means it cannot currently read the requested public data.
4. **Configure.** Copy `server/.env.example` to `server/.env` and fill in the
   approved Reddit client ID/secret for OAuth mode, a descriptive User-Agent
   containing your Reddit username, and
   the Supabase URL and **service-role** key (Project Settings → API). The
   service-role key stays on the server; the browser never talks to Supabase.
5. **Run:**
   ```
   npm run dev
   ```
   Open <http://localhost:5173>. Until everything is connected the dashboard
   shows a setup checklist explaining what's missing.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | API on :4000 (auto-restarts on change) + dashboard on :5173 |
| `npm run demo` | Same, but the API uses an in-memory store and a simulated Reddit with seven scripted accounts and three weeks of history. No `server/.env` needed; nothing is saved. |
| `npm test` | Server tests (`node:test`, no network or database needed) |
| `npm run build` then `npm start` | Production: the API on :4000 also serves the built dashboard |

### Start it on this machine (one click)

Double-click **`Start Monitor.cmd`** (or the *Reddit Monitor* shortcut on the
desktop). It installs dependencies if they are missing, rebuilds the dashboard
if `client/src` is newer than `client/dist`, starts the API on the port in
`server/.env`, and opens the browser once that port answers. The monitor runs
for as long as the window stays open; Ctrl+C or closing it stops the monitor.
Launching it a second time just reopens the browser instead of fighting over
the port.

Switches, if you call `Start Monitor.cmd` from a terminal:

| Switch | What it does |
|---|---|
| `-NoBrowser` | Start the server without opening a browser tab |
| `-Rebuild` | Force a dashboard rebuild even if it looks current |
| `-Tunnel <user@host>` | Also open the relay reverse tunnel (see `docker-compose.tunnel.yml`) |

To make the tunnel part of the one-click start, put the `user@host` target in
`scripts/relay-host.txt`; the launcher picks it up and closes the tunnel again
when it exits.

### Settings (`server/.env`)

| Variable | Default | |
|---|---|---|
| `CHECK_INTERVAL_MINUTES` | 60 | Minimum 15. Each check costs ~5 API requests per account; Reddit allows 100/minute. |
| `HOST` | 127.0.0.1 | The dashboard has no login, so it only listens locally by default. Don't expose it publicly without adding authentication. |
| `PORT` | 4000 | |
| `REDDIT_BROWSER_ENGINE` | playwright | `REDDIT_MODE=html` only. `playwright` (stock Chromium), `patchright` (patched Playwright, harder to detect) or `camoufox` (Camoufox Firefox build; its npm package currently pins an older playwright-core than this project uses, so it will not install as-is). See `server/src/browser/engines.js`. |
| `REDDIT_ENABLE_OPTIONAL_ENGINES` | false | Patchright and Camoufox stay disabled unless explicitly enabled. A saved optional-engine selection uses standard Playwright instead; its saved executable path is also ignored for that fallback. SeleniumBase is not wired into the app. |
| `REDDIT_BROWSER_CHANNEL` | – | Patchright only. Chromium channel to prefer, e.g. `chrome` (its recommendation). Blank tries `chrome` then falls back to the bundled build with a warning. |
| `ALERT_WEBHOOK_URL` | – | Discord or Slack incoming webhook for warning/critical alerts. Failed sends are retried three times; a 404 is not retried. |
| `ALERT_ESCALATE_HOURS` | 24 | Re-send an alert still unacknowledged after this many hours, for as long as it stays open. Needs `ALERT_WEBHOOK_URL`. 0 turns reminders off. |
| `RETENTION_DAYS` | 90 | Delete checks, content, gate audit events, acknowledged alerts and released gate holds older than this, once a day. An account's newest check and any open alert are always kept. Values under 45 are raised to 45; 0 keeps everything forever. |

## Project layout

```
supabase/schema.sql      tables: accounts, health_checks, content_items, alerts
supabase/votes.sql       account_votes + the shared_account_votes view (vote tracking)
supabase/gate.sql        stealth_gate_queue (the active gate's durable hold queue)
server/src/
  index.js               wiring + startup
  app.js                 REST API
  reddit.js              Reddit API client (app-only OAuth, rate limiting)
  content.js             post/comment normalization, removal classification
  votes.js               parses vote CSVs from Reddit's data export, vote summaries
  risk.js                risk factors, score, recommendations
  alerts.js              which changes raise which alerts
  checker.js             one health check: fetch → detect → score → persist → alert
  scheduler.js           periodic re-checks: jittered cadence, per-account intervals
  retention.js           deletes history past RETENTION_DAYS, once a day
  escalation.js          re-sends alerts nobody acknowledged
  periodic.js            the repeating background pass behind those two
  routeGuards.js         UUID/text/object guards every route module shares
  subreddits.js          removals grouped by community, and how concentrated they are (pure)
  export.js              the JSON bundle and CSV shaping for downloads (pure)
  db.js                  all Supabase queries
  notify.js              Discord/Slack webhook, with retries
  stealth/fingerprint.js fingerprint validation + consistency scoring (pure)
  stealth/recommendations.js  stealth-mode recommendations (pure)
  browser/engines.js     playwright / patchright / camoufox drivers for html mode
  stealth/gate.js        the active gate: pass/hold/block for one outbound action (pure)
  stealth/gateRoutes.js  the gate's routes and its queue persistence
server/test/             unit + API tests with an in-memory database and fake Reddit
  helpers.js             createMemoryRepo() + createFakeReddit()
  harness.js             withServer(): boots the API on a loopback port for route tests
server/scripts/
  demo.js                demo server: real API + checker on an in-memory store
  demoReddit.js          simulated Reddit (scripted personas, time-dependent)
client/src/
  App.jsx                Command Center shell and pages: overview, accounts, account detail
                         (risk, factors, recommendations, content, history, stealth), alerts,
                         settings
  lib/api.js             API client + mapping of API responses onto the screens' fields
  lib/demoData.js        browser-only demo dataset (Settings → Demo)
  components/Chart.jsx   SVG trend chart
  components/Communities.jsx          removals by subreddit for one account
  components/WorkspaceCommunities.jsx the same across every account (overview card)
  components/GatePanel.jsx            ask the active gate, and release held actions
  components/AccountTools.jsx         per-account check interval + exports
```
