import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadExport} from '../src/lib/api.js';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

// downloadExport saves a file, so it needs the handful of browser globals a
// download uses. Stubbing them here keeps the filename and URL logic testable
// without a headless browser.
async function withBrowser(fetchImpl, run) {
  const saved = {fetch: globalThis.fetch, document: globalThis.document, URL: globalThis.URL};
  const clicked = [];
  const revoked = [];
  globalThis.fetch = fetchImpl;
  globalThis.document = {
    createElement: () => ({href: '', download: '', click() { clicked.push({href: this.href, download: this.download}); }, remove() {}}),
    body: {appendChild() {}},
  };
  globalThis.URL = Object.assign(saved.URL, {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: (url) => revoked.push(url),
  });
  try { await run({clicked, revoked}); } finally { Object.assign(globalThis, saved); }
}

const response = (headers, body = '{}') => ({
  ok: true,
  status: 200,
  headers: new Headers(headers),
  blob: async () => new Blob([body]),
});

test('the JSON export asks for the right route and saves the server filename', () => withBrowser(
  async (path) => {
    assert.equal(path, `/api/accounts/${A}/export?format=json`);
    return response({'content-disposition': 'attachment; filename="u-tester-2026-10-28.json"'});
  },
  async ({clicked}) => {
    assert.equal(await downloadExport(A), 'u-tester-2026-10-28.json');
    assert.equal(clicked.length, 1);
    assert.equal(clicked[0].download, 'u-tester-2026-10-28.json');
  },
));

test('a CSV export carries the table it wants', () => withBrowser(
  async (path) => {
    assert.equal(path, `/api/accounts/${A}/export?format=csv&table=content`);
    return response({'content-disposition': 'attachment; filename="u-tester-content-2026-10-28.csv"'}, 'id\r\n');
  },
  async () => assert.match(await downloadExport(A, {format: 'csv', table: 'content'}), /-content-.*\.csv$/),
));

test('a response with no filename still saves something sensible', () => withBrowser(
  async () => response({}),
  async () => {
    assert.equal(await downloadExport(A, {format: 'csv'}), 'export.csv');
  },
));

test('a failed export reports the server message', () => withBrowser(
  async () => ({ok: false, status: 400, headers: new Headers(), json: async () => ({error: 'table must be one of: checks, content, alerts.'})}),
  async () => assert.rejects(() => downloadExport(A, {format: 'csv', table: 'nope'}), /table must be one of/),
));

test('an unreachable API is reported as such, not as a browser error', () => withBrowser(
  async () => { throw new TypeError('Failed to fetch'); },
  async () => assert.rejects(() => downloadExport(A), /Cannot reach the API server/),
));
