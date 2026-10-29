// The Express harness the route tests share: boot createApp on a loopback
// port, hand the test a `call`, and close the server whatever happens.
//
// This lives apart from helpers.js on purpose. helpers.js is imported by the
// pure-function tests as well, and a static `import { createApp }` there would
// pull Express into all of them — test/preventer.test.js even skips itself when
// Express is absent, which it could no longer do.

import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { silentLog } from './helpers.js';

/**
 * The dependency set createApp needs, with inert doubles for the
 * collaborators the routes touch but a route test does not exercise.
 *
 * Anything passed in wins, so a test that needs one of them to record calls or
 * to misbehave passes its own.
 */
export function routeDeps(deps = {}) {
  return {
    log: silentLog,
    reddit: { verify: async () => {} },
    checker: { isChecking: () => false, checkAccount: async () => null },
    scheduler: {
      trigger: () => true,
      status: () => ({ running: false, lastRunAt: null, nextRunAt: null, intervalMinutes: 60 }),
    },
    ...deps,
  };
}

/**
 * Boots the API and runs `fn(call)`.
 *
 * `deps` is the createApp dependency set — usually just `{ repo }`, since
 * routeDeps fills in the rest.
 *
 * `call(method, path, body, contentType)`:
 *   - `path` is the full path, `/api` included.
 *   - an object body is sent as JSON; a string is sent exactly as given, so a
 *     test can post malformed JSON or a CSV file.
 *   - `contentType` overrides the header, for the routes that take a file.
 *
 * It resolves to `{ status, body, text, headers }`: `body` is the parsed JSON
 * when the response has any and null when it does not, `text` is always the
 * raw body, and `headers` is the Headers object (for the download routes,
 * which are judged by their Content-Disposition).
 */
export async function withServer(deps, fn) {
  const app = createApp(routeDeps(deps));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, contentType) => {
    const headers = body === undefined && !contentType ? {} : { 'Content-Type': contentType ?? 'application/json' };
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };

  try {
    await fn(call);
  } finally {
    server.close();
  }
}

/**
 * The raw-response variant, for the tests that build their own app because
 * they exercise the auth middleware or CORS: those are judged by status codes
 * and response headers, not by a parsed body.
 *
 * `call(path, { token, method, body, origin })` resolves to the Response
 * itself, and the caller closes the returned server.
 */
export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { token, method = 'GET', body, origin } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { server, call };
}
