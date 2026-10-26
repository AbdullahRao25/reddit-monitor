import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { createAuth, supabaseVerifier } from './auth.js';
import { createChecker } from './checker.js';
import { config, missingConfig } from './config.js';
import { createSupabaseRepo } from './db.js';
import { createNotifier } from './notify.js';
import { createRedditClient } from './reddit.js';
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
  const reddit =
    config.redditMode === 'html'
      ? createHtmlRedditClient({
          browserOptions: config.browserExecutablePath
            ? { executablePath: config.browserExecutablePath }
            : {},
        })
      : createRedditClient(config.reddit);
  const checker = createChecker({
    repo,
    reddit,
    notify: createNotifier({ webhookUrl: config.alertWebhookUrl }),
  });
  const scheduler = createScheduler({ repo, checker, intervalMinutes: config.checkIntervalMinutes });

  // Team sign-in. On by default on any non-loopback host (see config.js).
  const auth = config.auth.enabled
    ? createAuth({
        verifyToken: supabaseVerifier(createClient, {
          url: config.supabase.url,
          anonKey: config.supabase.anonKey,
        }),
        allowedEmails: config.auth.allowedEmails,
        allowedDomain: config.auth.allowedDomain,
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

  deps = { missing, repo, reddit, checker, scheduler, auth, corsOrigins: config.allowedOrigins };
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
});
