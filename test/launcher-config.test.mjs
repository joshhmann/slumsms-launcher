import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLauncherConfig, detectBundledClient, standaloneInstallDir, validateFeedUrl } from '../src/launcher-config.mjs';

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('config files layer in order, skip missing files and validate values', async t => {
  const root = await scratch(t);
  const builtIn = path.join(root, 'built-in.json');
  const override = path.join(root, 'override.json');
  await writeFile(builtIn, JSON.stringify({ feedUrl: 'https://example.com/manifest.json', clientExecutable: 'MapleStory.exe' }));
  assert.deepEqual(await readLauncherConfig([builtIn, path.join(root, 'missing.json')]),
    { feedUrl: 'https://example.com/manifest.json', clientExecutable: 'MapleStory.exe' });
  await writeFile(override, JSON.stringify({ feedUrl: 'https://cdn.example.net/live/manifest.json' }));
  assert.deepEqual(await readLauncherConfig([builtIn, override]),
    { feedUrl: 'https://cdn.example.net/live/manifest.json', clientExecutable: 'MapleStory.exe' });
  assert.deepEqual(await readLauncherConfig([]), { feedUrl: '', clientExecutable: '' });

  await writeFile(override, JSON.stringify({ feedUrl: 'http://example.com/manifest.json' }));
  await assert.rejects(readLauncherConfig([override]), /feedUrl is invalid/);
  await writeFile(override, JSON.stringify({ clientExecutable: '../MapleStory.exe' }));
  await assert.rejects(readLauncherConfig([override]), /file name/);
  await writeFile(override, '{ not json');
  await assert.rejects(readLauncherConfig([override]), /not valid JSON/);
});

test('feed URLs require HTTPS except on localhost', () => {
  assert.equal(validateFeedUrl('https://example.com/manifest.json'), 'https://example.com/manifest.json');
  assert.equal(validateFeedUrl('http://127.0.0.1:8080/manifest.json'), 'http://127.0.0.1:8080/manifest.json');
  assert.throws(() => validateFeedUrl('http://example.com/manifest.json'));
  assert.throws(() => validateFeedUrl('not a url'));
});

test('bundled client is found beside the launcher or one folder up', async t => {
  const root = await scratch(t);
  const client = path.join(root, 'client');
  const launcherDir = path.join(client, 'Launcher');
  await mkdir(launcherDir, { recursive: true });
  assert.equal(await detectBundledClient(launcherDir, 'MapleStory.exe'), '');
  await writeFile(path.join(client, 'MapleStory.exe'), 'client');
  assert.equal(await detectBundledClient(launcherDir, 'MapleStory.exe'), client);
  await writeFile(path.join(launcherDir, 'MapleStory.exe'), 'client');
  assert.equal(await detectBundledClient(launcherDir, 'MapleStory.exe'), launcherDir);
  assert.equal(await detectBundledClient(launcherDir, ''), '');
  await mkdir(path.join(root, 'folder.exe'));
  assert.equal(await detectBundledClient(path.join(root, 'x'), 'folder.exe'), '');
});

test('standalone installs default to a per-user folder', () => {
  assert.equal(standaloneInstallDir({ home: 'H', platform: 'win32', env: { LOCALAPPDATA: 'L' } }), path.join('L', 'SlumsMS'));
  assert.equal(standaloneInstallDir({ home: 'H', platform: 'linux', env: {} }), path.join('H', 'SlumsMS'));
  assert.equal(standaloneInstallDir({ home: 'H', platform: 'win32', env: {} }), path.join('H', 'SlumsMS'));
});
