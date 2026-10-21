import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFeeds, channelOfFeed, probeChannels, accessibleChannels, showChannelPicker, effectiveChannel, selfUpdateFeed,
  channelInstallDir, folderOwner, folderChannel, migrateLegacySettings, applyMigrationAnswer } from '../src/channels.mjs';

const LIVE = 'https://slumspatch.asslorde.com/manifest.json';
const feeds = channelFeeds(LIVE);
const ok = (version, sha) => ({ status: 'ok', version, manifestSha256: sha, layers: [] });
const denied = { status: 'access-key', message: 'x' };

test('channel feeds sit beside the live manifest', () => {
  assert.deepEqual(feeds, { live: LIVE, test: 'https://slumspatch.asslorde.com/launcher-test/manifest.json', rc: 'https://slumspatch.asslorde.com/launcher-rc/manifest.json' });
  assert.equal(channelOfFeed(feeds.rc, LIVE), 'rc');
  assert.equal(channelOfFeed('https://elsewhere.example/manifest.json', LIVE), null);
});

test('probing: a player key opens Live only, the dev key opens all three', async () => {
  const player = await probeChannels(feeds, { accessKey: 'p', check: async url => (url === LIVE ? ok('1.4.1', 'a') : denied) });
  assert.deepEqual(accessibleChannels(player), ['live']);
  assert.equal(showChannelPicker(player), false);
  const dev = await probeChannels(feeds, { accessKey: 'd', check: async () => ok('1.4.1', 'a') });
  assert.deepEqual(accessibleChannels(dev), ['live', 'test', 'rc']);
  assert.equal(showChannelPicker(dev), true);
});

test('a refused channel falls back to Live; offline keeps the choice; self-update follows', () => {
  assert.equal(effectiveChannel('rc', { rc: denied }), 'live');
  assert.equal(effectiveChannel('rc', { rc: { status: 'offline' } }), 'rc');
  assert.equal(selfUpdateFeed({ selected: 'rc', probes: { rc: denied }, liveFeedUrl: LIVE }), LIVE);
  assert.equal(selfUpdateFeed({ selected: 'test', probes: { test: ok('x', 'b') }, liveFeedUrl: LIVE }), feeds.test);
});

test('per-channel folders default beside Live and never share', () => {
  const base = { standaloneDir: 'C:\\Users\\p\\AppData\\Local\\SlumsMS' };
  assert.equal(channelInstallDir('live', base), base.standaloneDir);
  assert.equal(channelInstallDir('test', base), `${base.standaloneDir}-test`);
  assert.equal(channelInstallDir('rc', { ...base, saved: { live: 'D:\\Maple' } }), 'D:\\Maple-rc');
  assert.equal(folderOwner('d:\\maple', 'rc', { live: 'D:\\Maple', test: '', rc: '' }, 'win32'), 'live');
});

test('migration: default appdata install and a custom live folder stay Live', () => {
  const probes = { live: ok('1.4.1', 'L') };
  let result = migrateLegacySettings({ feedUrl: LIVE }, { liveFeedUrl: LIVE, folder: null, probes });
  assert.deepEqual([result.settings.channel, result.settings.folders.live, result.question], ['live', '', null]);
  result = migrateLegacySettings({ feedUrl: LIVE, installDir: 'E:\\Games\\SlumsMS' }, { liveFeedUrl: LIVE, folder: { holdsGame: true, record: { release: '1.4.1', manifestSha256: 'L' } }, probes });
  assert.equal(result.settings.folders.live, 'E:\\Games\\SlumsMS');
  result = migrateLegacySettings({ installDir: 'E:\\empty' }, { liveFeedUrl: LIVE, folder: { holdsGame: false }, probes });
  assert.equal(result.settings.folders.live, '');
});

test("migration: the owner's polluted settings (rc feed + test folder) never become Live", () => {
  const probes = { live: ok('1.4.1', 'L'), test: ok('1.4.1-test', 'T'), rc: ok('1.4.0', 'R') };
  const legacy = { feedUrl: feeds.rc, installDir: 'Z:\\SlumsMS-test' };
  const result = migrateLegacySettings(legacy, { liveFeedUrl: LIVE, folder: { holdsGame: true, record: { release: '1.4.1-test', manifestSha256: 'T' } }, probes });
  assert.equal(result.settings.channel, 'rc');
  assert.equal(result.settings.folders.live, '');
  assert.deepEqual([result.question.suggested, result.question.conflict], ['test', true]);
  assert.match(result.question.message, /looks like a Test install/);
  assert.equal(applyMigrationAnswer(result.settings, result.question, 'test').folders.test, 'Z:\\SlumsMS-test');
  assert.equal(applyMigrationAnswer(result.settings, result.question, null).folders.live, '');
});

test('folder channel: exact manifest, then unique release name, then name hint', () => {
  const probes = { live: ok('1.4.1', 'L'), rc: ok('1.4.1', 'R') };
  assert.equal(folderChannel({ release: '1.4.1', manifestSha256: 'R' }, probes), 'rc');
  assert.equal(folderChannel({ release: '1.4.1', manifestSha256: 'X' }, probes), null);
  assert.equal(folderChannel({ release: '1.4.2-rc1', manifestSha256: 'X' }, probes), 'rc');
});
