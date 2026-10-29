import { HttpError } from './errors.js';
import { readerErrorDetails } from './readerErrors.js';

// The browser window appears on the API machine. Manual verification stays
// off unless explicitly enabled on a local desktop.
export function manualVerificationAvailable({ isLoopback, platform, display = '', setting = '' }) {
  return Boolean(isLoopback && setting === 'true' &&
    (platform === 'win32' || platform === 'darwin' || display));
}

export function registerReaderVerificationRoutes(app, { reddit }) {
  for (const [action, method] of [['open', 'openVerification'], ['complete', 'completeVerification']]) {
    app.post(`/api/reader/verification/${action}`, async (req, res) => {
      if (!reddit.getDiagnostics?.()?.manual_verification?.available || typeof reddit[method] !== 'function') {
        throw new HttpError(503, 'Manual verification requires the HTML reader running on this computer with a desktop browser.');
      }
      try {
        const result = await reddit[method]();
        res.json({
          opened: result.opened === true,
          active: result.active === true,
          verified: result.verified === true,
          ...(/^[A-Za-z0-9_-]{3,20}$/.test(result.username ?? '') ? { username: result.username } : {}),
          reader: reddit.getDiagnostics(),
        });
      } catch (err) {
        const diagnostics = readerErrorDetails(err);
        if (diagnostics) return res.status(diagnostics.attempts === 0 ? 409 : 502).json({
          error: diagnostics.message, diagnostics, reader: reddit.getDiagnostics(),
        });
        throw new HttpError(502, 'The monitoring browser could not complete verification. Reopen it and try again.');
      }
    });
  }
}
