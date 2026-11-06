import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publishLayer, publishLayeredRelease } from '../tools/publish.mjs';
import { validateManifest } from '../src/updater.mjs';

const run = promisify(execFile);
const PUBLISH = path.resolve('tools/publish.mjs');

async function published(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-minbuild-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'SlumsMS.exe'), 'slums');
  const output = path.join(root, 'out');
  await publishLayer({ source: src, output, layer: 'client', version: 'c1' });
  return { output, layers: [{ name: 'client', version: 'c1' }] };
}

const manifestOf = async (output) => JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));

test('the release manifest carries minClientBuild when the publisher is given one', async (t) => {
  const { output, layers } = await published(t);
  const top = await publishLayeredRelease({ output, version: 'r1', layers, minClientBuild: 10740 });
  assert.equal(top.minClientBuild, 10740);
  assert.equal((await manifestOf(output)).minClientBuild, 10740);
});

test('without a value the manifest has no minClientBuild: launchers do not check (the kill switch)', async (t) => {
  const { output, layers } = await published(t);
  await publishLayeredRelease({ output, version: 'r1', layers });
  assert.equal(Object.hasOwn(await manifestOf(output), 'minClientBuild'), false);
});

test('the publisher refuses a value that is not a build number, and publishes nothing', async (t) => {
  const { output, layers } = await published(t);
  for (const bad of [0, -1, 1.5, '10740', 100000000, NaN, null]) {
    await assert.rejects(publishLayeredRelease({ output, version: 'r1', layers, minClientBuild: bad }), /min-client-build/, String(bad));
  }
  await assert.rejects(readFile(path.join(output, 'manifest.json')), { code: 'ENOENT' });
});

test('a reader keeps a good minClientBuild and drops a malformed one instead of failing', () => {
  const base = { schemaVersion: 2, version: 'r1', launch: { executable: 'SlumsMS.exe', args: [] }, layers: [{ name: 'client', version: 'c1', manifestUrl: 'layers/client/c1/manifest.json', sha256: 'a'.repeat(64) }] };
  assert.equal(validateManifest({ ...base, minClientBuild: 10740 }).minClientBuild, 10740);
  for (const bad of ['10740', 0, -5, 1.5, null, [10740]]) assert.equal(Object.hasOwn(validateManifest({ ...base, minClientBuild: bad }), 'minClientBuild'), false, String(bad));
});

test('the command line flag writes the manifest field and rejects odd values', async (t) => {
  const { output } = await published(t);
  await assert.rejects(run(process.execPath, [PUBLISH, '--release', 'r1', '--out', output, '--use', 'client@c1', '--min-client-build', '10x40']), /whole number/);
  await assert.rejects(run(process.execPath, [PUBLISH, '--layer', 'x', '--source', '.', '--out', output, '--version', 'v', '--min-client-build', '10740']), /requires --release/);
  await run(process.execPath, [PUBLISH, '--release', 'r1', '--out', output, '--use', 'client@c1', '--min-client-build', '10740']);
  assert.equal((await manifestOf(output)).minClientBuild, 10740);
});
