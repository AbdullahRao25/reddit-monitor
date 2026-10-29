// The team, backed by Supabase Auth's own user directory.
//
// There is no members table on purpose: the list sign-in already trusts is the
// list shown here, so the two can never drift. Adding someone is an invite,
// removing them is deleting their user, and both take effect on the next
// request — no config edit, no restart (see AUTH_ADMIT_INVITED in auth.js).
//
// `admin` is a Supabase client's `auth.admin`, which needs the service-role
// key. It is injected so this module never imports the SDK and tests can fake
// it.

import { HttpError } from './errors.js';

// Supabase pages the directory; one page covers any team this tool is for.
const PAGE_SIZE = 200;

export function createMemberDirectory({ admin, owners = [] }) {
  const ownerSet = new Set(owners.map((email) => String(email).trim().toLowerCase()).filter(Boolean));
  const isOwner = (email) => ownerSet.has(String(email ?? '').trim().toLowerCase());

  function toMember(user) {
    const email = user?.email ?? '';
    return {
      id: user?.id ?? null,
      email,
      invited_at: user?.invited_at ?? null,
      created_at: user?.created_at ?? null,
      last_sign_in_at: user?.last_sign_in_at ?? null,
      owner: isOwner(email),
      // Invited, but the link has not been used yet. Worth showing: an invite
      // that never arrives (Supabase's built-in mail is rate-limited) looks
      // exactly like one that was ignored.
      pending: Boolean(user?.invited_at) && !user?.last_sign_in_at,
    };
  }

  async function list() {
    const { data, error } = await admin.listUsers({ page: 1, perPage: PAGE_SIZE });
    if (error) throw new HttpError(502, `Could not read the team from Supabase: ${error.message}`);
    return (data?.users ?? [])
      .map(toMember)
      .filter((member) => member.email)
      .sort((a, b) => Number(b.owner) - Number(a.owner) || a.email.localeCompare(b.email));
  }

  async function invite(rawEmail) {
    const email = String(rawEmail ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(400, 'That does not look like an email address.');
    }
    const { data, error } = await admin.inviteUserByEmail(email);
    if (error) {
      if (/already|registered|exists/i.test(error.message)) {
        throw new HttpError(409, `${email} is already on the team.`);
      }
      // Supabase's built-in sender allows only a few messages an hour, so this
      // is the failure a growing team hits first. Name the fix in the message.
      if (/rate limit|too many|429/i.test(error.message)) {
        throw new HttpError(
          429,
          'Supabase is rate-limiting invite emails. Set up custom SMTP under ' +
            'Project Settings -> Authentication -> SMTP, then invite again.',
        );
      }
      throw new HttpError(502, `Could not invite ${email}: ${error.message}`);
    }
    return toMember(data?.user ?? { email, invited_at: new Date().toISOString() });
  }

  // `actor` is the signed-in user doing the removing, so the two ways to lock
  // the workspace out of its own administration are refused here rather than
  // discovered afterwards.
  async function remove(id, actor) {
    const member = (await list()).find((row) => row.id === id);
    if (!member) throw new HttpError(404, 'That person is not on the team.');
    if (member.owner) {
      throw new HttpError(
        409,
        `${member.email} is an owner (AUTH_ALLOWED_EMAILS in server/.env). Remove the address there first.`,
      );
    }
    if (actor && member.email === String(actor).trim().toLowerCase()) {
      throw new HttpError(409, 'You cannot remove your own access.');
    }
    const { error } = await admin.deleteUser(id);
    if (error) throw new HttpError(502, `Could not remove ${member.email}: ${error.message}`);
    return member;
  }

  return { isOwner, list, invite, remove };
}
