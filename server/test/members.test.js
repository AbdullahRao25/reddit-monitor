import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createMemberDirectory } from '../src/members.js';
import { createMemoryRepo, silentLog } from './helpers.js';
import { listen } from './harness.js';

// A stand-in for Supabase's auth.admin: the three calls members.js makes.
function fakeAdmin(seed = []) {
  let users = [...seed];
  const calls = [];
  return {
    get users() {
      return users;
    },
    calls,
    async listUsers() {
      return { data: { users }, error: null };
    },
    async inviteUserByEmail(email) {
      calls.push(['invite', email]);
      if (users.some((u) => u.email === email)) {
        return { data: null, error: { message: 'A user with this email address has already been registered' } };
      }
      const user = { id: `id-${email}`, email, invited_at: '2026-10-27T10:00:00Z', last_sign_in_at: null };
      users.push(user);
      return { data: { user }, error: null };
    },
    async deleteUser(id) {
      calls.push(['delete', id]);
      users = users.filter((u) => u.id !== id);
      return { data: {}, error: null };
    },
  };
}

const OWNER = { id: 'id-boss', email: 'boss@team.com', last_sign_in_at: '2026-10-26T09:00:00Z' };
const INVITED = {
  id: 'id-mate',
  email: 'mate@team.com',
  invited_at: '2026-10-25T09:00:00Z',
  last_sign_in_at: '2026-10-26T10:00:00Z',
};
const PENDING = { id: 'id-new', email: 'new@team.com', invited_at: '2026-10-27T08:00:00Z', last_sign_in_at: null };

const TOKENS = {
  'tok-boss': { id: 'id-boss', email: 'boss@team.com' },
  'tok-mate': { id: 'id-mate', email: 'mate@team.com', invitedAt: '2026-10-25T09:00:00Z' },
};

function serverWith({ admin, owners = ['boss@team.com'], withAuth = true, members: override } = {}) {
  const app = createApp({
    repo: createMemoryRepo(),
    reddit: { verify: async () => {} },
    checker: { isChecking: () => false, checkAccount: async () => null },
    scheduler: { status: () => ({}), trigger: () => true },
    members: override === undefined ? createMemberDirectory({ admin, owners }) : override,
    auth: withAuth
      ? createAuth({
          verifyToken: async (token) => TOKENS[token] ?? null,
          allowedEmails: owners,
          admitInvited: true,
          log: silentLog,
        })
      : undefined,
    log: silentLog,
  });
  return app;
}


test('the team lists owners first and marks who has not signed in yet', async (t) => {
  const app = serverWith({ admin: fakeAdmin([INVITED, PENDING, OWNER]) });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const body = await (await call('/api/members', { token: 'tok-boss' })).json();
  assert.deepEqual(
    body.members.map((m) => m.email),
    ['boss@team.com', 'mate@team.com', 'new@team.com'],
  );
  assert.equal(body.members[0].owner, true);
  assert.equal(body.members[1].owner, false);
  assert.equal(body.members[2].pending, true, 'invited but never signed in');
  assert.equal(body.members[1].pending, false, 'invited and has signed in');
  assert.equal(body.can_manage, true);
  assert.equal(body.me, 'boss@team.com');
});

test('an owner invites by email; a second invite for the same address is a conflict', async (t) => {
  const admin = fakeAdmin([OWNER]);
  const app = serverWith({ admin });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const created = await call('/api/members', { token: 'tok-boss', method: 'POST', body: { email: ' New@Team.com ' } });
  assert.equal(created.status, 201);
  // Trimmed and lowercased before it reaches Supabase.
  assert.deepEqual(admin.calls[0], ['invite', 'new@team.com']);
  assert.equal((await created.json()).email, 'new@team.com');

  const again = await call('/api/members', { token: 'tok-boss', method: 'POST', body: { email: 'new@team.com' } });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already on the team/);
});

test('an invited teammate can see the team but not change it', async (t) => {
  const admin = fakeAdmin([OWNER, INVITED, PENDING]);
  const app = serverWith({ admin });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const seen = await call('/api/members', { token: 'tok-mate' });
  assert.equal(seen.status, 200);
  assert.equal((await seen.json()).can_manage, false);

  const invite = await call('/api/members', { token: 'tok-mate', method: 'POST', body: { email: 'friend@x.com' } });
  assert.equal(invite.status, 403);
  assert.match((await invite.json()).error, /Only a workspace owner/);

  const remove = await call('/api/members/id-new', { token: 'tok-mate', method: 'DELETE' });
  assert.equal(remove.status, 403);
  assert.deepEqual(admin.calls, [], 'nothing reached Supabase');
});

test('removing a teammate works, but not an owner and not yourself', async (t) => {
  const admin = fakeAdmin([OWNER, INVITED, PENDING]);
  const app = serverWith({ admin });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  assert.equal((await call('/api/members/id-new', { token: 'tok-boss', method: 'DELETE' })).status, 204);
  assert.deepEqual(admin.calls, [['delete', 'id-new']]);
  assert.equal(admin.users.some((u) => u.id === 'id-new'), false);

  // An owner is admitted by server/.env, so deleting the Supabase user would
  // not remove their access: refuse rather than appear to have done something.
  const owner = await call('/api/members/id-boss', { token: 'tok-boss', method: 'DELETE' });
  assert.equal(owner.status, 409);
  assert.match((await owner.json()).error, /AUTH_ALLOWED_EMAILS/);

  const missing = await call('/api/members/id-nobody', { token: 'tok-boss', method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('you cannot remove your own access', async (t) => {
  // An owner by invite rather than by .env, so the owner guard is not what stops it.
  const admin = fakeAdmin([OWNER, INVITED]);
  const app = serverWith({ admin, owners: ['boss@team.com', 'mate@team.com'] });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const self = await call('/api/members/id-mate', { token: 'tok-mate', method: 'DELETE' });
  assert.equal(self.status, 409);
  assert.match((await self.json()).error, /AUTH_ALLOWED_EMAILS|your own access/);
});

test('a bad address is refused before Supabase is called', async (t) => {
  const admin = fakeAdmin([OWNER]);
  const app = serverWith({ admin });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  for (const email of ['', 'not-an-email', 'a@b', undefined]) {
    const res = await call('/api/members', { token: 'tok-boss', method: 'POST', body: { email } });
    assert.equal(res.status, 400, String(email));
  }
  assert.deepEqual(admin.calls, []);
});

test('an invite rate-limited by Supabase names custom SMTP as the fix', async (t) => {
  const admin = fakeAdmin([OWNER]);
  admin.inviteUserByEmail = async () => ({ data: null, error: { message: 'email rate limit exceeded' } });
  const app = serverWith({ admin });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const res = await call('/api/members', { token: 'tok-boss', method: 'POST', body: { email: 'new@team.com' } });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /SMTP/);
});

test('without a service-role key the team endpoints say so instead of failing', async (t) => {
  const app = serverWith({ members: null, withAuth: false });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const res = await call('/api/members');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('with sign-in off the local operator can still manage the team', async (t) => {
  const admin = fakeAdmin([OWNER, PENDING]);
  const app = serverWith({ admin, withAuth: false });
  const { server, call } = await listen(app);
  t.after(() => server.close());

  const body = await (await call('/api/members')).json();
  assert.equal(body.can_manage, true);
  assert.equal(body.me, null);
  assert.equal((await call('/api/members/id-new', { method: 'DELETE' })).status, 204);
});
