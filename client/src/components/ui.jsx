import { LEVEL_META, STATUS_META } from '../meta.js';

const PATHS = {
  shield: (
    <>
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  octagon: (
    <>
      <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5" />
      <path d="M12 8h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m3 3 18 18" />
      <path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8" />
      <path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2v.9" />
      <path d="M12 17h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  bellOff: (
    <>
      <path d="m3 3 18 18" />
      <path d="M8.7 3.8A6 6 0 0 1 18 8c0 3.3.7 5.5 1.5 6.9" />
      <path d="M17 17H3s3-2 3-9c0-.5 0-1 .2-1.5" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </>
  ),
  pause: (
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ),
  play: <path d="m7 4 13 8-13 8z" />,
  fingerprint: (
    <>
      <path d="M12 2a8 8 0 0 0-8 8c0 3.9 2.7 7.1 6.3 7.9" />
      <path d="M12 2a8 8 0 0 1 8 8c0 1.5-.3 2.9-.9 4.1" />
      <path d="M12 6a4 4 0 0 0-4 4c0 2.2 1.5 4.1 3.5 4.7" />
      <path d="M12 6a4 4 0 0 1 4 4c0 .8-.2 1.6-.5 2.2" />
      <path d="M12 10v4" />
    </>
  ),
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

// A status-coloured icon with a text label. The text stays in ink colours.
export function Badge({ tone = 'neutral', icon, children, title }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

export function RiskBadge({ level }) {
  const meta = LEVEL_META[level];
  if (!meta) return <span className="muted">Not scored</span>;
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

// Risk 0-100 as a meter: the fill carries severity, the track is a lighter
// step of the same colour.
export function RiskMeter({ score, level }) {
  const meta = LEVEL_META[level];
  if (score === null || score === undefined || !meta) return <span className="muted">Not scored</span>;
  return (
    <div className={`risk-cell tone-${meta.tone}`}>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label={`Risk ${score} of 100: ${meta.label}`}
      >
        <span style={{ width: `${Math.max(score, 2)}%` }} />
      </div>
      <span className="risk-score">{score}</span>
      <span className="risk-label">
        <Icon name={meta.icon} size={14} />
        {meta.label}
      </span>
    </div>
  );
}

export function Button({ variant = 'secondary', icon, busy = false, disabled = false, children, ...props }) {
  return (
    <button type="button" className={`btn btn-${variant}`} disabled={busy || disabled} {...props}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <p className="note note-error" role="alert">
      <Icon name="alert" />
      <span>{error.message ?? String(error)}</span>
    </p>
  );
}

export function ExternalLink({ href, children }) {
  return (
    <a className="ext-link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <Icon name="external" size={13} />
    </a>
  );
}
