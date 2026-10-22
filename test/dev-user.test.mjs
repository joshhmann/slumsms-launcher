import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFeedBytes, feedAccess, rememberAccessUser, onAccessUserChange, ACCESS_KEY_MESSAGE } from '../src/updater.mjs';

const header = (user, key) => `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`;
const userOf = (authorization) => (authorization ? Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':')[0] : null);

/**
 * Like nginx after the dev tier: /launcher-test/ accepts only slumsdev:DEV; everything else
 * accepts slums:PLAYER or slumsdev:DEV. /launcher-test/away redirects to another origin.
 */
async function servers(t) {
  const feed = [];
  const other = [];
  const listen = async (handler) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const otherBase = await listen((request, response) => {
    other.push({ path: request.url, authorization: request.headers.authorization ?? null });
    if (request.url === '/deny') { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'Content-Length': 5 });
    response.end('other');
  });
  const feedBase = await listen((request, response) => {
    const authorization = request.headers.authorization ?? null;
    feed.push({ path: request.url, authorization });
    const devOnly = request.url.startsWith('/launcher-test/');
    const allowed = [header('slumsdev', 'DEV'), ...(devOnly ? [] : [header('slums', 'PLAYER')])];
    if (!allowed.includes(authorization)) { response.writeHead(401, { 'WWW-Authenticate': 'Basic' }); response.end(); return; }
    if (request.url.endsWith('/away')) { response.writeHead(302, { Location: `${otherBase}/file` }); response.end(); return; }
    if (request.url.endsWith('/away-deny')) { response.writeHead(302, { Location: `${otherBase}/deny` }); response.end(); return; }
    response.writeHead(200, { 'Content-Length': 2 });
    response.end('ok');
  });
  return { feed, other, feedUrl: `${feedBase}/launcher-test/manifest.json`, liveUrl: `${feedBase}/manifest.json`, base: feedBase };
}

test('the dev key is refused as "slums", retried once as "slumsdev" on the feed origin, and remembered', async (t) => {
  const s = await servers(t);
  const seen = [];
  onAccessUserChange((user) => seen.push(user));
  t.after(() => onAccessUserChange(null));
  const first = await readFeedBytes(s.feedUrl, 'manifest', { feedUrl: s.feedUrl, accessKey: 'DEV' });
  assert.equal(first.bytes.toString(), 'ok');
  assert.deepEqual(s.feed.map((r) => userOf(r.authorization)), ['slums', 'slumsdev']);
  assert.deepEqual(seen, ['slumsdev']);
  // Remembered: the next requests go straight to "slumsdev", and the listener stays quiet.
  await readFeedBytes(`${s.base}/launcher-test/tauri/launcher.json`, 'channel', { feedUrl: s.feedUrl, accessKey: 'DEV' });
  await readFeedBytes(s.liveUrl, 'manifest', { feedUrl: s.liveUrl, accessKey: 'DEV' });
  assert.deepEqual(s.feed.slice(2).map((r) => userOf(r.authorization)), ['slumsdev', 'slumsdev']);
  assert.deepEqual(seen, ['slumsdev']);
});

test('a player key stays "slums"; a wrong key is tried once per user and then fails without more retries', async (t) => {
  const s = await servers(t);
  await readFeedBytes(s.liveUrl, 'manifest', { feedUrl: s.liveUrl, accessKey: 'PLAYER' });
  assert.deepEqual(s.feed.map((r) => userOf(r.authorization)), ['slums']);
  // The player key on a dev-only path: slums, then slumsdev, then the access-key error.
  await assert.rejects(readFeedBytes(s.feedUrl, 'manifest', { feedUrl: s.feedUrl, accessKey: 'PLAYER' }),
    (error) => error.code === 'ACCESS_KEY_REQUIRED' && error.message === ACCESS_KEY_MESSAGE);
  assert.deepEqual(s.feed.slice(1).map((r) => userOf(r.authorization)), ['slums', 'slumsdev']);
  // No key: one request, no header, no retry.
  await assert.rejects(readFeedBytes(s.feedUrl, 'manifest', { feedUrl: s.feedUrl, accessKey: '' }), (error) => error.code === 'ACCESS_KEY_REQUIRED');
  assert.equal(s.feed.length, 4);
  assert.equal(s.feed[3].authorization, null);
});

test('neither user name ever reaches another origin, even when it refuses or after a retry', async (t) => {
  const s = await servers(t);
  const key = 'DEV';
  await readFeedBytes(`${s.base}/launcher-test/away`, 'file', { feedUrl: s.feedUrl, accessKey: key });
  await assert.rejects(readFeedBytes(`${s.base}/launcher-test/away-deny`, 'file', { feedUrl: s.feedUrl, accessKey: key }));
  assert.ok(s.other.length >= 2);
  assert.ok(s.other.every((r) => r.authorization === null), JSON.stringify(s.other));
  // A request that starts on another origin never carries the key, so it is never "retried" with one.
  await assert.rejects(readFeedBytes(`http://localhost:${new URL(s.base).port}/launcher-test/manifest.json`, 'x', { feedUrl: s.feedUrl, accessKey: key }));
  assert.equal(s.feed.at(-1).authorization, null);
});

test('a remembered user is used first and only "slums"/"slumsdev" are accepted', async (t) => {
  const s = await servers(t);
  rememberAccessUser(s.feedUrl, 'DEV2', 'slumsdev');
  rememberAccessUser(s.feedUrl, 'DEV3', 'admin');
  assert.equal(userOf(feedAccess(s.feedUrl, 'DEV2').authorization), 'slumsdev');
  assert.equal(userOf(feedAccess(s.feedUrl, 'DEV3').authorization), 'slums');
  assert.equal(feedAccess(s.feedUrl, '').authorization, '');
  assert.equal(feedAccess(s.feedUrl, '').alternate, null);
});
