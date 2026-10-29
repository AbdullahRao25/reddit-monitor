// Routes for recovered history. archive.js decides what a record means; these
// own the persistence, following the same shape as stealth/gateRoutes.js and
// shield/routes.js: one register function, its own dependencies, and no
// knowledge of the rest of the API.
//
// The point of this group is the account that has already gone dark. Its posts
// and comments are in no public listing any more, so the checker cannot see
// them and `content_items` stays empty -- which is exactly when an operator
// most needs to know what the account was doing before it went.

import { HttpError } from './errors.js';
import { accountRequirer } from './routeGuards.js';
import { ARCHIVE_DISCLAIMER, summarizeArchive } from './archive.js';

export function registerArchiveRoutes(app, { repo, archive = null, log = console }) {
  const requireAccount = accountRequirer(repo);

  // Reading stored history never needs the archive service, only the table.
  const stored = async (account) => {
    const rows = await repo.listArchivedItems(account.id);
    return { account_id: account.id, username: account.username, summary: summarizeArchive(rows), items: rows, source_note: ARCHIVE_DISCLAIMER };
  };

  app.get('/api/accounts/:id/archive', async (req, res) => {
    res.json(await stored(await requireAccount(req.params.id)));
  });

  // Recovery is a deliberate act, not something a page load triggers: it calls
  // an outside service, so it stays a POST the operator asks for.
  app.post('/api/accounts/:id/archive/recover', async (req, res) => {
    const account = await requireAccount(req.params.id);
    if (!archive) {
      throw new HttpError(503, 'History recovery is not configured on this server.');
    }
    let rows;
    try {
      rows = await archive.fetchHistory(account.username, { accountId: account.id });
    } catch (err) {
      // The archive being unreachable is a report, not a crash: nothing was
      // written, and whatever was recovered earlier is still there.
      if (err?.name === 'ArchiveError') throw new HttpError(err.status === 429 ? 429 : 502, err.message);
      throw err;
    }
    // A recovery that found nothing must not wipe what an earlier one found:
    // the archive answering empty is not the same as the history being empty.
    if (rows.length > 0) await repo.upsertArchivedItems(rows);
    else log.warn?.(`History recovery for u/${account.username} returned nothing; stored history left as it was.`);
    res.json({ ...(await stored(account)), recovered: rows.length });
  });

  app.delete('/api/accounts/:id/archive', async (req, res) => {
    const account = await requireAccount(req.params.id);
    await repo.clearArchivedItems(account.id);
    res.status(204).end();
  });
}
