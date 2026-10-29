# Progress saved — 29 October 2026

Work resumed at the user's request. Reader follow-up fixes are saved and
validated. Live reads have reported a browser challenge followed by unrecognized
HTTP 200 pages. The user confirmed they have no approved Reddit API app. Preserve the
existing application and working-tree changes.

## Project and safeguards

- Workspace: `D:\Desktops\Project Reddit`; active Git project: `reddit-monitor`.
- React/Vite client, Express/Node 22 server, Supabase persistence/authentication.
- Read parent `CLAUDE.md` and `.ignore` for live paths and project conventions.
  Skip backups, archives, dependency/build output and real credential files.
- The project already had extensive uncommitted changes before this work.
  They were preserved. No commits, credential changes, dependency changes or
  database migrations were made for the reader fix.
- Code changes are saved in the working tree. Do not reset or checkout files
  to obtain a clean baseline.

## Implemented reader improvements

- HTML reader classifies rate limits, access denial, browser challenges, login
  pages, server failures, unexpected markup, parsing errors, navigation failures
  and browser failures. Transport errors take precedence over HTML markers.
- Unexpected listings are not accepted as empty. Recognized empty/hidden feeds
  remain supported; malformed content cards fail before overwriting metadata.
  Missing-user classification requires recognized Reddit evidence.
- Structured diagnostics contain sanitized title, HTTP status when available,
  error code, occurrence/retry times, attempt count and explanation. No raw HTML,
  tokens, cookies or browser exception dumps are exposed.
- Access failures create fail-fast cooldowns; valid `Retry-After` is respected.
  Invalid/out-of-range retry headers retain a default cooldown. Queue is bounded.
- Scheduler stops sweeps during a shared reader pause and exposes retry state.
- Browser/page cleanup, crash recovery, launch/close coordination and a narrow
  Patchright partial-initialization leak were fixed.
- Status polling uses cached observations without reading Reddit or launching a
  browser. Browser/authorization readiness is separate from real readability.
- Failed checks preserve prior status, karma, risk and content. Error metadata
  uses the existing factors JSONB field, requiring no schema change.
- Existing OAuth client now validates payloads, reports cached diagnostics,
  respects cooldown/quota headers, and bounds token-refresh attempts. It does
  not silently replace HTML access. Private votes remain owner-imported CSVs.
- Settings/Shield and account pages show reader status, retry details, stale
  results and historical failure diagnostics. Unknown/failed scores are not
  displayed or plotted as healthy zeroes.

See `READER_DIAGNOSTICS.md` for behavior, setup and the full original changed-file
list. Main files include `server/src/redditHtml.js`, `readerErrors.js`, `reddit.js`,
`checker.js`, `app.js`, `scheduler.js`, `index.js`, `browser/engines.js`, and the
client's App, ReaderStatus, API/status helpers, Shield and styles.

## Most recent user screenshot and follow-up fix

The screenshot showed an old generic failure banner, a current browser-verification
toast, and a lingering “Checking…” button. This does not establish a shadowban.

A frontend race was confirmed: AccountDetail accepted out-of-order GET responses,
did not immediately consume the completed manual-check result, and could retain
an old `checking:true` snapshot. Root manual completion also waited for background
list/trend refreshes.

Fixed in `client/src/App.jsx` with new `client/src/lib/accountDetail.js` and
`client/test/account-detail.test.js`:

- Completed manual results immediately update the account banner/diagnostics.
- Request-version guards reject stale detail/list responses.
- Manual spinner completion does not wait for background trend refreshes.
- Checking state for another account is not cleared by an earlier completion.
- A GET that has caught up to the completed check remains authoritative for
  later account edits or newly started checks.
- Header distinguishes “Last attempt” from “Last successful check”.

An isolated Playwright regression used fully mocked APIs and blocked external
requests. Before the fix, delayed GETs restored the old generic error and spinner.
After the fix, the current challenge and retry appeared immediately, the spinner
cleared, and releasing the late old GET did not roll back the result. Known karma
and risk remained intact. No live Reddit calls were made by this regression.

## Validation before resumption

After the follow-up UI fix:

- `npm test`: exit 0; 373 server tests passed, 1 skipped; 51 client tests passed;
  zero failures. Total: 424 passed, 1 skipped.
- The skipped test is the optional Camoufox live-browser fixture because its
  package is unavailable. Playwright and Patchright local-fixture checks passed.
- `npm run build`: exit 0. Existing large-bundle warning remains.
- Focused account-detail/reader tests: 15 passed.
- Whitespace check passed with Windows CRLF-aware Git settings.

The final build process finished successfully before the user requested this pause.

## Observations before resumption

Last observed local services were already running on `127.0.0.1:5173` (dashboard)
and `127.0.0.1:4000` (API). Do not start duplicate servers without checking ports.
Services were not stopped by this pause. `/api/health` and the frontend responded
200; protected APIs correctly required authentication. An isolated browser verified
the configured email/GitHub login screen without runtime errors. Automatic opening
of a visible browser window was blocked by the environment policy.

The real access problem remains unresolved: the user's latest check was classified
as `browser_challenge`. The screenshot alone cannot confirm the raw response or
rule out a classification false positive. The monitoring reader is separate from
the browsers used to operate accounts. Do not claim that changing account
fingerprints or browser engines will remove this restriction.

A user question is pending: in Settings → Reader diagnostics, what HTTP status,
safe page title and retry time are shown? Obtain only those safe fields, not tokens
or credentials. Also note the reader mode when available.

On resumption:

1. Incorporate any supplied diagnostics and confirm the refreshed account page
   shows the current failure and stops “Checking…” after completion.
2. Investigate the actual supported-access issue using those observations. Do not
   suppress failures, invent healthy data, bypass challenges or weaken workspace
   authentication. The existing OAuth route requires authorized configuration and
   must not be enabled or switched silently.
3. Keep tests fixture-based. Live Reddit/Supabase success has not been verified by
   the agent, and authenticated end-to-end testing requires the user's session.

## Resumed follow-up — 29 October 2026

Local services were stopped when this turn began. Started the saved application
with `npm run dev` (tool session `16704`); dashboard `127.0.0.1:5173` and API
`127.0.0.1:4000` respond successfully. `/api/status` and `/api/accounts` correctly
return 401 without the user's session. Startup confirms HTML mode / Patchright.
Do not start duplicates without checking ports; recheck service availability
in a future session.

### Additional fixes and evidence

- Removed `snoo-cls-` as sole challenge evidence: ordinary Snoo SVG/CSS on a
  recognized empty or hidden feed was falsely pausing the reader. A real-browser
  local fixture reproduced this failure in both Playwright and Patchright before
  the fix; both now pass. Explicit challenge text, form and CAPTCHA controls
  still pause the reader, and unknown pages still fail safely.
- Preserved an observed HTTP status after later document, settle or browser
  failures. Optional separately readable titles use the existing sanitizer.
  A failed title lookup does not replace the original error. Definitive HTTP
  access/rate-limit/server errors retain precedence and cooldowns.
- The existing failed-check warning now includes the same sanitized diagnostic
  allowlist as stored check records/API responses. No raw HTML, cookies, tokens
  or browser exception text is added to logs.
- Added unit, stored-check/API and real-browser fixture coverage. Changed files
  this turn: `server/src/redditHtml.js`, `server/src/checker.js`,
  `server/test/redditHtml.test.js`, `server/test/readerIntegration.test.js`,
  `server/test/browserEngineLive.test.js`, `README.md`, `READER_DIAGNOSTICS.md`
  and this handoff. Existing changes in all other files were preserved.

### Verified current access failure

The normally running application's scheduled check after the final source
reload logged these safe fields:

```json
{
  "code": "browser_challenge",
  "http_status": 200,
  "page_title": "Reddit - Prove your humanity",
  "occurred_at": "2026-10-29T16:02:19.803Z",
  "retry_at": "2026-10-29T16:07:19.803Z",
  "attempts": 1
}
```

This confirms the current reader is receiving a verification page even after
the CSS false-positive fix. It does not establish account restrictions or the
specific signal causing verification. The prior question requesting safe
diagnostics is resolved; do not ask for those same fields again.

The user answered: **No approved app yet.** Do not silently switch to OAuth or
ask for secret values in chat. Updated setup documentation with Reddit's current
approval/request and authentication references. Supported API access requires
the user to obtain approval; no request was submitted on their behalf.

### Final validation and next step

- Final `npm test`: exit 0; 378 server tests passed, 1 skipped; 51 client tests
  passed. Total: **429 passed, 1 skipped, zero failures**.
- The optional Camoufox browser test skips because its package is unavailable.
  Playwright and Patchright local fixture tests passed.
- `npm run build`: exit 0; existing large-bundle warning remains. This preceded
  the final server-only logging addition; the frontend has not changed since.
- Independent read-only review found no blocking issues in the reader fix.
- Tests use local fixtures; the regular app's scheduled reads independently
  confirmed the live failure above. No successful live reader check or
  authenticated UI verification has been established.
- No credentials, dependencies, database migrations, commits or deployments
  were changed by this turn.

Next work depends on supported access becoming available or new observations
from the user's signed-in session. The code fixes are complete; the real access
restriction remains unresolved. Keep prior account observations intact and
honor cooldowns. No challenge bypass, hidden mode switch or authentication
weakening has been implemented.

## AdsPower workflow clarification — 29 October 2026

The user said the tool worked before scraping was added and asked whether to
reverse that change. Read-only Git review found no saved pre-scraping revision:
the earliest commit `b49b4ab` already contains both HTML and OAuth readers.
OAuth remains selectable through `REDDIT_MODE=oauth`; switching is configuration
only, but still requires approved API credentials. No rollback, reader-setting
change or credential inspection was performed. Avoid a broad reset of the
extensive working-tree changes.

The user explicitly selected **Open the dashboard inside AdsPower** rather than
having the monitor read through AdsPower profiles. This requires opening
`http://127.0.0.1:5173` in the chosen AdsPower profile on the same PC, signing into
the monitor there and selecting Live mode. The profile has its own login/browser
storage. No AdsPower Local API, profile automation, account mapping or browser
attachment is needed for this workflow. The profile's proxy does not change
the separate server-side reader's Reddit connection or resolve its challenge.

AdsPower was not observed running under its usual process names or listening
on the default API port 50325; the API is not needed for dashboard-only use.
Official proxy setup reference: https://help.adspower.com/docs/proxy_types.
The monitor's existing services were still listening on 5173 and 4000.

## Screenshot explanation and stale retry fix — 29 October 2026

The user supplied a top-banner screenshot saying "Page not recognized" with
the old retry time still visible. The running application's later logs show
`unexpected_page`, HTTP 200, `page_title: null`, at
`2026-10-29T16:07:27.142Z` and `16:07:44.074Z`. These pages lacked a recognizable
profile card. Their exact cause is unknown; do not describe these later reads
as confirmed challenges or account restrictions. The earlier separate challenge
observation remains valid.

Both failures inherited `retry_at: 2026-10-29T16:07:19.803Z` from the preceding
challenge even though it had expired. Fixed two reporting issues:

- `server/src/redditHtml.js` clears an expired retry deadline before classifying
  a new response failure. The new failure must establish its own cooldown.
- `client/src/lib/readerStatus.js` shows a retry deadline in the top banner only
  when the server reports an active pause, while retaining historical diagnostics
  and the unavailable warning after expiry.

Added regressions in `server/test/redditHtml.test.js` and
`client/test/reader-status.test.js`. The backend regression failed before the
fix and passes afterward. Final `npm test`: 379 server + 52 client tests passed,
1 optional Camoufox test skipped; total **431 passed, zero failures**. Final
`npm run build` passed with the existing bundle-size warning. CRLF-aware tracked
source/test whitespace check passed.

Explain to the user: the reader received a page it could not interpret as
account data; stored observations remain available, and "Refresh status" only
reloads cached diagnostics. The timestamp correction does not resolve the real
read failure. No reader-mode switch, AdsPower integration or credential changes
were made. The already-running dev service automatically reloads the source.

## Manual human verification implemented — 29 October 2026

The user explicitly said they are willing to solve the CAPTCHA themselves.
Implemented that workflow; it is authorized and must not be mistaken for an
automatic CAPTCHA solver. AdsPower remains dashboard-only.

### Direct live observation

A single diagnostic navigation after the reader cooldown, at
`2026-10-29T16:39:23.554Z`, confirmed HTTP 200 with the title
`Reddit - Prove your humanity`, no profile/listing cards, and explicit human
verification evidence in both the initial response and the rendered document
at 0, 6 and 12 seconds. The page had completed loading by 6 seconds and remained
a challenge. No challenge interaction or reload was automated. Only safe
structure summaries were printed; the temporary observation script was removed.

### New workflow

- On this loopback Windows desktop, HTML mode now opens the configured reader
  browser visibly. This is the same isolated session used for monitoring.
  Desktop capability is determined in `config.js` through
  `manualVerificationAvailable`; headless/remote hosts stay unsupported and
  `REDDIT_MANUAL_VERIFICATION=false` disables the feature.
- A challenge tab is retained for the human, at most one at a time. Automated
  reads and sweeps pause while it is open so they cannot replace it.
- The reader banner and Settings show **Solve CAPTCHA / open reader** and
  **I solved it — resume checks**. The first focuses the retained tab without a
  new request. The second reads the existing DOM once and requires recognized
  public data at the original origin/path. Profile and populated/empty/hidden
  listing pages are supported. A button click alone does not verify access.
- Successful confirmation retains the browser session/cookies for future
  checks. It clears the synthetic challenge pause but preserves any future
  explicit server `Retry-After`, represented separately as `pause_reason`.
- After confirmation the UI requests an explicit forced sweep through the
  normal check pipeline, so recently failed accounts are rechecked immediately.
  Paused accounts, shared reader pauses, serialization and normal request pacing
  remain enforced. Scheduled runs retain the ordinary account cadence.
- New authenticated endpoints: `POST /api/reader/verification/open` and
  `POST /api/reader/verification/complete`. No credentials, HTML, cookies or
  arbitrary navigation URLs are returned. No AdsPower session is imported.
- Keep the monitor browser signed out of Reddit to preserve the public view.
  Session state resets when that browser is replaced or the service restarts.

### Changed files for this feature

`server/src/redditHtml.js`, `readerVerification.js`, `app.js`, `config.js`,
`index.js`, `scheduler.js`, `server/.env.example`, `client/src/App.jsx`,
`client/src/components/ReaderStatus.jsx`, `client/src/lib/api.js`, plus
`server/test/readerVerification.test.js`, `readerVerificationRoutes.test.js`,
`manualVerificationLive.test.js`, `scheduler.test.js`,
`client/test/reader-verification-api.test.js`, README and diagnostics docs.
All pre-existing working-tree changes remain preserved; no commit, migration,
dependency installation or real credential-file change was made.

### Final validation and remaining user action

- Final `npm test`: exit 0, 411 server + 57 client tests passed. Total
  **468 passed, 1 optional Camoufox test skipped, zero failures**.
- `npm run build`: exit 0, existing bundle-size warning remains.
- Real Chromium local-fixture test proves the challenge tab stays open, the
  monitor performs no human action, simulated manual completion retains a
  cookie in the same browser, and a subsequent public read succeeds without
  another browser launch.
- Isolated Chrome/Vite UI smoke with mocked APIs and external requests blocked
  covered unfinished/failed/successful verification, busy buttons, immediate
  forced sweep, and an already-readable opening. No live account data was used.
- Independent review found and confirmed fixes for explicit Retry-After
  preservation and empty/hidden listing verification. No remaining blocking
  findings. Tracked-source CRLF-aware whitespace check passed.
- Dashboard/API remain running on 5173/4000 (development session 16704).

The user must now refresh the dashboard, open the reader using its new button,
solve the actual Reddit challenge, and confirm/resume in the dashboard. Live
Reddit recovery has not yet been established: do not claim that verification
has already succeeded or that it guarantees Reddit will grant access. Finish
the real follow-up using the user's result, preserving stored observations
if another challenge or read failure occurs.

## Optional browser engines shut down — 29 October 2026

The user explicitly asked to shut down SeleniumBase, Camoufox and Patchright,
which they associated with the reader problems. Implemented a reversible
default-off runtime guard, preserving their code without uninstalling packages
or discarding any unrelated working-tree changes.

- `selectRuntimeEngine` in `server/src/browser/engines.js` returns standard
  Playwright unless optional engines receive an explicit boolean opt-in.
- `config.js` uses `REDDIT_ENABLE_OPTIONAL_ENGINES=true` as that opt-in. Without
  it, the saved `REDDIT_BROWSER_ENGINE=patchright` no longer activates Patchright.
  When a saved optional engine is disabled, its saved executable override is
  ignored so Playwright uses its own installed Chromium.
- Startup now logs that the optional selection is disabled and confirms
  `Reading Reddit with the playwright browser engine`. No real `.env` contents
  were inspected or changed. `server/.env.example` and reader docs were updated.
- SeleniumBase was never wired into this Node app, and no matching Python
  process was running. No Camoufox process was running. Patchright was the
  selected engine before this change.
- Stopped monitor-owned browser processes identified by their unique
  `--user-data-dir=.../reddit-monitor-...` arguments and browser-only descendants.
  AdsPower and ordinary browser windows were preserved. A final scoped rescan
  was performed after the switch. No generic browser/process-wide kill was used.
- Kept the user-authorized manual CAPTCHA flow. It now uses standard Playwright
  and still requires the human to complete any actual challenge.
- Changed files this turn: `server/src/browser/engines.js`, `config.js`,
  `index.js`, `server/test/browserEngines.test.js`, `server/.env.example`, README,
  diagnostics guide and this handoff.
- Validation: **115 targeted reader/authentication tests passed**, zero skipped
  or failed. This included a real standard-Chromium local fixture proving
  manual verification session continuity. Optional live engine tests were not
  run, so no disabled engine was relaunched for validation.
- Dashboard/API still respond on 5173/4000; protected status still returns 401
  without a session. The full 468-test suite and client build from the preceding
  feature remain the last complete-suite validation; this turn is server-only
  and adds three focused engine-selection tests.

This confirms shutdown and baseline runtime selection, not successful live
Reddit recovery. Continue from the next actual reader observation rather than
claiming the engine change guarantees access.

## Manual CAPTCHA flow disabled — 29 October 2026

The user explicitly asked to shut down the CAPTCHA feature for now. This
supersedes the earlier request to enable manual solving.

- `manualVerificationAvailable` now requires explicit
  `REDDIT_MANUAL_VERIFICATION=true`; unset/blank/false keeps it off even on
  this desktop. Effective configuration was verified using only safe output:
  `manualVerification:false`, `engine:playwright`.
- Stopped the monitor-owned visible Playwright browser and its owned browser
  descendants (two remaining processes). Ownership was checked through the
  API PID and the unique Playwright temporary-profile argument. AdsPower's
  eight processes remained running; unrelated browsers were preserved.
- The reader now runs standard Playwright in its ordinary headless mode.
  Manual solve/resume buttons disappear after status refresh; no verification
  tab is retained or reopened. Existing read failures are still reported.
- No real `.env` file was inspected or changed. Updated `.env.example`, README
  and diagnostics docs to reflect the default-off manual workflow.
- Updated capability regression; all six verification-route tests passed.
  No browser was launched by these fixture tests. No frontend source changed.
- Keep both optional browser engines and manual CAPTCHA flow off unless the
  user later requests re-enabling them. Live Reddit access remains unconfirmed.

