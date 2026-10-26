import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRemoval, normalizeDomain, toContentItem } from '../src/content.js';
import { rawComment, rawPost } from './helpers.js';

test('post removal categories map to who removed it', () => {
  const cases = {
    reddit: 'spam_filtered',
    moderator: 'removed_by_mod',
    automod_filtered: 'removed_by_mod',
    anti_evil_ops: 'removed_by_admin',
    content_takedown: 'removed_by_admin',
    author: 'deleted_by_author',
    deleted: 'deleted_by_author',
    something_new: 'removed',
  };
  for (const [category, expected] of Object.entries(cases)) {
    assert.equal(classifyRemoval(rawPost({ id: 'p', removedBy: category })), expected, category);
  }
  assert.equal(classifyRemoval(rawPost({ id: 'p' })), 'visible');
  assert.equal(classifyRemoval(rawPost({ id: 'p', selftext: '[removed]' })), 'removed');
});

test('comment removal is read from the placeholder body', () => {
  assert.equal(classifyRemoval(rawComment({ id: 'c', body: '[removed]' })), 'removed');
  assert.equal(classifyRemoval(rawComment({ id: 'c', body: '[deleted]' })), 'deleted_by_author');
  assert.equal(classifyRemoval(rawComment({ id: 'c', body: 'hello' })), 'visible');
});

test('Reddit-hosted media and self posts are not promotional domains', () => {
  assert.equal(normalizeDomain('www.Example.com'), 'example.com');
  assert.equal(normalizeDomain('self.AskReddit'), null);
  assert.equal(normalizeDomain('i.redd.it'), null);
  assert.equal(normalizeDomain('v.redd.it'), null);
  assert.equal(normalizeDomain(null), null);
});

test('toContentItem maps posts and comments', () => {
  const link = toContentItem(rawPost({ id: 'p1', url: 'https://www.example.com/x' }), 'acc');
  assert.equal(link.id, 't3_p1');
  assert.equal(link.kind, 'post');
  assert.equal(link.url_domain, 'example.com');
  assert.equal(link.link_url, 'https://www.example.com/x');
  assert.match(link.permalink, /^https:\/\/www\.reddit\.com\/r\/test\//);

  const self = toContentItem(rawPost({ id: 'p2', selftext: 'body text' }), 'acc');
  assert.equal(self.url_domain, null);
  assert.equal(self.link_url, null);
  assert.equal(self.excerpt, 'body text');

  const long = toContentItem(rawComment({ id: 'c1', body: 'x'.repeat(500) }), 'acc');
  assert.equal(long.kind, 'comment');
  assert.equal(long.excerpt.length, 280);
  assert.equal(long.title, 'Some thread');
});

test('toContentItem never invents a date: a missing or invalid created_utc gives created_at null', () => {
  const at = (created_utc) => toContentItem({ ...rawComment({ id: 'c' }), created_utc }, 'acc').created_at;
  assert.equal(at(1791779310), '2026-10-12T04:28:30.000Z');
  // Previously these became 1970-01-01 and fell out of every 30-day count.
  for (const bad of [null, undefined, 0, -5, Number.NaN]) {
    assert.equal(at(bad), null, `created_utc ${String(bad)}`);
  }
});
