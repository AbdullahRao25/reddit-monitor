// Diagnostics cross the API boundary. Never include browser exception text,
// response bodies, cookies, or navigation URLs in them.
export function sanitizeReaderText(value, maxLength = 200) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:https?|file|chrome|about):\S+/gi, '[address]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[redacted]')
    .replace(/\b(?:password|access_token|refresh_token|client_secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s<>"']+[\\/])*[^\s<>"']+/g, '[path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength) || null;
}

const iso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
};

export class ReaderError extends Error {
  constructor(message, options = {}) {
    if (message && typeof message === 'object') {
      options = message;
      message = options.message;
    }
    const safeMessage = sanitizeReaderText(message, 500) || 'The Reddit reader could not complete this request.';
    super(safeMessage);
    this.name = 'ReaderError';
    const status = Number(options.http_status ?? options.status);
    this.diagnostics = {
      code: /^[a-z][a-z0-9_]{0,59}$/.test(options.code ?? '') ? options.code : 'unexpected_page',
      http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      page_title: sanitizeReaderText(options.page_title, 160),
      occurred_at: iso(options.occurred_at) ?? new Date().toISOString(),
      retry_at: iso(options.retry_at),
      temporary: options.temporary !== false,
      attempts: Number.isInteger(options.attempts) && options.attempts >= 0 ? options.attempts : 1,
      message: safeMessage,
    };
    this.code = this.diagnostics.code;
    this.status = this.diagnostics.http_status;
  }
}

export function readerErrorDetails(err) {
  if (!err?.diagnostics || typeof err.diagnostics !== 'object') return null;
  // Reconstruct the allowlist, dropping anything a caller added to the object.
  return { ...new ReaderError(err.diagnostics).diagnostics };
}
