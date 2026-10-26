import { useState } from 'react';
import { api } from '../api.js';
import { formatNumber, timeAgo } from '../format.js';
import { PRIORITY_META, REMOVAL_META, STATUS_META } from '../meta.js';
import { Badge, Button, ErrorNote, ExternalLink, Icon, RiskBadge, StatusBadge } from './ui.jsx';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
// Accept "name", "u/name", "/u/name" or a profile URL, mirroring the API.
function normalizeUsername(input) {
  return String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(?:[a-z]+\.)?reddit\.com/i, '')
    .replace(/^\/?(?:u|user)\//i, '')
    .replace(/[/?#].*$/, '');
}

// A live, one-off shadowban + risk check for any username. It runs the same
// pipeline as a monitored account (profile -> newest 100 posts/comments ->
// /api/info -> risk) but adds nothing to the account list.
export function ShadowbanChecker() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [report, setReport] = useState(null);
  const [resultError, setResultError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const clean = normalizeUsername(username);
    if (!USERNAME_RE.test(clean)) {
      setFormError(new Error('Enter a valid Reddit username (3-20 letters, numbers, _ or -).'));
      return;
    }
    setBusy(true);
    setFormError(null);
    setResultError(null);
    setReport(null);
    try {
      setReport(await api.checkLive(clean));
    } catch (err) {
      setResultError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shadowban-checker">
      <form className="shadowban-form" onSubmit={submit}>
        <h1>
          <Icon name="eyeOff" size={18} /> Shadowban check
        </h1>
        <p className="muted">
          Check any Reddit account for shadowbans, removals and risk. It reads the public view of the
          account and its newest posts and comments, without adding it to the list of monitored accounts.
        </p>
        <div className="shadowban-inputs">
          <label className="field">
            <span>Reddit username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="u/username or profile link"
              autoComplete="off"
              spellCheck={false}
              maxLength={80}
              required
            />
          </label>
          <Button type="submit" variant="primary" icon="eye" busy={busy}>
            {busy ? 'Checking…' : 'Check now'}
          </Button>
        </div>
        <ErrorNote error={formError ?? resultError} />
      </form>

      {busy && <p className="empty checking-line"><span className="spinner" aria-hidden="true" /> Talking to Reddit…</p>}
      {report && <Report report={report} username={normalizeUsername(username)} />}
    </div>
  );
}

function Report({ report, username }) {
  const { status, profile, assessment, items = [] } = report;
  const removed = items.filter((item) => REMOVED_STATUSES_SET.has(item.removalStatus));

  return (
    <div className="report">
      <section className="panel report-head">
        <div className="detail-id">
          <h2>u/{username}</h2>
          <div className="detail-tags">
            <StatusBadge status={status} />
            {status === 'active' && profile && (
              <span className="muted small">
                {formatNumber((profile.linkKarma ?? 0) + (profile.commentKarma ?? 0))} karma
                {profile.createdAt ? ` · account ${timeAgo(profile.createdAt)}` : ''}
              </span>
            )}
            {status === 'active' && (
              <ExternalLink href={`https://www.reddit.com/user/${username}`}>Profile</ExternalLink>
            )}
          </div>
        </div>
        <div className="detail-score">
          <span className="hero-figure">
            {assessment.score}
            <span className="hero-unit">/100</span>
          </span>
          <RiskBadge level={assessment.level} />
        </div>
      </section>

      {status === 'shadowbanned' && (
        <p className="note note-error" role="alert">
          <Icon name="eyeOff" />
          <span>
            Reddit answers "not found" for this account to logged-out viewers. Confirm it in a private
            window — if it 404s there but you can still log in, it is shadowbanned.
          </span>
        </p>
      )}

      <div className="detail-grid">
        <section className="panel">
          <h2>What to do</h2>
          <Recommendations items={assessment.recommendations} />
        </section>
        <section className="panel">
          <h2>Why this score</h2>
          <Factors items={assessment.factors} />
          {status === 'active' && (
            <p className="muted small">
              Based on the newest {report.sampled ?? 0} posts and comments
              {report.removed ? `, ${report.removed} removed` : ''}. This is a snapshot — it does not
              track changes over time.
            </p>
          )}
        </section>
      </div>

      {status === 'active' && removed.length > 0 && <RemovedSnapshot items={removed} />}
    </div>
  );
}

const REMOVED_STATUSES_SET = new Set([
  'removed_by_mod',
  'spam_filtered',
  'removed_by_admin',
  'removed',
]);

function RemovedSnapshot({ items }) {
  const shown = items.slice(0, 10);
  return (
    <section className="panel">
      <h2>Removed in this snapshot</h2>
      <p className="muted small">
        {items.length} of the newest posts and comments are not publicly visible right now.
      </p>
      <ul className="content-list">
        {shown.map((item) => {
          const meta = REMOVAL_META[item.removalStatus] ?? REMOVAL_META.removed;
          return (
            <li key={item.id}>
              <div className="content-meta">
                <Badge tone={meta.tone} icon={meta.icon} title="Who removed it">
                  {meta.label}
                </Badge>
                <span>
                  {item.kind === 'post' ? 'Post' : 'Comment'} in r/{item.subreddit}
                </span>
              </div>
              {item.excerpt && <p className="content-excerpt">{item.excerpt}</p>}
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="muted small">…and {items.length - shown.length} more.</p>
      )}
    </section>
  );
}

function Recommendations({ items }) {
  if (items.length === 0) {
    return (
      <p className="all-clear tone-good">
        <Icon name="check" size={18} />
        Nothing to do right now.
      </p>
    );
  }
  return (
    <ol className="recs">
      {items.map((rec) => {
        const meta = PRIORITY_META[rec.priority] ?? PRIORITY_META.normal;
        return (
          <li key={rec.key} className="rec">
            <Badge tone={meta.tone} icon={meta.icon}>
              {meta.label}
            </Badge>
            <h3>{rec.title}</h3>
            <p>{rec.body}</p>
            {rec.links?.map((link) => (
              <ExternalLink key={link.url} href={link.url}>
                {link.label}
              </ExternalLink>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function Factors({ items }) {
  if (items.length === 0) return <p className="empty">No risk factors found.</p>;
  return (
    <ul className="factors">
      {items.map((factor) => (
        <li key={factor.key} className={factor.points ? undefined : 'factor-zero'}>
          <div className="factor-head">
            <span>{factor.label}</span>
            <span className="factor-points">{factor.points ? `+${factor.points}` : '0'}</span>
          </div>
          <p>{factor.detail}</p>
        </li>
      ))}
    </ul>
  );
}
