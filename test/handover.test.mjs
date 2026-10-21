import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadTauriChannel, downloadTauriBuild, validateTauriChannel, verifyTauriSignature, handoverToTauri, handoverMarker, TAURI_PUBLIC_KEY } from '../src/handover.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'handover');
const KEY = 'friends-only:key';
const basic = (key) => `Basic ${Buffer.from(`slums:${key}`).toString('base64')}`;

async function server(t, handler) {
  const requests = [];
  const instance = createServer((request, response) => {
    requests.push({ path: new URL(request.url, 'http://x').pathname, authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); });
  return { base: `http://127.0.0.1:${instance.address().port}`, requests };
}

const channelJson = (url, version = '1.5.0', signature = 'c2ln') => JSON.stringify({ version, notes: '', pub_date: '2026-10-21T00:00:00Z', platforms: { 'windows-x86_64': { url, signature } } });

test('the Tauri channel is read from the feed origin with the key; none published is null', async (t) => {
  let body = null;
  const feed = await server(t, (request, response) => {
    if (request.headers.authorization !== basic(KEY)) { response.writeHead(401); response.end(); return; }
    if (request.url === '/tauri/launcher.json' && body) { response.writeHead(200); response.end(body(feed.base)); return; }
    response.writeHead(404); response.end();
  });
  const feedUrl = `${feed.base}/manifest.json`;
  assert.equal(await loadTauriChannel(feedUrl, { accessKey: KEY }), null);
  body = (base) => channelJson(`${base}/tauri/1.5.0/SlumsMS%20Launcher.exe`);
  const channel = await loadTauriChannel(feedUrl, { accessKey: KEY });
  assert.equal(channel.version, '1.5.0');
  assert.equal(channel.url, `${feed.base}/tauri/1.5.0/SlumsMS%20Launcher.exe`);
  assert.ok(feed.requests.every((r) => r.authorization === basic(KEY)));
  await assert.rejects(loadTauriChannel(feedUrl, { accessKey: 'wrong' }), (error) => error.code === 'ACCESS_KEY_REQUIRED');
});

test('the build must be on the feed origin over HTTPS (loopback HTTP for development) with a real version', () => {
  const feed = 'https://slumspatch.asslorde.com/manifest.json';
  assert.equal(validateTauriChannel(JSON.parse(channelJson('https://slumspatch.asslorde.com/tauri/1.5.0/x.exe')), feed).version, '1.5.0');
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('https://cdn.example/x.exe')), feed), /patch server itself/);
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('http://slumspatch.asslorde.com/x.exe')), feed), /HTTPS/);
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('http://example.com/x.exe')), 'http://example.com/manifest.json'), /HTTPS/);
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('https://slumspatch.asslorde.com/x.exe', '1.5')), feed), /MAJOR.MINOR.PATCH/);
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('https://slumspatch.asslorde.com/x.exe', '1.5.0', '')), feed), /signature/);
  assert.throws(() => validateTauriChannel(JSON.parse(channelJson('tauri/x.exe')), feed), /absolute/);
  assert.throws(() => validateTauriChannel({ version: '1.5.0', platforms: {} }, feed), /windows-x86_64/);
});

test('a download that redirects off the feed origin never carries the key', async (t) => {
  const other = await server(t, (request, response) => { response.writeHead(200); response.end('MZ'); });
  const feed = await server(t, (request, response) => { response.writeHead(302, { Location: `${other.base}/exe` }); response.end(); });
  const bytes = await downloadTauriBuild(`${feed.base}/manifest.json`, { url: `${feed.base}/tauri/x.exe` }, { accessKey: KEY });
  assert.equal(bytes.toString(), 'MZ');
  assert.equal(feed.requests[0].authorization, basic(KEY));
  assert.equal(other.requests[0].authorization, undefined);
});

test('a real tauri-signer signature verifies; a flipped byte, another key, another version or a tampered comment fail', async () => {
  const bytes = await readFile(path.join(fixtures, 'fake-launcher.exe'));
  const signature = (await readFile(path.join(fixtures, 'fake-launcher.exe.sig'), 'utf8')).trim();
  const key = (await readFile(path.join(fixtures, 'test.key.pub'), 'utf8')).trim();
  assert.equal(verifyTauriSignature(bytes, signature, key, '1.5.0'), true);
  const flipped = Buffer.from(bytes);
  flipped[3] ^= 1;
  assert.throws(() => verifyTauriSignature(flipped, signature, key, '1.5.0'), /does not match/);
  assert.throws(() => verifyTauriSignature(bytes, signature, TAURI_PUBLIC_KEY, '1.5.0'), /different key/);
  assert.throws(() => verifyTauriSignature(bytes, signature, key, '1.5.1'), /signed for version 1\.5\.0/);
  const text = Buffer.from(signature, 'base64').toString('utf8').replace('version:1.5.0', 'version:1.5.1');
  assert.throws(() => verifyTauriSignature(bytes, Buffer.from(text).toString('base64'), key, '1.5.1'), /tampered/);
});

async function launcherFolder(t, tauriScript) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slumsms-handover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'SlumsMS Launcher.exe'), '#!/bin/sh\necho electron\n', { mode: 0o755 });
  await mkdir(path.join(dir, 'resources'));
  await writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
  return { dir, bytes: Buffer.from(`#!/bin/sh\n${tauriScript(dir)}\n`) };
}

test('a Tauri build that reports healthy takes over; the Electron exe is kept for rollback', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, bytes } = await launcherFolder(t, (d) => `touch '${handoverMarker(d, '1.5.0')}'; sleep 1`);
  const notes = [];
  const result = await handoverToTauri({ launcherDir: dir, bytes, version: '1.5.0', fromVersion: '1.5.0', log: (m) => notes.push(m), healthTimeoutMs: 10_000 });
  assert.equal(result, 'handed-over');
  assert.match(await readFile(path.join(dir, 'SlumsMS Launcher.exe'), 'utf8'), /touch/);
  assert.match(await readFile(path.join(dir, '.slumsms-launcher-update', 'electron-rollback', 'SlumsMS Launcher.exe'), 'utf8'), /electron/);
  assert.equal(await readFile(path.join(dir, 'resources', 'app.asar'), 'utf8'), 'asar', 'other Electron files stay');
});

test('a Tauri build that exits early or hangs is rolled back and the Electron exe restored', { skip: process.platform === 'win32' }, async (t) => {
  for (const [script, timeout, pattern] of [[() => 'exit 3', 10_000, /exited/], [() => 'sleep 30', 800, /in time/]]) {
    const { dir, bytes } = await launcherFolder(t, script);
    const result = await handoverToTauri({ launcherDir: dir, bytes, version: '1.5.0', fromVersion: '1.5.0', healthTimeoutMs: timeout });
    assert.match(result, pattern);
    assert.match(await readFile(path.join(dir, 'SlumsMS Launcher.exe'), 'utf8'), /electron/);
    assert.ok((await readdir(path.join(dir, '.slumsms-launcher-update'))).some((name) => name.startsWith('failed-handover-1.5.0')));
  }
});
