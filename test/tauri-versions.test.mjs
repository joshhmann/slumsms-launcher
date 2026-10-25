import test from 'node:test';
import assert from 'node:assert/strict';
import { versionStatus, versionFooter, clientVersion, clientUpdateNote, buildNumber, launcherLabel, actionHelp } from '../tauri/ui/version-status.mjs';

const installed = (version, extra = {}) => ({ status: 'installed', version, layers: [{ name: 'base', version: 'v83-2026.10.19' }, { name: 'client', version: '1.5.0' }], ...extra });
const available = (version, extra = {}) => ({ status: 'ok', version, layers: [], ...extra });
const file = (release, build) => ({ clientBuild: { release, build } });

test('build numbers are major*10000+minor*100+patch', () => {
  assert.equal(buildNumber('1.6.0'), 10600);
  assert.equal(buildNumber('1.5.4'), 10504);
  assert.equal(buildNumber('2.0.10'), 20010);
  for (const bad of ['v83-2026.10.19', '2026.10.19-1', '1.6', '1.6.0-rc1', '', undefined, 10600]) assert.ok(Number.isNaN(buildNumber(bad)), String(bad));
});

test('the client comes from slums-build.txt, then the client layer, else Unknown', () => {
  assert.deepEqual(clientVersion(installed('1.6.0', file('1.6.0', 10600))), { label: '1.6.0 (build 10600)', title: 'From slums-build.txt in the game folder.', build: 10600, source: 'file' });
  // Clients before 1.6.0 have no file: the installed record's client layer.
  const layer = clientVersion(installed('1.5.3'));
  assert.equal(layer.label, '1.5.0');
  assert.equal(layer.build, 10500);
  assert.equal(layer.source, 'layer');
  // A client layer with a date-style version is shown but its build is unknown.
  assert.ok(Number.isNaN(clientVersion({ status: 'installed', version: 'x', layers: [{ name: 'client', version: '2026.10.19-1' }] }).build));
  // An unverified folder can still have the file.
  assert.equal(clientVersion({ status: 'unknown', ...file('1.6.0', 10600) }).label, '1.6.0 (build 10600)');
  for (const nothing of [undefined, null, { status: 'unknown' }, { status: 'not-installed', ...file('1.6.0', 10600) }, { status: 'installed', version: '1', layers: [{ name: 'base', version: 'v83' }] },
    { status: 'installed', version: '1', layers: 'nope', clientBuild: { release: '', build: 10600 } }, { status: 'unknown', clientBuild: { release: '1.6.0', build: '10600' } }]) {
    assert.equal(clientVersion(nothing).label, 'Unknown', JSON.stringify(nothing));
  }
});

test('minClientBuild: a note only when the server names one and the client is known to be older', () => {
  const note = 'Client update needed: the server needs build 10600 or newer';
  assert.equal(clientUpdateNote(installed('1.5.3', file('1.5.9', 10509)), available('1.6.0', { minClientBuild: 10600 })), note);
  assert.equal(clientUpdateNote(installed('1.5.3'), available('1.6.0', { minClientBuild: 10600 })), note, 'client layer 1.5.0 is build 10500');
  assert.equal(clientUpdateNote(installed('1.6.0', file('1.6.0', 10600)), available('1.6.0', { minClientBuild: 10600 })), '', 'equal is fine');
  assert.equal(clientUpdateNote(installed('1.6.1', file('1.6.1', 10601)), available('1.6.1', { minClientBuild: 10600 })), '');
  assert.equal(clientUpdateNote(installed('1.5.3', file('1.5.3', 10503)), available('1.6.0')), '', 'absent field = no check');
  assert.equal(clientUpdateNote({ status: 'unknown' }, available('1.6.0', { minClientBuild: 10600 })), '', 'unknown client = no check');
  assert.equal(clientUpdateNote({ status: 'not-installed' }, available('1.6.0', { minClientBuild: 10600 })), '');
  assert.equal(clientUpdateNote(installed('1.5.3', file('1.5.3', 10503)), { status: 'offline', minClientBuild: 10600 }), '');
  for (const odd of ['10600', -1, 0, 1.5, null]) assert.equal(clientUpdateNote(installed('1.5.3', file('1.5.3', 10503)), available('1.6.0', { minClientBuild: odd })), '', String(odd));
});

test('versionStatus labels the server, installed release and client', () => {
  const s = versionStatus(installed('1.6.0', file('1.6.0', 10600)), available('1.6.0', { minClientBuild: 10600 }));
  assert.equal(s.serverLabel, '1.6.0');
  assert.equal(s.availableLabel, '1.6.0');
  assert.equal(s.installedLabel, '1.6.0');
  assert.equal(s.clientLabel, '1.6.0 (build 10600)');
  assert.equal(s.clientKnown, true);
  assert.equal(s.kind, 'up-to-date');
  assert.equal(s.note, 'Up to date');
  assert.equal(s.clientNote, '');

  const behind = versionStatus(installed('1.5.3'), available('1.5.4'));
  assert.equal(behind.kind, 'update-available');
  assert.equal(behind.serverLabel, '1.5.4');
  assert.equal(behind.clientLabel, '1.5.0');

  assert.equal(versionStatus({ status: 'unknown' }, { status: 'checking' }).clientKnown, false);
  assert.equal(versionStatus(undefined, undefined).clientLabel, 'Unknown');
});

test('an outdated client turns the panel into an update with a clear note', () => {
  // Same release recorded, but the server needs a newer client build.
  const s = versionStatus(installed('1.6.0', file('1.5.9', 10509)), available('1.6.0', { minClientBuild: 10600 }));
  assert.equal(s.kind, 'update-available', 'Play then updates');
  assert.equal(s.note, 'Client update needed');
  assert.equal(s.clientNote, 'Client update needed: the server needs build 10600 or newer');
  assert.match(s.clientTitle, /build 10600 or newer\.$/u);
  // An unverified folder with an old build file also gets it.
  assert.equal(versionStatus({ status: 'unknown', ...file('1.5.3', 10503) }, available('1.6.0', { minClientBuild: 10600 })).kind, 'update-available');
  // Not installed stays "Not installed".
  assert.equal(versionStatus({ status: 'not-installed' }, available('1.6.0', { minClientBuild: 10600 })).kind, 'not-installed');
});

test('the help line carries the client note when Play would update', () => {
  const base = { bridgeAvailable: true, initialized: true, phase: 'ready', busy: false, feedUrl: 'https://example.test/manifest.json', actionKind: 'update', canPlay: true, offlinePlay: false, resuming: false, fresh: false, accessKeyNeeded: false };
  const clientNote = 'Client update needed: the server needs build 10600 or newer';
  assert.equal(actionHelp({ ...base, clientNote }), `${clientNote}. Update installs it, then starts the game.`);
  assert.match(actionHelp({ ...base, phase: 'needs-update', canPlay: false, clientNote }), /^Client update needed.*only the files that changed/u);
  assert.match(actionHelp({ ...base, busy: true, clientNote }), /Keep the launcher open/u);
  assert.match(actionHelp({ ...base }), /new release is out/u, 'no note = unchanged');
});

test('footer and launcher row show the launcher version', () => {
  assert.equal(versionFooter('1.5.2', installed('1.5.3', file('1.5.3', 10503)), available('1.5.4')), 'Launcher 1.5.2 · Server 1.5.4 · Installed 1.5.3 · Client 1.5.3 (build 10503)');
  assert.equal(versionFooter('', { status: 'not-installed' }, { status: 'offline' }), 'Server Couldn’t check · Installed Not installed · Client Unknown');
  assert.equal(launcherLabel('1.5.2'), '1.5.2');
  assert.equal(launcherLabel(''), 'Unknown');
  assert.equal(launcherLabel(undefined), 'Unknown');
});
