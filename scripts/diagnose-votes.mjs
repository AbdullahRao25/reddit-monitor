// Local, read-only vote export diagnostic. Does not upload private voting history.
// Run: node scripts/diagnose-votes.mjs "C:\\path\\to\\post_votes.csv" "C:\\path\\to\\comment_votes.csv"
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseCsv, parseVoteCsv, summarizeVotes } from '../server/src/votes.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/diagnose-votes.mjs "path/to/post_votes.csv" "path/to/comment_votes.csv"');
  process.exitCode = 2;
} else {
  for (const file of files) {
    const name = basename(file);
    const match = name.match(/^(post|comment)_votes(?:\s*\(\d+\))?\.csv$/i);
    if (!match) {
      console.error(`${name}: Not a recognized vote export. Expected post_votes.csv or comment_votes.csv.`);
      process.exitCode = 1;
      continue;
    }
    try {
      const csv = await readFile(file, 'utf8');
      const { votes, skipped, error } = parseVoteCsv(csv, match[1].toLowerCase());
      // Do not print links, item IDs, usernames, or private voting records.
      console.log(JSON.stringify({
        file: name,
        detectedColumns: parseCsv(csv)[0]?.map(x => x.trim()) ?? [],
        error,
        imported: votes.length,
        up: summarizeVotes(votes).up,
        down: summarizeVotes(votes).down,
        skipped,
      }, null, 2));
      if (error || (votes.length === 0 && Object.keys(skipped).length)) process.exitCode = 1;
    } catch (err) {
      console.error(`${name}: Unable to read file: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
