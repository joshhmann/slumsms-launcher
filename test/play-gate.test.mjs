import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { playPlan, feedLabel } from '../src/version-status.mjs';
import { installKey, settingsPath, loadInstallSettings, writeInstallSettings } from '../src/settings-store.mjs';

const ok = (sha, version = '1.4.1') => ({ status: 'ok', version, layers: [], manifestSha256: sha });

test('Play updates first when the server offers a release the folder is not', () => {
  const record = { release: '1.4.0', manifestSha256: 'a'.repeat(64) };
  assert.equal(playPlan({ offered: ok('b'.repeat(64)), record }), 'update');
  // A republish under the same version is still a different manifest.
  assert.equal(playPlan({ offered: ok('b'.repeat(64), '1.4.0'), record }), 'update');
  assert.equal(playPlan({ offered: ok('a'.repeat(64), '1.4.0'), record }), 'verify');
  // No record (never verified, or pre-record client): let the update path inspect and fill it.
  assert.equal(playPlan({ offered: ok('a'.repeat(64)), record: null }), 'update');
  assert.equal(playPlan({ offered: ok('a'.repeat(64)), record: { release: '1.4.0', manifestSha256: '' } }), 'update');
});

test('Play starts the installed client when the server cannot be asked', () => {
  const record = { release: '1.4.0', manifestSha256: 'a'.repeat(64) };
  for (const status of ['offline', 'access-key', 'error']) assert.equal(playPlan({ offered: { status, message: 'x' }, record }), 'offline');
  assert.equal(playPlan({ offered: undefined, record }), 'offline');
});

test('feed line names live, test and custom feeds and warns off the default', () => {
  const live = 'https://slumspatch.asslorde.com/manifest.json';
  const rc = 'https://slumspatch.asslorde.com/launcher-rc/manifest.json';
  assert.deepEqual(feedLabel(live, { liveFeedUrl: live, defaultFeedUrl: live }), { name: 'live', warn: false, text: 'Feed: live' });
  assert.deepEqual(feedLabel(rc, { liveFeedUrl: live, defaultFeedUrl: live }),
    { name: 'test (launcher-rc)', warn: true, text: 'Feed: test (launcher-rc) · not this launcher’s default' });
  // A test build that ships the rc feed as its default does not warn.
  assert.equal(feedLabel(rc, { liveFeedUrl: live, defaultFeedUrl: rc }).text, 'Feed: test (launcher-rc)');
  assert.equal(feedLabel(live, { liveFeedUrl: live, defaultFeedUrl: rc }).text, 'Feed: live · not this launcher’s default');
  assert.equal(feedLabel('http://localhost:8080/rel/manifest.json', { liveFeedUrl: live, defaultFeedUrl: live }).name, 'custom (localhost:8080/rel)');
  assert.equal(feedLabel('', { liveFeedUrl: live, defaultFeedUrl: live }).warn, true);
});

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('settings are kept per launcher folder (case-insensitive on Windows)', () => {
  assert.equal(installKey('C:\\Games\\Launcher', 'win32'), installKey('c:\\games\\launcher\\', 'win32'));
  assert.notEqual(installKey('/opt/a'), installKey('/opt/b'));
  assert.notEqual(settingsPath('/u', '/opt/a'), settingsPath('/u', '/opt/b'));
});

test('the old shared settings.json moves to the first launcher that starts, once', async (t) => {
  const userData = await scratch(t);
  const shared = JSON.stringify({ feedUrl: 'https://slumspatch.asslorde.com/launcher-rc/manifest.json', installDir: 'D:\\test' });
  await writeFile(path.join(userData, 'settings.json'), shared);
  const first = await loadInstallSettings({ userData, launcherDir: '/launchers/test' });
  assert.equal(first.migrated, true);
  assert.equal(first.text, shared);
  assert.equal(await readFile(first.file, 'utf8'), shared);
  // The other launcher starts from its defaults instead of inheriting the test feed and folder.
  const second = await loadInstallSettings({ userData, launcherDir: '/launchers/everyday' });
  assert.deepEqual([second.migrated, second.text], [false, null]);
  // And each reads back only its own file afterwards.
  await writeInstallSettings(second.file, '{"installDir":"Z:\\\\SlumsMS"}');
  assert.equal((await loadInstallSettings({ userData, launcherDir: '/launchers/test' })).text, shared);
  assert.equal((await loadInstallSettings({ userData, launcherDir: '/launchers/everyday' })).text, '{"installDir":"Z:\\\\SlumsMS"}');
  const names = await readdir(userData);
  assert.ok(!names.includes('settings.json'));
  assert.ok(names.some(name => name.startsWith('settings.json.migrated-')));
});

test('no settings anywhere reads as none', async (t) => {
  const userData = await scratch(t);
  await mkdir(path.join(userData, 'installs'), { recursive: true });
  assert.deepEqual((await loadInstallSettings({ userData, launcherDir: '/x' })).text, null);
});
