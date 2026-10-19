import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, stat, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishLayer, publishLayeredRelease, publishRelease } from '../tools/publish.mjs';
import { loadRelease, inspectRelease, installRelease, validateManifest, validateLayerManifest, mergeLayers, readInstallState } from '../src/updater.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-layers-'));
  const base = path.join(root, 'base-src');
  const client = path.join(root, 'client-src');
  const output = path.join(root, 'public');
  const install = path.join(root, 'installed');
  await mkdir(path.join(base, 'Data', 'Mob'), { recursive: true });
  await mkdir(path.join(base, 'Data', 'Map'), { recursive: true });
  await writeFile(path.join(base, 'Data', 'Mob', '0100100.img'), 'snail bytes');
  await writeFile(path.join(base, 'Data', 'Map', 'Map0.img'), 'base map bytes');
  await writeFile(path.join(base, 'MapleStory.exe'), 'maple executable');
  await mkdir(path.join(client, 'Data', 'Map'), { recursive: true });
  await writeFile(path.join(client, 'SlumsMS.exe'), 'slums bootstrap v1');
  await writeFile(path.join(client, 'slums.dll'), 'slums dll v1');
  await writeFile(path.join(client, 'config.ini'), '[config]\nhost=127.0.0.1\n');
  await writeFile(path.join(client, 'Data', 'Map', 'Map0.img'), 'overlay map bytes');
  const requests = [];
  const failures = new Map();
  const server = createServer(async (request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
      requests.push(relative);
      if (failures.get(relative) > 0) {
        failures.set(relative, failures.get(relative) - 1);
        response.writeHead(503);
        response.end();
        return;
      }
      const bytes = await readFile(path.join(output, relative));
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
  const release = (version, layers, extra = {}) => publishLayeredRelease({ output, version, layers, ...extra });
  return { root, base, client, output, install, requests, failures, url, release };
}

async function publishStandard(f, { baseVersion = 'b1', clientVersion = 'c1', release = 'r1' } = {}) {
  await publishLayer({ source: f.base, output: f.output, layer: 'base', version: baseVersion });
  await publishLayer({ source: f.client, output: f.output, layer: 'client', version: clientVersion });
  return f.release(release, [{ name: 'base', version: baseVersion }, { name: 'client', version: clientVersion }]);
}

test('publisher writes immutable layer folders and a top-level manifest that pins layer manifest hashes', async (t) => {
  const f = await fixture(t);
  const layer = await publishLayer({ source: f.base, output: f.output, layer: 'base', version: 'b1' });
  assert.equal(layer.manifestUrl, 'layers/base/b1/manifest.json');
  const layerBody = await readFile(path.join(f.output, 'layers/base/b1/manifest.json'));
  assert.equal(sha(layerBody), layer.sha256);
  const layerManifest = JSON.parse(layerBody);
  assert.equal(layerManifest.schemaVersion, 2);
  assert.equal(layerManifest.layer, 'base');
  assert.deepEqual(layerManifest.files.map((file) => file.path).sort(), ['Data/Map/Map0.img', 'Data/Mob/0100100.img', 'MapleStory.exe']);
  assert.equal(layerManifest.files.find((file) => file.path === 'Data/Mob/0100100.img').url, 'files/Data/Mob/0100100.img');
  assert.equal(await readFile(path.join(f.output, 'layers/base/b1/files/Data/Mob/0100100.img'), 'utf8'), 'snail bytes');
  assert.equal(layerManifest.files.find((file) => file.path === 'MapleStory.exe').sha256, sha('maple executable'));
  // No top-level manifest until a release is written.
  await assert.rejects(stat(path.join(f.output, 'manifest.json')));
  // Immutable: same version (or a Windows alias of it) cannot be republished.
  await assert.rejects(publishLayer({ source: f.base, output: f.output, layer: 'base', version: 'b1' }), /immutable/);
  await assert.rejects(publishLayer({ source: f.base, output: f.output, layer: 'base', version: 'B1' }), /immutable/);
  assert.deepEqual(await readFile(path.join(f.output, 'layers/base/b1/manifest.json')), layerBody);
  await assert.rejects(publishLayer({ source: f.base, output: f.output, layer: '../x', version: 'b2' }));
  await assert.rejects(publishLayer({ source: f.base, output: f.output, layer: 'base', version: '..' }));
  // Top-level manifest references only published layers and needs the executable in one of them.
  await assert.rejects(f.release('r1', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c1' }]), /has not been published/);
  await assert.rejects(f.release('r1', [{ name: 'base', version: 'b1' }]), /SlumsMS\.exe is not in any listed layer/);
  await publishLayer({ source: f.client, output: f.output, layer: 'client', version: 'c1' });
  const top = await f.release('r1', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c1' }]);
  const written = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.deepEqual(written, JSON.parse(JSON.stringify(top)));
  assert.equal(written.schemaVersion, 2);
  assert.deepEqual(written.launch, { executable: 'SlumsMS.exe', args: [] });
  assert.deepEqual(written.playerOwned, ['config.ini']);
  assert.deepEqual(written.layers.map((entry) => [entry.name, entry.version, entry.manifestUrl]),
    [['base', 'b1', 'layers/base/b1/manifest.json'], ['client', 'c1', 'layers/client/c1/manifest.json']]);
  assert.equal(written.layers[0].sha256, layer.sha256);
  await assert.rejects(f.release('r1', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c1' }]), /already the published manifest/);
  const entries = (await readdir(f.output)).sort();
  assert.deepEqual(entries, ['layers', 'manifest.json']);
});

test('later layers override earlier layers for the same path', async (t) => {
  const f = await fixture(t);
  await publishStandard(f);
  await installRelease(f.install, await loadRelease(f.url));
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map0.img'), 'utf8'), 'overlay map bytes');
  assert.equal(await readFile(path.join(f.install, 'Data/Mob/0100100.img'), 'utf8'), 'snail bytes');
  assert.equal(f.requests.filter((request) => request.endsWith('Map0.img')).length, 1);
  // Reversed order: base wins.
  await f.release('r2', [{ name: 'client', version: 'c1' }, { name: 'base', version: 'b1' }]);
  const reversed = await loadRelease(f.url, { installDir: f.install });
  assert.equal(reversed.files.find((file) => file.path === 'Data/Map/Map0.img').layer, 'base');
  await installRelease(f.install, reversed);
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map0.img'), 'utf8'), 'base map bytes');
  // Pure merge semantics, including a case alias between layers.
  const file = (p, s) => ({ path: p, size: 1, sha256: s.repeat(64), url: 'x' });
  assert.deepEqual(mergeLayers([{ name: 'a', files: [file('A.img', 'a'), file('B.img', 'a')] }, { name: 'b', files: [file('A.img', 'b')] }])
    .map((entry) => [entry.path, entry.layer]), [['B.img', 'a'], ['A.img', 'b']]);
  assert.throws(() => mergeLayers([{ name: 'a', files: [file('A.img', 'a')] }, { name: 'b', files: [file('a.IMG', 'b')] }]), /alias/);
  assert.throws(() => mergeLayers([{ name: 'a', files: [file('Data', 'a')] }, { name: 'b', files: [file('Data/x.img', 'b')] }]), /collision/);
});

test('only layers whose version changed are downloaded', async (t) => {
  const f = await fixture(t);
  await publishStandard(f);
  await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }));
  await writeFile(path.join(f.client, 'slums.dll'), 'slums dll v2');
  await publishLayer({ source: f.client, output: f.output, layer: 'client', version: 'c2' });
  await f.release('r2', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c2' }]);
  f.requests.length = 0;
  const release = await loadRelease(f.url, { installDir: f.install });
  assert.deepEqual(release.layers.map((layer) => [layer.name, layer.version, layer.cached]), [['base', 'b1', true], ['client', 'c2', false]]);
  const pending = await installRelease(f.install, release);
  assert.deepEqual(pending.files.map((file) => file.path), ['slums.dll']);
  assert.equal(pending.hashed, 0);
  assert.deepEqual(f.requests, ['manifest.json', 'layers/client/c2/manifest.json', 'layers/client/c2/files/slums.dll']);
  assert.equal(await readFile(path.join(f.install, 'slums.dll'), 'utf8'), 'slums dll v2');
  const state = await readInstallState(f.install);
  assert.equal(state.release, 'r2');
  assert.deepEqual(state.layers.map((layer) => `${layer.name}@${layer.version}`), ['base@b1', 'client@c2']);
  // A tampered top-level layer hash is refused before any file is touched.
  const top = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  top.layers[1].sha256 = '0'.repeat(64);
  await writeFile(path.join(f.output, 'manifest.json'), JSON.stringify(top));
  await assert.rejects(loadRelease(f.url, { installDir: f.install }), /SHA-256/);
});

test('fast verify trusts unchanged size+mtime and hashes only changed or missing files; Repair hashes all', async (t) => {
  const f = await fixture(t);
  await publishStandard(f);
  const release = await loadRelease(f.url, { installDir: f.install });
  await installRelease(f.install, release);
  const fast = () => inspectRelease(f.install, release, () => {}, { mode: 'fast' });
  const full = () => inspectRelease(f.install, release, () => {}, { mode: 'full' });
  const target = path.join(f.install, 'Data/Mob/0100100.img');

  // Unchanged: nothing is hashed.
  assert.deepEqual(await fast(), { files: [], bytes: 0, hashed: 0 });
  const state = await readInstallState(f.install);
  const entry = state.files.get('Data/Mob/0100100.img');
  assert.equal(entry.sha256, sha('snail bytes'));
  assert.equal(entry.size, 'snail bytes'.length);
  assert.equal(typeof entry.mtimeMs, 'number');

  // Size change: caught without hashing.
  await writeFile(target, 'tampered longer snail');
  let result = await fast();
  assert.deepEqual(result.files.map((file) => file.path), ['Data/Mob/0100100.img']);
  assert.equal(result.hashed, 0);
  await installRelease(f.install, release);

  // mtime change with identical bytes: hashed once, found valid, then trusted again.
  const later = new Date(Date.now() + 60_000);
  await utimes(target, later, later);
  result = await fast();
  assert.deepEqual(result, { files: [], bytes: 0, hashed: 1 });
  assert.equal((await fast()).hashed, 0);

  // Same-size tamper that also changes mtime: hashed and caught.
  await writeFile(target, 'snail bytEs');
  result = await fast();
  assert.deepEqual(result.files.map((file) => file.path), ['Data/Mob/0100100.img']);
  assert.equal(result.hashed, 1);
  await installRelease(f.install, release);
  assert.equal(await readFile(target, 'utf8'), 'snail bytes');

  // Missing file.
  await unlink(path.join(f.install, 'slums.dll'));
  assert.deepEqual((await fast()).files.map((file) => file.path), ['slums.dll']);
  await installRelease(f.install, release);

  // Documented limit: a same-size edit that restores the old mtime is only caught by Repair (full).
  const fixed = 1_700_000_000; // whole seconds, so restoring the timestamp is exact
  await utimes(target, fixed, fixed);
  assert.equal((await fast()).hashed, 1);
  await writeFile(target, 'snail BYTES');
  await utimes(target, fixed, fixed);
  assert.equal((await fast()).files.length, 0);
  const repair = await full();
  assert.deepEqual(repair.files.map((file) => file.path), ['Data/Mob/0100100.img']);
  assert.equal(repair.hashed, release.files.length - 1); // every managed file except player-owned config.ini
  await installRelease(f.install, release, () => {}, { mode: 'full' });
  assert.equal(await readFile(target, 'utf8'), 'snail bytes');
});

test('player-owned config.ini installs once, survives updates and Repair, and returns when deleted', async (t) => {
  const f = await fixture(t);
  await publishStandard(f);
  await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }));
  const config = path.join(f.install, 'config.ini');
  assert.equal(await readFile(config, 'utf8'), '[config]\nhost=127.0.0.1\n');
  await writeFile(config, '[config]\nhost=play.example\nport=8484\n');
  await writeFile(path.join(f.client, 'config.ini'), '[config]\nhost=new.default\n');
  await publishLayer({ source: f.client, output: f.output, layer: 'client', version: 'c2' });
  await f.release('r2', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c2' }]);
  const release = await loadRelease(f.url, { installDir: f.install });
  f.requests.length = 0;
  assert.equal((await inspectRelease(f.install, release)).files.length, 0);
  await installRelease(f.install, release, () => {}, { mode: 'full' });
  assert.equal(f.requests.length, 0);
  assert.equal(await readFile(config, 'utf8'), '[config]\nhost=play.example\nport=8484\n');
  await unlink(config);
  await installRelease(f.install, release);
  assert.equal(await readFile(config, 'utf8'), '[config]\nhost=new.default\n');
  // Configurable per release: with no player-owned files, config.ini is managed like any other file.
  await writeFile(config, 'edited');
  await f.release('r3', [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c2' }], { playerOwned: [] });
  const managed = await loadRelease(f.url, { installDir: f.install });
  assert.deepEqual((await inspectRelease(f.install, managed)).files.map((file) => file.path), ['config.ini']);
});

test('schemaVersion 1 manifests still load, install and fast-verify', async (t) => {
  const f = await fixture(t);
  await publishRelease({ source: f.client, output: f.output, version: '1.0.0' });
  const manifest = JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.launch.executable, 'SlumsMS.exe');
  const release = await loadRelease(f.url, { installDir: f.install });
  assert.equal(release.schemaVersion, 1);
  assert.deepEqual(release.layers, []);
  await installRelease(f.install, release);
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map0.img'), 'utf8'), 'overlay map bytes');
  assert.deepEqual(await inspectRelease(f.install, release), { files: [], bytes: 0, hashed: 0 });
  // v1 has no player-owned files unless listed, so a changed config.ini is managed.
  await writeFile(path.join(f.install, 'config.ini'), 'edited!');
  assert.deepEqual((await inspectRelease(f.install, release)).files.map((file) => file.path), ['config.ini']);
});

test('path traversal and reserved paths are rejected in manifests and layer manifests', async (t) => {
  const file = { path: 'SlumsMS.exe', size: 1, sha256: 'a'.repeat(64), url: 'SlumsMS.exe' };
  const v1 = { schemaVersion: 1, version: '1', launch: { executable: 'SlumsMS.exe', args: [] }, files: [file] };
  const layer = { schemaVersion: 2, layer: 'client', version: 'c1', files: [file] };
  const top = { schemaVersion: 2, version: 'r1', launch: { executable: 'SlumsMS.exe', args: [] },
    layers: [{ name: 'client', version: 'c1', manifestUrl: 'layers/client/c1/manifest.json', sha256: 'b'.repeat(64) }] };
  validateManifest(v1);
  validateLayerManifest(layer);
  validateManifest(top);
  const badPaths = ['../escape.dll', 'Data/../../escape.img', '..', './x', '/abs.img', 'C:/Windows/x.dll', 'C:x', '..\\escape', 'Data\\x.img',
    'a//b', 'x/', 'NUL.img', 'Data/CON', '.slumsms-launcher/state.json', '.SlumsMS-Launcher/layers/x.json', '.mapleroot-stage-abc/x'];
  for (const bad of badPaths) {
    assert.throws(() => validateManifest({ ...v1, files: [file, { ...file, path: bad }] }), undefined, `v1 ${bad}`);
    assert.throws(() => validateLayerManifest({ ...layer, files: [file, { ...file, path: bad }] }), undefined, `layer ${bad}`);
    assert.throws(() => validateManifest({ ...top, playerOwned: [bad] }), undefined, `playerOwned ${bad}`);
    assert.throws(() => validateManifest({ ...top, launch: { executable: bad, args: [] } }), undefined, `launch ${bad}`);
  }
  for (const bad of ['https://evil.example/m.json', '//evil.example/m.json', '/layers/m.json', 'file:///etc/passwd', 'a#b', 'a\\b']) {
    assert.throws(() => validateManifest({ ...top, layers: [{ ...top.layers[0], manifestUrl: bad }] }), undefined, `manifestUrl ${bad}`);
    assert.throws(() => validateLayerManifest({ ...layer, files: [{ ...file, url: bad }] }), undefined, `file url ${bad}`);
  }
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'CON']) {
    assert.throws(() => validateManifest({ ...top, layers: [{ ...top.layers[0], version: bad }] }), undefined, `layer version ${bad}`);
    assert.throws(() => validateLayerManifest({ ...layer, version: bad }), undefined, `layer manifest version ${bad}`);
  }
  for (const bad of ['../base', 'a/b', '', '.base']) {
    assert.throws(() => validateManifest({ ...top, layers: [{ ...top.layers[0], name: bad }] }), undefined, `layer name ${bad}`);
  }
  assert.throws(() => validateLayerManifest(layer, { name: 'base', version: 'c1' }), /does not match/);

  // End to end: a hosted layer manifest with a traversal path is rejected even when its hash matches.
  const f = await fixture(t);
  await mkdir(path.join(f.output, 'layers/client/c1'), { recursive: true });
  const evil = JSON.stringify({ ...layer, files: [file, { ...file, path: '../../outside.txt' }] });
  await writeFile(path.join(f.output, 'layers/client/c1/manifest.json'), evil);
  await writeFile(path.join(f.output, 'manifest.json'), JSON.stringify({ ...top, layers: [{ ...top.layers[0], sha256: sha(evil) }] }));
  await assert.rejects(loadRelease(f.url, { installDir: f.install }), /unsafe Windows path component/);
  await assert.rejects(stat(path.join(f.root, 'outside.txt')));
});

test('first install downloads with bounded concurrency, retries transient failures and reports byte progress', async (t) => {
  const f = await fixture(t);
  await publishStandard(f);
  const release = await loadRelease(f.url, { installDir: f.install });
  f.failures.set('layers/base/b1/files/Data/Mob/0100100.img', 2);
  const events = [];
  await installRelease(f.install, release, (event) => events.push(event), { concurrency: 2, retryDelayMs: 1 });
  assert.equal(await readFile(path.join(f.install, 'Data/Mob/0100100.img'), 'utf8'), 'snail bytes');
  assert.equal(f.requests.filter((request) => request.endsWith('0100100.img')).length, 3);
  const last = events.at(-1);
  assert.equal(last.bytesDone, last.bytesTotal);
  assert.equal(last.bytesTotal, release.files.reduce((sum, file) => sum + file.size, 0));
  assert.ok(events.some((event) => /Retrying/.test(event.message)));
  assert.ok(events.every((event) => !('files' in event)));
  // Permanent failures (404) are not retried and fail the install.
  const fresh = path.join(f.root, 'fresh');
  await rm(path.join(f.output, 'layers/client/c1/files/slums.dll'));
  f.requests.length = 0;
  await assert.rejects(installRelease(fresh, release, () => {}, { retryDelayMs: 1 }), /404/);
  assert.equal(f.requests.filter((request) => request.endsWith('slums.dll')).length, 1);
  await assert.rejects(installRelease(fresh, release, () => {}, { concurrency: 0 }), /Concurrency/);
  // Files committed before the failure are recorded, so the resumed install neither re-downloads nor re-hashes them.
  await assert.rejects(installRelease(fresh, release, () => {}, { concurrency: 1, retryDelayMs: 1 }), /404/);
  assert.equal(await readFile(path.join(fresh, 'Data/Mob/0100100.img'), 'utf8'), 'snail bytes');
  await writeFile(path.join(f.output, 'layers/client/c1/files/slums.dll'), 'slums dll v1');
  f.requests.length = 0;
  const resumed = await installRelease(fresh, release, () => {}, { concurrency: 1 });
  assert.equal(resumed.hashed, 0);
  assert.ok(!f.requests.some((request) => request.startsWith('layers/base/')));
  assert.ok(f.requests.includes('layers/client/c1/files/slums.dll'));
});
