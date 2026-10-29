# Public Reddit reader reliability

The public reader is separate from the browsers used to operate Reddit
accounts. Changing its engine cannot remove account restrictions or guarantee
that Reddit will serve public pages.

At the user's request, the runtime now defaults to standard Playwright.
Patchright and Camoufox are disabled unless `REDDIT_ENABLE_OPTIONAL_ENGINES=true`.
A saved optional-engine selection and its associated executable path therefore
cannot silently reactivate those engines. SeleniumBase is not part of the app's
runtime. Manual CAPTCHA verification is also disabled by default; its dashboard
controls require an explicit `REDDIT_MANUAL_VERIFICATION=true` opt-in.

## What changed

Previously, the HTML reader treated most non-404 responses as candidate profile
or listing HTML. A missing profile card produced a generic error, but an
unrecognized listing could silently become an empty list. The status endpoint
only checked whether a browser could launch. Access failures had no shared
cooldown, and some crashed browser sessions were discarded without disposal.

The reader now classifies HTTP status before interpreting HTML. It distinguishes
rate limits, denied access, challenges, sign-in pages, server errors,
unrecognized pages, malformed supported markup, navigation failures and browser
failures. Empty feeds require a recognized Reddit empty state; hidden feeds
remain unknown rather than zero. Bare IDs or arbitrary 404 responses do not
establish valid content or a missing account. Recognized missing-user pages
still use the existing account-history rules, which cannot distinguish deletion
from a suspected shadowban.

This fixes confirmed application behavior. It does not identify the cause of a
previous live failure for which no HTTP status, safe title or response category
was captured. No live Reddit or Supabase requests were used for validation.

An ordinary Snoo illustration's `snoo-cls-` CSS prefix is no longer enough to
classify a page as a browser challenge. Local fixtures reproduced that false
positive on recognized empty and hidden feeds in both Playwright and Patchright.
Explicit challenge evidence still pauses the reader, and unrecognized pages
still fail rather than becoming empty feeds. This does not establish whether
the earlier live failure was a false positive.

## Cooldowns and resources

Rate limits and Reddit server errors pause new reads for 60 seconds by default.
Denied access, challenges and sign-in responses pause reads for five minutes.
A valid `Retry-After` duration or HTTP date is a lower bound, including a longer
server-requested pause; invalid or out-of-range values retain the default.
The reader does not retry these responses in a loop. Pending/new work fails
quickly during a pause, and at most eight page requests can wait at once.

The scheduler stops its sweep when the shared reader pauses. It does not write
the same access failure against every remaining account. Checks become eligible
again after the pause, subject to account cadence and a later scheduled or manual
check. Expiry alone does not prove recovery. Status polling never requests a
Reddit page or starts a browser. Database-only dashboard operations remain usable.
The top reader banner shows a retry deadline only during an active pause.
Historical failures retain their original deadlines, but a later unrecognized
page does not inherit an expired deadline from an earlier challenge.

Each ordinary HTML read closes its page; when enabled, manual verification retains
at most one challenge tab as described below. Crashes or cleanup failures dispose the shared
driver before a later attempt creates a fresh session. Launch and close are
coordinated. The existing browser engines and configuration are preserved.

## Stored data and diagnostics

Failed checks retain the account's last successful status, risk and karma, and
do not replace content history or create removal alerts from an unreadable page.
The failed observation remains in check history with a zero-point `reader_error`
factor containing structured diagnostics. This uses existing JSONB storage;
there is no database migration. Unknown karma in a partial valid profile does
not erase known totals; an observed zero still updates normally.

Diagnostics contain an error code, HTTP status when known, a sanitized and
length-limited page title, UTC occurrence/retry times, attempt count, a temporary
flag and an explanation. They contain no HTML bodies, cookies, tokens, browser
exception dumps or navigation URLs. The API preserves existing error strings.
Account detail adds `stale`, `last_successful_check_at` and
`lastError.diagnostics`. Failed/null-risk checks do not draw zero-risk chart points.

If reading the page document fails after an HTTP response, diagnostics retain
the observed HTTP status. A separately available browser page title is sanitized
using the same rules; a failed title lookup does not replace the original error.
The existing local check-failure log includes the same sanitized diagnostic
allowlist, so terminal logs can help investigate a failure without raw page data.

Manual check results update the account page immediately. Older in-flight detail
responses cannot replace that result, and completion clears the manual spinner
without waiting for background trend refreshes. A browser-challenge diagnosis
therefore appears consistently in the notification and account banner; it still
means the public reader could not complete the read, not that the account was
confirmed restricted.

`GET /api/status` retains its previous fields and adds `reddit.reader`:

```json
{
  "mode": "html",
  "browser": { "state": "ready" },
  "state": "paused",
  "readable": false,
  "last_success_at": "2026-10-29T10:00:00.000Z",
  "last_failure_at": "2026-10-29T11:00:00.000Z",
  "last_error": { "code": "rate_limited", "http_status": 429 },
  "paused": true,
  "retry_at": "2026-10-29T11:01:00.000Z"
}
```

The timestamps above only illustrate the response format. Readability starts as
unknown (`reddit.ok: null`) until a real supported read succeeds or fails. Browser
readiness is separate. The most recent failure remains available after recovery.
Diagnostics are process-local and reset on restart; failed check records persist
in Supabase. Restarting also resets cooldowns, so repeated restarts are not a
remedy for a denied request.

## Completing a CAPTCHA yourself

Manual CAPTCHA verification is disabled by default. To enable it later, set
`REDDIT_MANUAL_VERIFICATION=true` and restart the monitor. It requires a loopback
server with a desktop (Windows, macOS, or a Linux display); headless or remote
deployments do not expose the controls.

When enabled, the HTML reader can show its browser window and let you complete
Reddit's verification directly. The dashboard's reader banner and Settings
provide **Solve CAPTCHA / open reader**. Use that button to bring the
monitor's own verification tab forward. Keep this browser signed out of Reddit
so the monitor continues observing public visibility.

After completing the verification, click **I solved it — resume checks** in the
dashboard. Confirmation inspects the existing page once without reloading or
interacting with the CAPTCHA. It accepts only recognized public profile or feed
data on the original page, then reuses that browser session for fresh account
checks. It does not treat a button click alone as proof of access.

While a verification tab is open, automatic reads pause so they cannot replace
your tab. An explicit server `Retry-After` still applies after completion. A
normal successful confirmation requests a fresh sweep, including recently
failed accounts, while respecting paused accounts and reader rate limits.

Leaving `REDDIT_MANUAL_VERIFICATION` unset or setting it to `false` keeps the
reader headless and the manual verification controls unavailable. When enabled,
the window opens on the computer running the API. Browser session
state remains inside the monitor's separate browser and resets when it is
replaced; it is not imported from AdsPower or exposed through the API.

Opening the dashboard inside AdsPower does not move this verification to an
AdsPower profile. Complete the challenge in the monitor browser that opens.
Real Reddit access is confirmed only when a public page becomes readable;
Reddit may continue to deny access even after a user completes verification.

## Existing OAuth access

`REDDIT_MODE=oauth` selects the existing application-only `client_credentials`
client. `REDDIT_MODE=html` selects the public browser reader. There is no automatic
fallback between them, and this change does not request new account permissions.

OAuth requires an authorized Reddit API application and the existing server
settings `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT`.
Missing configuration is reported by name; no values are exposed. App approval
and actual API access must be established with Reddit. Credentials were neither
changed nor used to test live authorization during this work.

Creating an application/client ID alone does not establish API approval.
Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
requires explicit approval. For an external use case unsupported by Devvit,
follow its [access-request form](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164)
and [OAuth authentication guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).
If the HTML reader receives a verification page and no approved API app is
available, fresh observations remain unavailable. Preserve stored results and
arrange supported access before switching reader modes.

The client reads public profiles, posts/comments and content info. It has no user
session, publishes nothing and cannot read private voting history. Votes remain
owner-imported CSV data. Token validation alone is not reported as a successful
public read. OAuth uses the same cached diagnostics and fail-fast cooldowns,
validates response shapes, respects quota headers, and refreshes a rejected token
at most once. A successful read that exhausts quota records `pause_reason`
separately from the last failed-read record.

## Verify locally in VS Code

1. In the existing running development terminal, press Ctrl+C, then open a
   PowerShell terminal at `D:\Desktops\Project Reddit\reddit-monitor`.
2. Run `npm test`, then `npm run build`. Tests use local fixtures and mocked
   responses, including real installed browsers against a local fixture server.
   An unavailable optional browser engine is skipped.
3. Run `npm run dev` and open `http://127.0.0.1:5173`.
4. Open Settings. Before the first read, the reader should say it is not verified.
   Check a known public account, then inspect Settings or Account Shield for the
   observed reader state, last read times and expandable diagnostics.
5. If access fails, account details should show stale/preserved data. Inspect the
   category, HTTP status, safe title and retry time. Wait until the displayed
   retry window before requesting another check. The rest of the stored workspace
   remains available.

No new dependency, database migration or credential change is required. Monitoring
still depends on supported public access and the markup the reader recognizes;
unrecognized future formats fail safely rather than inventing health results.

## Files changed for this fix

- Backend: `server/src/redditHtml.js`, `readerErrors.js`, `reddit.js`, `checker.js`,
  `app.js`, `scheduler.js`, `index.js`, and `browser/engines.js`.
- Frontend: `client/src/App.jsx`, `components/Shield.jsx`,
  `components/ReaderStatus.jsx`, `lib/api.js`, `lib/readerStatus.js`,
  `lib/accountDetail.js`, and `styles.css`.
- Regression tests: `server/test/redditHtml.test.js`, `readerErrors.test.js`,
  `readerIntegration.test.js`, `reddit.test.js`, `browserEngines.test.js`,
  `browserEngineLive.test.js`, `client/test/reader-status.test.js`, and
  `client/test/account-detail.test.js`.
- Documentation: `README.md` and this guide.

These changes build on the existing working tree. Pre-existing changes in other
files were preserved; no credentials, schema, dependencies or generated builds
were committed.
