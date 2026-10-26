import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHelp } from '../tauri/ui/version-status.mjs';

const base = { bridgeAvailable: true, initialized: true, phase: 'ready', busy: false, feedUrl: 'https://example.test/manifest.json', actionKind: 'play', canPlay: true, offlinePlay: false, resuming: false, fresh: false, accessKeyNeeded: false };

test('a ready, verified client gets no help line repeating "verified"', () => {
  assert.equal(actionHelp(base), '');
});

test('the help line still explains every other state', () => {
  assert.match(actionHelp({ ...base, actionKind: 'update' }), /new release is out/);
  assert.match(actionHelp({ ...base, offlinePlay: true }), /Couldn’t check for updates/);
  assert.match(actionHelp({ ...base, phase: 'needs-update', canPlay: false, fresh: true }), /Install downloads the game/);
  assert.match(actionHelp({ ...base, phase: 'needs-update', canPlay: false }), /only the files that changed/);
  assert.match(actionHelp({ ...base, phase: 'error', canPlay: false, accessKeyNeeded: true }), /access key/);
  assert.match(actionHelp({ ...base, busy: true }), /Keep the launcher open/);
  assert.match(actionHelp({ ...base, feedUrl: '' }), /Set the update server/);
  assert.equal(actionHelp({ ...base, initialized: false }), 'Starting…');
});

test('the launcher picks one of the two mascots, either one', async () => {
  const { pickMascot, MASCOTS } = await import('../tauri/ui/mascot.mjs');
  assert.deepEqual(MASCOTS, ['girl', 'bucket']);
  assert.equal(pickMascot(() => 0), 'girl');
  assert.equal(pickMascot(() => 0.49), 'girl');
  assert.equal(pickMascot(() => 0.5), 'bucket');
  assert.equal(pickMascot(() => 0.9999), 'bucket');
  assert.equal(pickMascot(() => 1), 'bucket');   // a random() that returns 1 still gives a valid mascot
});
