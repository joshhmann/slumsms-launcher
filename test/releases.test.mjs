import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishRelease } from '../tools/publish.mjs';
import { loadRelease, inspectRelease, installRelease, validateManifest } from '../src/updater.mjs';

async function fixture(t, redirectFeed = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mapleroot-release-'));
  const source = path.join(root, 'approved');
  const output = path.join(root, 'public');
  const install = path.join(root, 'installed');
  await mkdir(path.join(source, 'Data', 'Map'), { recursive: true });
  await writeFile(path.join(source, 'Client.exe'), 'approved executable bytes');
  await writeFile(path.join(source, 'Data', 'Map', 'Map 1.img'), 'approved IMG bytes');
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let pathname = new URL(request.url, 'http://localhost').pathname;
      if (redirectFeed && pathname === '/latest') {
        response.writeHead(302, { Location: '/channel/manifest.json' });
        response.end();
        return;
      }
      if (redirectFeed) {
        if (!pathname.startsWith('/channel/')) throw new Error('Payload is only hosted under channel.');
        pathname = pathname.slice('/channel'.length);
      }
      const relative = decodeURIComponent(pathname).slice(1);
      requests.push(relative);
      const bytes = await readFile(path.join(output, relative));
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/${redirectFeed ? 'latest' : 'manifest.json'}`;
  const publish = version => publishRelease({ source, output, version, executable: 'Client.exe', args: ['--profile', 'Maple Root'] });
  return { root, source, output, install, requests, publish, url };
}

test('fresh nested install, unchanged scan and repair preserve player-owned files', async t => {
  const f = await fixture(t);
  await f.publish('1.0.0');
  const release = await loadRelease(f.url);
  const missing = await inspectRelease(f.install, release);
  assert.deepEqual(new Set(missing.files.map(file => file.path)), new Set(['Client.exe', 'Data/Map/Map 1.img']));
  await installRelease(f.install, release);
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map 1.img'), 'utf8'), 'approved IMG bytes');
  assert.deepEqual(release.launch.args, ['--profile', 'Maple Root']);
  await writeFile(path.join(f.install, 'config.ini'), 'player preferences');
  f.requests.length = 0;
  assert.equal((await inspectRelease(f.install, release)).files.length, 0);
  await installRelease(f.install, release);
  assert.deepEqual(f.requests, []);
  await writeFile(path.join(f.install, 'Data/Map/Map 1.img'), 'damaged bytes');
  f.requests.length = 0;
  await installRelease(f.install, release);
  assert.deepEqual(f.requests, ['1.0.0/Data/Map/Map 1.img']);
  assert.equal(await readFile(path.join(f.install, 'config.ini'), 'utf8'), 'player preferences');
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map 1.img'), 'utf8'), 'approved IMG bytes');
});

test('corrupt hosted payload cannot partially replace an existing release', async t => {
  const f = await fixture(t);
  await f.publish('1.0.0');
  await installRelease(f.install, await loadRelease(f.url));
  await writeFile(path.join(f.source, 'Client.exe'), 'new executable');
  await writeFile(path.join(f.source, 'Data/Map/Map 1.img'), 'new IMG');
  await f.publish('1.0.1');
  await writeFile(path.join(f.output, '1.0.1/Data/Map/Map 1.img'), 'corrupt');
  await assert.rejects(installRelease(f.install, await loadRelease(f.url)));
  assert.equal(await readFile(path.join(f.install, 'Client.exe'), 'utf8'), 'approved executable bytes');
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map 1.img'), 'utf8'), 'approved IMG bytes');
});

test('publishing is immutable and cannot expose linked files; manifests reject traversal and Windows aliases', async t => {
  const f = await fixture(t);
  await f.publish('1.0.0');
  const original = await readFile(path.join(f.output, 'manifest.json'), 'utf8');
  await assert.rejects(f.publish('1.0.0'));
  assert.equal(await readFile(path.join(f.output, 'manifest.json'), 'utf8'), original);
  await writeFile(path.join(f.root, 'private'), 'private source');
  await symlink(path.join(f.root, 'private'), path.join(f.source, 'linked'));
  await assert.rejects(f.publish('1.0.1'));
  assert.equal(await readFile(path.join(f.output, 'manifest.json'), 'utf8'), original);
  const manifest = JSON.parse(original);
  await assert.rejects(async () => validateManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: '../escape' }] }));
  await assert.rejects(async () => validateManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: 'CON.txt' }] }));
  await assert.rejects(async () => validateManifest({ ...manifest, files: [...manifest.files, { ...manifest.files.find(file => file.path === 'Client.exe'), path: 'client.EXE' }] }));
});

test('redirected feeds resolve file URLs relative to the final manifest location', async t => {
  const f = await fixture(t, true);
  await f.publish('1.0.0');
  await installRelease(f.install, await loadRelease(f.url));
  assert.equal(await readFile(path.join(f.install, 'Data/Map/Map 1.img'), 'utf8'), 'approved IMG bytes');
});
