# Reddit Account Health

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
- **Warm-up.** A gradual low-stakes action plan for young accounts: younger
  accounts get a longer, slower schedule. Start it from the dashboard or
  `POST /api/accounts/:id/stealth/warmup/start`; each action you perform is
  logged with `POST …/warmup/action` and shown in the panel. The plan stops on
  its own once the account is mature (30 days old, 100+ karma).
- **Stealth recommendations.** When a stealth account is checked, evasion
  guidance (keep warming up, fix the fingerprint mismatch, a shadowbanned stealth
  account needs a different fingerprint, …) is appended to the usual
  compliance recommendations.

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
   paste `supabase/schema.sql` and click **Run**. For vote tracking, run
   `supabase/votes.sql` the same way.
3. **Reddit API app.** At <https://www.reddit.com/prefs/apps> choose
   "create another app…", type **script**, any redirect URI (e.g.
   `http://localhost`). The client ID is the string under the app name.
   If Reddit asks you to accept its Data API terms or register the app, do that.
4. **Configure.** Copy `server/.env.example` to `server/.env` and fill in the
   Reddit client ID/secret, a User-Agent containing your Reddit username, and
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

### Settings (`server/.env`)

| Variable | Default | |
|---|---|---|
| `CHECK_INTERVAL_MINUTES` | 60 | Minimum 15. Each check costs ~5 API requests per account; Reddit allows 100/minute. |
| `HOST` | 127.0.0.1 | The dashboard has no login, so it only listens locally by default. Don't expose it publicly without adding authentication. |
| `PORT` | 4000 | |
| `ALERT_WEBHOOK_URL` | – | Discord or Slack incoming webhook for warning/critical alerts. |

## Project layout

```
supabase/schema.sql      tables: accounts, health_checks, content_items, alerts, warmup_log
supabase/votes.sql       account_votes + the shared_account_votes view (vote tracking)
server/src/
  index.js               wiring + startup
  app.js                 REST API
  reddit.js              Reddit API client (app-only OAuth, rate limiting)
  content.js             post/comment normalization, removal classification
  votes.js               parses vote CSVs from Reddit's data export, vote summaries
  risk.js                risk factors, score, recommendations
  alerts.js              which changes raise which alerts
  checker.js             one health check: fetch → detect → score → persist → alert
  scheduler.js           periodic re-checks
  db.js                  all Supabase queries
  notify.js              Discord/Slack webhook
  stealth/fingerprint.js fingerprint validation + consistency scoring (pure)
  stealth/warmup.js      warm-up plan, maturity, action picker, stealth recs (pure)
server/test/             unit + API tests with an in-memory database and fake Reddit
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
```
