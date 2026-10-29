import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { createAuth, supabaseVerifier } from './auth.js';
import { createChecker } from './checker.js';
import { config, missingConfig } from './config.js';
import { createSupabaseRepo } from './db.js';
import { createMemberDirectory } from './members.js';
import { createNotifier } from './notify.js';
import { ENGINES, createBrowserLauncher } from './browser/engines.js';
import { createRedditClient } from './reddit.js';
import { createRetention } from './retention.js';
import { createEscalation } from './escalation.js';
import { createHtmlRedditClient } from './redditHtml.js';
import { createScheduler } from './scheduler.js';

const missing = missingConfig();
const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));

let deps = { missing };
if (missing.length > 0) {
  console.warn(
    `Missing settings in server/.env: ${missing.join(', ')}. ` +
      'Copy server/.env.example to server/.env and fill it in. Until then the API only answers /api/status.',
  );
} else {
  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const repo = createSupabaseRepo(supabase);
  if (config.redditMode === 'html') {
    if (config.browserEngineDisabled) {
      console.log(`The optional ${config.browserEngineDisabled} reader is disabled; using standard Playwright.`);
    }
    if (config.browserEngineUnknown) {
      console.warn(
        `REDDIT_BROWSER_ENGINE="${config.browserEngineUnknown}" is not one of ${ENGINES.join(', ')}; ` +
          'falling back to "playwright", which is the easiest of them to detect.',
      );
    }
    console.log(`Reading Reddit with the ${config.browserEngine} browser engine`);
  }
  const reddit =
    config.redditMode === 'html'
      ? createHtmlRedditClient({
          manualVerification: config.manualVerification,
          createBrowser: createBrowserLauncher({
            engine: config.browserEngine,
            channel: config.browserChannel,
            profileDir: config.browserProfileDir || null,
            hidden: !config.browserVisible,
          }),
          browserOptions: config.browserExecutablePath
            ? { executablePath: config.browserExecutablePath }
            : {},
        })
      : createRedditClient(config.reddit);
  // One notifier, shared: the checker sends new alerts through it and the
  // escalation pass sends the reminders for the ones nobody acknowledged.
  const notify = createNotifier({ webhookUrl: config.alertWebhookUrl });
  const checker = createChecker({ repo, reddit, notify });
  const scheduler = createScheduler({ repo, checker, reddit, intervalMinutes: config.checkIntervalMinutes });
  const retention = createRetention({ repo, retentionDays: config.retentionDays });
  const escalation = createEscalation({ repo, notify, afterHours: config.alertEscalateHours });

  // Team sign-in. On by default on any non-loopback host (see config.js).
  const auth = config.auth.enabled
    ? createAuth({
        verifyToken: supabaseVerifier(createClient, {
          url: config.supabase.url,
          anonKey: config.supabase.anonKey,
        }),
        allowedEmails: config.auth.allowedEmails,
        allowedDomain: config.auth.allowedDomain,
        admitInvited: config.auth.admitInvited,
        allowAny: config.auth.allowAny,
      })
    : undefined;
  if (!config.auth.enabled) {
    console.warn(
      `Sign-in is off, so the API trusts every caller on ${config.host}:${config.port}. ` +
        'That is fine on localhost only.',
    );
  }
  if (config.auth.disabled && !config.isLoopback) {
    console.warn(
      `AUTH_DISABLED=true while bound to ${config.host}: this API is reachable by others with no sign-in.`,
    );
  }

  // Invites and removals run as the service role, on the same client as the
  // repo. Owners are the addresses in AUTH_ALLOWED_EMAILS: the people who can
  // already get in without an invite are the ones who may hand them out.
  const members = createMemberDirectory({
    admin: supabase.auth.admin,
    owners: config.auth.allowedEmails,
  });

  deps = { missing, repo, reddit, checker, scheduler, retention, escalation, auth, members, corsOrigins: config.allowedOrigins };
}

const app = createApp({ ...deps, clientDist: existsSync(clientDist) ? clientDist : null });

app.listen(config.port, config.host, (err) => {
  if (err) {
    console.error(`Could not start the API on ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`API listening on http://${config.host}:${config.port}`);
  if (deps.scheduler) {
    deps.scheduler.start();
    console.log(`Checking all accounts every ${config.checkIntervalMinutes} minutes`);
  }
  if (deps.retention) {
    if (config.retentionDays > 0) {
      deps.retention.start();
      console.log(`Keeping history for ${config.retentionDays} days; set RETENTION_DAYS=0 to keep everything`);
    } else {
      console.log('RETENTION_DAYS=0: history is never pruned and will grow without limit.');
    }
  }
  if (deps.escalation && config.alertEscalateHours > 0 && config.alertWebhookUrl) {
    deps.escalation.start();
    console.log(`Re-sending alerts still unacknowledged after ${config.alertEscalateHours} hours`);
  }
});
