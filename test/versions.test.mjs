import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishLayer, publishLayeredRelease } from '../tools/publish.mjs';
import { loadRelease, inspectRelease, installRelease, readInstalledRecord, writeInstalledRecord, checkAvailableRelease } from '../src/updater.mjs';
import { versionStatus, versionFooter } from '../src/version-status.mjs';

const RECORD = path.join('.slumsms-launcher', 'installed.json');

async function fixture(t, { key = '' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-versions-'));
  const output = path.join(root, 'public');
  const install = path.join(root, 'installed');
  const base = path.join(root, 'base-src');
  const client = path.join(root, 'client-src');
  await mkdir(path.join(base, 'Data'), { recursive: true });
  await writeFile(path.join(base, 'Data', 'Map0.img'), 'map bytes');
  await mkdir(client, { recursive: true });
  await writeFile(path.join(client, 'SlumsMS.exe'), 'slums v1');
  const requests = [];
  const expected = key ? `Basic ${Buffer.from(`slums:${key}`).toString('base64')}` : '';
  const server = createServer(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    requests.push(relative);
    if (expected && request.headers.authorization !== expected) { response.writeHead(401); response.end(); return; }
    try {
      const bytes = await readFile(path.join(output, relative));
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
  async function publish(release, clientVersion, baseVersion = 'v83-b1') {
    if (!(await readFile(path.join(output, 'layers', 'base', baseVersion, 'manifest.json')).catch(() => null))) {
      await publishLayer({ source: base, output, layer: 'base', version: baseVersion });
    }
    await publishLayer({ source: client, output, layer: 'client', version: clientVersion });
    await publishLayeredRelease({ output, version: release, layers: [{ name: 'base', version: baseVersion }, { name: 'client', version: clientVersion }] });
  }
  return { root, output, install, client, requests, url, publish };
}

test('installed record: missing folder, missing file and corrupt file all read as unknown (null)', async (t) => {
  const f = await fixture(t);
  assert.equal(await readInstalledRecord(path.join(f.root, 'nowhere')), null);
  await mkdir(path.join(f.install, '.slumsms-launcher'), { recursive: true });
  assert.equal(await readInstalledRecord(f.install), null);
  for (const corrupt of ['{not json', '', 'null', '[]', '{"recordVersion":2,"release":"1.4.0"}', '{"recordVersion":1,"release":""}', '{"recordVersion":1,"release":42}']) {
    await writeFile(path.join(f.install, RECORD), corrupt);
    assert.equal(await readInstalledRecord(f.install), null, corrupt);
  }
});

test('installed record round-trips release, layer versions and manifest hash', async (t) => {
  const f = await fixture(t);
  await mkdir(f.install, { recursive: true });
  const release = { version: '1.4.0', manifestSha256: 'a'.repeat(64), launch: { executable: 'SlumsMS.exe', args: ['--x'] }, layers: [{ name: 'base', version: 'v83-2026.10.19', sha256: 'b'.repeat(64), cached: true }, { name: 'client', version: '1.4.0', sha256: 'c'.repeat(64) }] };
  await writeInstalledRecord(f.install, release, { now: new Date('2026-10-21T10:00:00Z') });
  assert.deepEqual(await readInstalledRecord(f.install), {
    release: '1.4.0', manifestSha256: 'a'.repeat(64), verifiedAt: '2026-10-21T10:00:00.000Z', launch: { executable: 'SlumsMS.exe', args: ['--x'] },
    layers: [{ name: 'base', version: 'v83-2026.10.19', sha256: 'b'.repeat(64) }, { name: 'client', version: '1.4.0', sha256: 'c'.repeat(64) }],
  });
  // Junk layer entries are dropped rather than failing the whole record.
  const raw = JSON.parse(await readFile(path.join(f.install, RECORD), 'utf8'));
  raw.layers.push(null, { name: 7 });
  await writeFile(path.join(f.install, RECORD), JSON.stringify(raw));
  assert.equal((await readInstalledRecord(f.install)).layers.length, 2);
  // Records from before 1.3.3 have no launch; a damaged one reads as none, not as a broken record.
  delete raw.launch;
  await writeFile(path.join(f.install, RECORD), JSON.stringify(raw));
  assert.equal((await readInstalledRecord(f.install)).launch, null);
  raw.launch = { executable: '../evil.exe', args: [] };
  await writeFile(path.join(f.install, RECORD), JSON.stringify(raw));
  assert.equal((await readInstalledRecord(f.install)).launch, null);
});

test('install writes the record; a verify with pending files does not change it; the next update does', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.0', '1.3.0');
  const first = await loadRelease(f.url, { installDir: f.install });
  const topBytes = await readFile(path.join(f.output, 'manifest.json'));
  assert.equal(first.manifestSha256, createHash('sha256').update(topBytes).digest('hex'));
  // Before any install there is no record.
  await inspectRelease(f.install, first);
  assert.equal(await readInstalledRecord(f.install), null);
  await installRelease(f.install, first, () => {}, { retryDelayMs: 1 });
  let record = await readInstalledRecord(f.install);
  assert.equal(record.release, '1.3.0');
  assert.equal(record.manifestSha256, first.manifestSha256);
  assert.deepEqual(record.launch, { executable: 'SlumsMS.exe', args: [] });
  assert.deepEqual(record.layers.map(({ name, version }) => [name, version]), [['base', 'v83-b1'], ['client', '1.3.0']]);

  // 1.4.0 ships a changed client: verifying against it leaves 1.3.0 recorded.
  await writeFile(path.join(f.client, 'SlumsMS.exe'), 'slums v2');
  await f.publish('1.4.0', '1.4.0');
  const second = await loadRelease(f.url, { installDir: f.install });
  assert.equal((await inspectRelease(f.install, second)).files.length, 1);
  assert.equal((await readInstalledRecord(f.install)).release, '1.3.0');
  await installRelease(f.install, second, () => {}, { retryDelayMs: 1 });
  record = await readInstalledRecord(f.install);
  assert.equal(record.release, '1.4.0');
  assert.deepEqual(record.layers.map(({ name, version }) => [name, version]), [['base', 'v83-b1'], ['client', '1.4.0']]);

  // An existing install without a record gets one from the next clean verify (no download needed).
  await unlink(path.join(f.install, RECORD));
  assert.deepEqual((await inspectRelease(f.install, second)).files, []);
  assert.equal((await readInstalledRecord(f.install)).release, '1.4.0');
});

test('availability check fetches only the top-level manifest', async (t) => {
  const f = await fixture(t);
  await f.publish('1.4.0', '1.4.0', 'v83-2026.10.19');
  f.requests.length = 0;
  const result = await checkAvailableRelease(f.url);
  assert.equal(result.status, 'ok');
  assert.equal(result.version, '1.4.0');
  assert.deepEqual(result.layers, [{ name: 'base', version: 'v83-2026.10.19' }, { name: 'client', version: '1.4.0' }]);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(f.requests, ['manifest.json']);
});

test('availability check sends the access key and reports 401 as access-key, without retrying', async (t) => {
  const f = await fixture(t, { key: 'friends-only' });
  await f.publish('1.4.0', '1.4.0');
  assert.equal((await checkAvailableRelease(f.url, { accessKey: 'friends-only' })).version, '1.4.0');
  f.requests.length = 0;
  const denied = await checkAvailableRelease(f.url, { accessKey: 'wrong' });
  assert.equal(denied.status, 'access-key');
  assert.deepEqual(f.requests, ['manifest.json']);
  assert.equal((await checkAvailableRelease(f.url)).status, 'access-key');
});

test('availability check reports offline, missing and unreadable manifests without throwing', async (t) => {
  const f = await fixture(t);
  // Nothing published yet: 404.
  assert.equal((await checkAvailableRelease(f.url)).status, 'error');
  await mkdir(f.output, { recursive: true });
  await writeFile(path.join(f.output, 'manifest.json'), '{broken');
  assert.equal((await checkAvailableRelease(f.url)).status, 'error');
  // A closed port: connection refused.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.equal((await checkAvailableRelease(`http://127.0.0.1:${port}/manifest.json`)).status, 'offline');
  // A server that never answers: timeout.
  const stalled = await checkAvailableRelease(f.url.replace('manifest.json', 'never'), { signal: AbortSignal.abort(new DOMException('timed out', 'TimeoutError')) });
  assert.equal(stalled.status, 'offline');
  // An invalid feed URL is an error, not a crash.
  assert.equal((await checkAvailableRelease('not a url')).status, 'error');
});

test('version status maps installed/available to labels and the highlight kind', () => {
  const installed = (version) => ({ status: 'installed', version, layers: [{ name: 'base', version: 'v83-2026.10.19' }, { name: 'client', version }] });
  const available = (version) => ({ status: 'ok', version, layers: [{ name: 'base', version: 'v83-2026.10.19' }, { name: 'client', version }] });

  const same = versionStatus(installed('1.4.0'), available('1.4.0'));
  assert.deepEqual([same.kind, same.installedLabel, same.availableLabel, same.note], ['up-to-date', '1.4.0', '1.4.0', 'Up to date']);
  assert.equal(same.installedTitle, 'base v83-2026.10.19 · client 1.4.0');

  const newer = versionStatus(installed('1.3.0'), available('1.4.0'));
  assert.deepEqual([newer.kind, newer.installedLabel, newer.availableLabel, newer.note], ['update-available', '1.3.0', '1.4.0', 'Update available']);

  const fresh = versionStatus({ status: 'not-installed' }, available('1.4.0'));
  assert.deepEqual([fresh.kind, fresh.installedLabel, fresh.availableLabel], ['not-installed', 'Not installed', '1.4.0']);

  const unknown = versionStatus({ status: 'unknown' }, available('1.4.0'));
  assert.deepEqual([unknown.kind, unknown.installedLabel], ['unknown', 'Unknown']);
  assert.equal(versionStatus(undefined, undefined).installedLabel, 'Unknown');

  for (const status of ['offline', 'access-key', 'error']) {
    const failed = versionStatus(installed('1.3.0'), { status });
    assert.deepEqual([failed.kind, failed.installedLabel, failed.availableLabel, failed.note], ['couldnt-check', '1.3.0', 'Couldn’t check', '']);
  }
  assert.match(versionStatus(installed('1.3.0'), { status: 'access-key' }).availableTitle, /access key/u);

  const pending = versionStatus(installed('1.3.0'), { status: 'checking' });
  assert.deepEqual([pending.kind, pending.availableLabel], ['checking', 'Checking…']);
});

test('settings footer shows launcher, installed and available versions', () => {
  assert.equal(versionFooter('1.3.2', { status: 'installed', version: '1.3.0' }, { status: 'ok', version: '1.4.0' }), 'Launcher 1.3.2 · Game installed 1.3.0 / available 1.4.0');
  assert.equal(versionFooter('1.3.2', { status: 'unknown' }, { status: 'offline' }), 'Launcher 1.3.2 · Game installed Unknown / available Couldn’t check');
  assert.equal(versionFooter('', { status: 'not-installed' }, { status: 'ok', version: '1.4.0' }), 'Game installed Not installed / available 1.4.0');
});
