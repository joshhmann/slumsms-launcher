import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishLayer, publishLayeredRelease } from '../tools/publish.mjs';
import { loadRelease, installRelease, feedAccess, ACCESS_KEY_MESSAGE } from '../src/updater.mjs';
import { effectiveAccessKey, readLauncherConfig } from '../src/launcher-config.mjs';

const KEY = 'friends-only:key';
const basic = (key) => `Basic ${Buffer.from(`slums:${key}`).toString('base64')}`;

/**
 * A feed server that may require Basic auth, plus a second server on another origin. `route`
 * lets a test redirect feed paths elsewhere. Every request records the Authorization it carried.
 */
async function fixture(t, { requireKey = KEY, route = () => null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-access-'));
  const source = path.join(root, 'client-src');
  const output = path.join(root, 'public');
  const install = path.join(root, 'installed');
  await mkdir(path.join(source, 'Data'), { recursive: true });
  await writeFile(path.join(source, 'SlumsMS.exe'), 'slums executable');
  await writeFile(path.join(source, 'Data', 'Map.img'), 'map bytes');
  await publishLayer({ source, output, layer: 'client', version: 'c1' });
  await publishLayeredRelease({ output, version: 'r1', layers: [{ name: 'client', version: 'c1' }] });
  const feedRequests = [];
  const otherRequests = [];
  const serve = async (relative, response) => {
    try {
      const bytes = await readFile(path.join(output, relative));
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  };
  const servers = [];
  const listen = async (handler) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const other = await listen(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname).slice(1);
    otherRequests.push({ path: relative, authorization: request.headers.authorization });
    if (relative.startsWith('back/')) {
      response.writeHead(302, { Location: `${feed}/${relative.slice('back/'.length)}` });
      response.end();
      return;
    }
    await serve(relative, response);
  });
  const feed = await listen(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname).slice(1);
    feedRequests.push({ path: relative, authorization: request.headers.authorization });
    if (requireKey && request.headers.authorization !== basic(requireKey)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="slums"' });
      response.end();
      return;
    }
    const target = route(relative, other);
    if (target === 401) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (target) {
      response.writeHead(302, { Location: target });
      response.end();
      return;
    }
    await serve(relative, response);
  });
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  return { install, feed, other, url: `${feed}/manifest.json`, feedRequests, otherRequests };
}

test('the key is sent as Basic slums:<key> on every feed request: manifest, layer manifests and files', async (t) => {
  const f = await fixture(t);
  const release = await loadRelease(f.url, { accessKey: KEY });
  await installRelease(f.install, release, () => {}, { retryDelayMs: 1 });
  assert.equal(await readFile(path.join(f.install, 'Data', 'Map.img'), 'utf8'), 'map bytes');
  const paths = f.feedRequests.map((entry) => entry.path);
  assert.ok(paths.includes('manifest.json') && paths.includes('layers/client/c1/manifest.json'));
  assert.ok(paths.includes('layers/client/c1/files/Data/Map.img'));
  assert.ok(f.feedRequests.every((entry) => entry.authorization === basic(KEY)));
  assert.equal(f.otherRequests.length, 0);
});

test('an empty key sends no Authorization header', async (t) => {
  const f = await fixture(t, { requireKey: '' });
  const release = await loadRelease(f.url, { accessKey: '' });
  await installRelease(f.install, release);
  assert.ok(f.feedRequests.length > 0);
  assert.ok(f.feedRequests.every((entry) => entry.authorization === undefined));
  assert.equal(feedAccess(f.url, '').authorization, '');
});

test('a cross-origin redirect drops the key; files served from another origin never see it', async (t) => {
  const f = await fixture(t, { route: (relative, other) => (relative.includes('/files/') ? `${other}/${relative}` : null) });
  const release = await loadRelease(f.url, { accessKey: KEY });
  await installRelease(f.install, release, () => {}, { retryDelayMs: 1 });
  assert.equal(await readFile(path.join(f.install, 'SlumsMS.exe'), 'utf8'), 'slums executable');
  assert.ok(f.otherRequests.length >= 2);
  assert.ok(f.otherRequests.every((entry) => entry.authorization === undefined));
});

test('once a redirect chain leaves the feed origin the key is not re-attached when it bounces back', async (t) => {
  const f = await fixture(t, { route: (relative, other) => (relative === 'manifest.json' ? `${other}/back/manifest.json` : null) });
  await assert.rejects(loadRelease(f.url, { accessKey: KEY }), (error) => error.message === ACCESS_KEY_MESSAGE);
  assert.equal(f.otherRequests[0].authorization, undefined);
  assert.deepEqual(f.feedRequests.map((entry) => entry.authorization), [basic(KEY), undefined]);
});

test('401 from the feed produces the access-key error and is never retried', async (t) => {
  const f = await fixture(t);
  for (const accessKey of ['', 'wrong']) {
    f.feedRequests.length = 0;
    await assert.rejects(loadRelease(f.url, { accessKey }), (error) => error.message === ACCESS_KEY_MESSAGE && error.code === 'ACCESS_KEY_REQUIRED' && error.permanent);
    assert.equal(f.feedRequests.length, 1);
  }
});

test('a download rejected with 401 (key revoked mid-install) stops immediately without retrying', async (t) => {
  let reject = false;
  const f = await fixture(t, { route: (relative) => (reject && relative.includes('/files/') ? 401 : null) });
  const release = await loadRelease(f.url, { accessKey: KEY });
  reject = true;
  f.feedRequests.length = 0;
  await assert.rejects(installRelease(f.install, release, () => {}, { retries: 4, retryDelayMs: 1, concurrency: 1 }),
    (error) => error.message === ACCESS_KEY_MESSAGE);
  assert.equal(f.feedRequests.length, 1);
});

test('a saved key overrides the built-in key; the built-in key is used only for the built-in feed', async (t) => {
  const defaultFeedUrl = 'https://slumspatch.asslorde.com/manifest.json';
  assert.equal(effectiveAccessKey({ savedKey: 'mine', defaultKey: 'baked', feedUrl: defaultFeedUrl, defaultFeedUrl }), 'mine');
  assert.equal(effectiveAccessKey({ savedKey: '', defaultKey: 'baked', feedUrl: defaultFeedUrl, defaultFeedUrl }), 'baked');
  assert.equal(effectiveAccessKey({ savedKey: '', defaultKey: 'baked', feedUrl: 'https://other.example/manifest.json', defaultFeedUrl }), '');
  assert.equal(effectiveAccessKey({ savedKey: 'mine', defaultKey: 'baked', feedUrl: 'https://other.example/manifest.json', defaultFeedUrl }), 'mine');
  assert.equal(effectiveAccessKey({ savedKey: '', defaultKey: '', feedUrl: defaultFeedUrl, defaultFeedUrl }), '');
  // End to end: the saved key, not the baked one, reaches the server.
  const f = await fixture(t, { requireKey: 'mine' });
  await loadRelease(f.url, { accessKey: effectiveAccessKey({ savedKey: 'mine', defaultKey: 'baked', feedUrl: f.url, defaultFeedUrl: f.url }) });
  assert.equal(f.feedRequests[0].authorization, basic('mine'));
  // Config files accept an accessKey string and reject control characters.
  const dir = await mkdtemp(path.join(tmpdir(), 'slumsms-key-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.json'), JSON.stringify({ accessKey: 'baked' }));
  assert.equal((await readLauncherConfig([path.join(dir, 'a.json')])).accessKey, 'baked');
  await writeFile(path.join(dir, 'b.json'), JSON.stringify({ accessKey: 'bad\nkey' }));
  await assert.rejects(readLauncherConfig([path.join(dir, 'b.json')]), /accessKey/);
});
