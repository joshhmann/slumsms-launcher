import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishLayer, publishLayeredRelease, publishPacks } from '../tools/publish.mjs';
import { loadRelease, installRelease, inspectRelease, readInstallState, validateManifest } from '../src/updater.mjs';
import { groupPacks, planPacks, validatePackIndex, rateMeter, downloadMessage, resumeMessage } from '../src/packs.mjs';
import { formatTimeLeft, reuseVerified } from '../src/version-status.mjs';

/** The fields every inspectRelease result has; keptBytes is checked where it matters. */
const core = ({ files, bytes, hashed }) => ({ files, bytes, hashed });

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PACK_SIZE = 4096;

/** Deterministic pseudo-random bytes (incompressible like the client's IMG files). */
function bytesFor(seed, size) {
  const out = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function writeTree(root, files) {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  }
}

/** A base layer of 60 files (duplicates, an empty file, one file bigger than a pack) and a client layer that shadows some of them. */
function sources() {
  const base = {};
  for (let i = 0; i < 56; i += 1) base[`Data/Mob/${String(i).padStart(7, '0')}.img`] = bytesFor(i + 1, 200 + (i * 37) % 900);
  base['Data/Mob/dupe-a.img'] = bytesFor(5, 300);
  base['Data/Mob/dupe-b.img'] = bytesFor(5, 300);
  base['Data/Map/empty.img'] = Buffer.alloc(0);
  base['Data/Map/big.img'] = bytesFor(999, 10_000);
  base['MapleStory.exe'] = bytesFor(1000, 700);
  const client = {
    'SlumsMS.exe': bytesFor(2000, 400),
    'config.ini': Buffer.from('[config]\nhost=127.0.0.1\n'),
    'Data/Mob/0000003.img': base['Data/Mob/0000003.img'], // identical to base
    'Data/Mob/0000004.img': bytesFor(4004, 500), // differs from base
  };
  return { base, client };
}

async function fixture(t, { packClient = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-packs-'));
  const output = path.join(root, 'public');
  const install = path.join(root, 'installed');
  const { base, client } = sources();
  await writeTree(path.join(root, 'base-src'), base);
  await writeTree(path.join(root, 'client-src'), client);
  await publishLayer({ source: path.join(root, 'base-src'), output, layer: 'base', version: 'b1' });
  await publishLayer({ source: path.join(root, 'client-src'), output, layer: 'client', version: 'c1' });
  await publishPacks({ output, layer: 'base', version: 'b1', packSize: PACK_SIZE });
  if (packClient) await publishPacks({ output, layer: 'client', version: 'c1', packSize: PACK_SIZE });
  await publishLayeredRelease({ output, version: 'r1', layers: [{ name: 'base', version: 'b1' }, { name: 'client', version: 'c1' }] });
  const requests = [];
  const behaviour = { ranges: true, cut: new Map(), hang: new Map() };
  const server = createServer(async (request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
      const range = request.headers.range ?? '';
      requests.push(range ? `${relative} ${range}` : relative);
      const bytes = await readFile(path.join(output, relative));
      let body = bytes;
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
      if (match && behaviour.ranges) {
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), bytes.length - 1);
        body = bytes.subarray(start, end + 1);
        response.writeHead(206, { 'Content-Length': body.length, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
      } else response.writeHead(200, { 'Content-Length': bytes.length });
      const cut = behaviour.cut.get(relative);
      if (cut !== undefined) {
        // Drop the connection once, part way into the body.
        behaviour.cut.delete(relative);
        response.write(body.subarray(0, cut), () => response.destroy());
        return;
      }
      const hang = behaviour.hang.get(relative);
      if (hang !== undefined) {
        behaviour.hang.delete(relative);
        response.write(body.subarray(0, hang)); // then never finish
        return;
      }
      response.end(body);
    } catch { if (!response.headersSent) { response.writeHead(404); response.end(); } }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
  const expected = { ...base, ...client };
  async function assertInstalled() {
    for (const [name, bytes] of Object.entries(expected)) assert.deepEqual(await readFile(path.join(install, name)), bytes, name);
    assert.equal((await readdir(install)).filter((entry) => entry.startsWith('.mapleroot-stage-')).length, 0);
  }
  return { root, output, install, requests, behaviour, url, expected, assertInstalled };
}

const fileRequests = (requests) => requests.filter((entry) => entry.includes('/files/'));
const packRequests = (requests) => requests.filter((entry) => entry.includes('.pack'));

test('groupPacks is deterministic, stores each content once and gives an oversized file its own pack', () => {
  const file = (size, digest) => ({ size, sha256: digest.repeat(64) });
  const files = [file(3, 'a'), file(3, 'b'), file(3, 'a'), file(10, 'c'), file(2, 'd'), file(0, 'e')];
  assert.deepEqual(groupPacks(files, 6), [[0, 1], [3], [4, 5]]);
  assert.deepEqual(groupPacks(files, 6), groupPacks(files, 6));
  assert.throws(() => groupPacks(files, 0), /positive/);
});

test('validatePackIndex binds the index to its layer manifest and rejects malformed packs', () => {
  const files = [{ size: 3, sha256: 'a'.repeat(64) }, { size: 5, sha256: 'b'.repeat(64) }];
  const layer = { layer: 'base', version: 'v1', files, manifestSha256: 'f'.repeat(64) };
  const good = { schemaVersion: 1, layer: 'base', version: 'v1', manifestSha256: 'f'.repeat(64), packs: [{ url: '0001.pack', size: 8, sha256: 'c'.repeat(64), files: [1, 0] }] };
  assert.deepEqual(validatePackIndex(good, layer)[0].entries, [{ offset: 0, size: 5, sha256: 'b'.repeat(64) }, { offset: 5, size: 3, sha256: 'a'.repeat(64) }]);
  const bad = (change) => () => validatePackIndex({ ...good, ...change }, layer);
  assert.throws(bad({ layer: 'client' }), /does not match/);
  assert.throws(bad({ manifestSha256: 'e'.repeat(64) }), /different/);
  assert.throws(bad({ packs: [{ ...good.packs[0], size: 9 }] }), /size/);
  assert.throws(bad({ packs: [{ ...good.packs[0], files: [0, 0] }] }), /repeated/);
  assert.throws(bad({ packs: [{ ...good.packs[0], files: [2] }] }), /invalid/);
  assert.throws(bad({ packs: [{ ...good.packs[0], url: '../x.pack' }] }), /plain file name/);
  assert.throws(bad({ packs: [{ ...good.packs[0], url: 'https://evil/x' }] }), /plain file name/);
  assert.throws(bad({ schemaVersion: 2 }), /schemaVersion/);
});

test('planPacks takes whole packs for a first install and stays per-file for a small update', () => {
  const entry = (offset, size, digest) => ({ offset, size, sha256: digest.repeat(64) });
  const pack = { url: 'p1', size: 4_000_000, entries: [entry(0, 1_000_000, 'a'), entry(1_000_000, 1_000_000, 'b'), entry(2_000_000, 2_000_000, 'c')] };
  const file = (name, size, digest) => ({ path: name, size, sha256: digest.repeat(64) });
  const all = [file('A', 1_000_000, 'a'), file('B', 1_000_000, 'b'), file('C', 2_000_000, 'c'), file('C2', 2_000_000, 'c'), file('X', 10, 'x')];
  const first = planPacks(all, [pack]);
  assert.equal(first.packs.length, 1);
  assert.deepEqual(first.packs[0].spans.map((span) => [span.start, span.end]), [[0, 4_000_000]]);
  assert.deepEqual(first.packs[0].spans[0].entries[2].targets.map((target) => target.path), ['C', 'C2']);
  assert.deepEqual(first.files.map((target) => target.path), ['X']);
  assert.equal(first.bytes, 4_000_010);
  // One changed file: a range of the pack costs the same as the file itself, so it stays per-file.
  const small = planPacks([file('B', 1_000_000, 'b')], [pack]);
  assert.equal(small.packs.length, 0);
  assert.equal(small.bytes, 1_000_000);
  // Many small files far apart in a pack: separate ranges, the big gap is not downloaded.
  const tiny = { url: 'p2', size: 10_000_000, entries: [...Array.from({ length: 50 }, (_, i) => entry(i * 100, 100, `t${i}`)), entry(5_000, 9_995_000, 'z')] };
  tiny.entries.forEach((item) => { item.sha256 = sha(item.sha256); });
  const wanted = tiny.entries.slice(0, 50).map((item, i) => ({ path: `t${i}`, size: item.size, sha256: item.sha256 }));
  const ranged = planPacks(wanted, [tiny]);
  assert.equal(ranged.packs.length, 1);
  assert.deepEqual(ranged.packs[0].spans.map((span) => [span.start, span.end]), [[0, 5_000]]);
  // Content shadowed by a later layer can come from either layer's pack, but is downloaded once.
  const twin = { url: 'p3', size: 4_000_000, entries: pack.entries };
  const shared = planPacks(all, [pack, twin]);
  assert.equal(shared.packs.length, 1);
});

test('publishPacks is deterministic, immutable, verifies published files, and --release references the packs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-packs-pub-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { base } = sources();
  await writeTree(path.join(root, 'src'), base);
  const results = [];
  for (const name of ['one', 'two']) {
    const output = path.join(root, name);
    await publishLayer({ source: path.join(root, 'src'), output, layer: 'base', version: 'b1' });
    results.push(await publishPacks({ output, layer: 'base', version: 'b1', packSize: PACK_SIZE }));
  }
  assert.equal(results[0].sha256, results[1].sha256);
  const listing = (await readdir(path.join(root, 'one/layers/base/b1/packs'))).sort();
  assert.deepEqual(listing, (await readdir(path.join(root, 'two/layers/base/b1/packs'))).sort());
  for (const name of listing) {
    assert.deepEqual(await readFile(path.join(root, 'one/layers/base/b1/packs', name)), await readFile(path.join(root, 'two/layers/base/b1/packs', name)), name);
  }
  if (process.platform !== 'win32') {
    // The web server must be able to list and read packs/ (mkdtemp makes it 0700).
    assert.equal((await stat(path.join(root, 'one/layers/base/b1/packs'))).mode & 0o777, 0o755);
  }
  assert.equal(results[0].files, 61);
  assert.equal(results[0].packedFiles, 60); // the duplicate is stored once
  const index = JSON.parse(await readFile(path.join(root, 'one/layers/base/b1/packs/index.json'), 'utf8'));
  for (const pack of index.packs) {
    const bytes = await readFile(path.join(root, 'one/layers/base/b1/packs', pack.url));
    assert.equal(bytes.length, pack.size);
    assert.equal(sha(bytes), pack.sha256);
    assert.ok(pack.size <= PACK_SIZE || pack.files.length === 1);
  }
  await assert.rejects(publishPacks({ output: path.join(root, 'one'), layer: 'base', version: 'b1' }), /immutable/);
  await assert.rejects(publishPacks({ output: path.join(root, 'one'), layer: 'base', version: 'nope' }), /has not been published/);
  // A damaged published file is caught while packing, and nothing is left behind.
  const three = path.join(root, 'three');
  await publishLayer({ source: path.join(root, 'src'), output: three, layer: 'base', version: 'b1' });
  await writeFile(path.join(three, 'layers/base/b1/files/Data/Mob/0000007.img'), 'damaged');
  await assert.rejects(publishPacks({ output: three, layer: 'base', version: 'b1', packSize: PACK_SIZE }), /does not match the layer manifest/);
  assert.deepEqual((await readdir(path.join(three, 'layers/base/b1'))).sort(), ['files', 'manifest.json']);
  // --release picks the packs up; --no-packs leaves them out.
  const top = await publishLayeredRelease({ output: path.join(root, 'one'), version: 'r1', executable: 'MapleStory.exe', layers: [{ name: 'base', version: 'b1' }] });
  assert.deepEqual(top.layers[0].packs, { url: 'layers/base/b1/packs/index.json', sha256: results[0].sha256 });
  const plain = await publishLayeredRelease({ output: path.join(root, 'one'), version: 'r2', executable: 'MapleStory.exe', layers: [{ name: 'base', version: 'b1' }], packs: false });
  assert.equal(plain.layers[0].packs, undefined);
});

test('manifest packs references are validated, and launchers that predate them can ignore them', () => {
  const layer = { name: 'base', version: 'b1', manifestUrl: 'layers/base/b1/manifest.json', sha256: 'a'.repeat(64) };
  const manifest = (packs) => ({ schemaVersion: 2, version: 'r1', launch: { executable: 'SlumsMS.exe', args: [] }, layers: [{ ...layer, packs }] });
  assert.deepEqual(validateManifest(manifest({ url: 'layers/base/b1/packs/index.json', sha256: 'b'.repeat(64) })).layers[0].packs,
    { url: 'layers/base/b1/packs/index.json', sha256: 'b'.repeat(64) });
  assert.equal(validateManifest(manifest(undefined)).layers[0].packs, undefined);
  assert.throws(() => validateManifest(manifest({ url: 'https://elsewhere/index.json', sha256: 'b'.repeat(64) })), /relative/);
  assert.throws(() => validateManifest(manifest({ url: 'x.json', sha256: 'nope' })), /SHA-256/);
});

test('a first install takes packs: few requests, every file verified, duplicates and empty files placed', async (t) => {
  const f = await fixture(t);
  const updates = [];
  const result = await installRelease(f.install, await loadRelease(f.url), (value) => updates.push(value));
  await f.assertInstalled();
  assert.ok(result.packs >= 3, `packs used: ${result.packs}`);
  // Everything came from packs except what no pack offers cheaper.
  assert.ok(fileRequests(f.requests).length <= 2, fileRequests(f.requests).join(', '));
  assert.ok(packRequests(f.requests).length <= 20);
  const last = updates.at(-1);
  assert.equal(last.filesDone, last.filesTotal);
  assert.equal(last.filesTotal, Object.keys(f.expected).length);
  assert.ok(updates.some((value) => 'etaSeconds' in value && 'bytesPerSecond' in value));
  const state = await readInstallState(f.install);
  assert.equal(state.files.size, Object.keys(f.expected).length);
  // The next Play needs nothing and hashes nothing.
  assert.deepEqual(core(await inspectRelease(f.install, await loadRelease(f.url, { installDir: f.install }))), { files: [], bytes: 0, hashed: 0 });
});

test('a dropped connection resumes the pack at the exact byte with an HTTP Range request', async (t) => {
  const f = await fixture(t);
  const index = JSON.parse(await readFile(path.join(f.output, 'layers/base/b1/packs/index.json'), 'utf8'));
  const victim = `layers/base/b1/packs/${index.packs[1].url}`;
  f.behaviour.cut.set(victim, 1500);
  await installRelease(f.install, await loadRelease(f.url), () => {}, { retryDelayMs: 1 });
  await f.assertInstalled();
  const tries = f.requests.filter((entry) => entry.startsWith(victim));
  assert.equal(tries.length, 2);
  const [first, second] = tries.map((entry) => Number(/bytes=(\d+)-/u.exec(entry)[1]));
  assert.equal(second - first, 1500);
});

test('a stalled pack download is abandoned after the stall timeout and resumed', async (t) => {
  const f = await fixture(t);
  const index = JSON.parse(await readFile(path.join(f.output, 'layers/base/b1/packs/index.json'), 'utf8'));
  const victim = `layers/base/b1/packs/${index.packs.find((pack) => pack.files.length > 3).url}`;
  f.behaviour.hang.set(victim, 1000);
  await installRelease(f.install, await loadRelease(f.url), () => {}, { retryDelayMs: 1, stallMs: 300 });
  await f.assertInstalled();
  assert.equal(f.requests.filter((entry) => entry.startsWith(victim)).length, 2);
});

test('a server without range support still works (whole packs, skipping what is not needed)', async (t) => {
  const f = await fixture(t);
  f.behaviour.ranges = false;
  await installRelease(f.install, await loadRelease(f.url));
  await f.assertInstalled();
});

test('a damaged or missing pack falls back to per-file downloads for what it still owed', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.output, 'layers/base/b1/packs');
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  // Flip one byte in the last file of one pack (same size, so only the hash can tell), and remove another.
  const [damaged, missing] = index.packs.filter((pack) => pack.files.length > 3);
  const handle = await open(path.join(dir, damaged.url), 'r+');
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, damaged.size - 1);
  byte[0] ^= 0xff;
  await handle.write(byte, 0, 1, damaged.size - 1);
  await handle.close();
  await rm(path.join(dir, missing.url));
  await installRelease(f.install, await loadRelease(f.url), () => {}, { retryDelayMs: 1 });
  await f.assertInstalled();
  assert.equal(f.requests.filter((entry) => entry.startsWith(`layers/base/b1/packs/${damaged.url}`)).length, 1); // not retried
  // The damaged pack's files before the bad one were kept; the bad one and the missing pack's files came one by one.
  const singles = fileRequests(f.requests).length;
  assert.ok(singles >= missing.files.length + 1 && singles < missing.files.length + damaged.files.length, `${singles}`);
});

test('an interrupted first install resumes without downloading committed files again', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let seen = 0;
  await assert.rejects(installRelease(f.install, await loadRelease(f.url), (value) => {
    if (value.filesDone >= 20 && !seen) { seen = value.filesDone; controller.abort(new Error('player closed the launcher')); }
  }, { signal: controller.signal, packConcurrency: 1 }), /closed the launcher/);
  const kept = (await readInstallState(f.install)).files.size;
  assert.ok(kept >= 20, `kept ${kept}`);
  f.requests.length = 0;
  const pending = await inspectRelease(f.install, await loadRelease(f.url, { installDir: f.install }));
  assert.equal(pending.files.length, Object.keys(f.expected).length - kept);
  assert.equal(pending.hashed, 0);
  await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }), () => {}, { packConcurrency: 1 });
  await f.assertInstalled();
});

test('the disk space check refuses a download that cannot fit before fetching anything', async (t) => {
  const f = await fixture(t);
  const release = await loadRelease(f.url);
  f.requests.length = 0;
  await assert.rejects(installRelease(f.install, release, () => {}, { freeSpace: async () => 1000 }), (error) => error.code === 'DISK_FULL' && /Not enough disk space/.test(error.message));
  assert.deepEqual(f.requests, []);
  // Unknown free space (null) does not block.
  await installRelease(f.install, release, () => {}, { freeSpace: async () => null });
  await f.assertInstalled();
});

test('a small update stays per-file even when packs are published', async (t) => {
  const f = await fixture(t);
  await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }));
  await writeFile(path.join(f.install, 'Data/Mob/0000010.img'), 'damaged by the player');
  f.requests.length = 0;
  await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }), () => {}, { mode: 'full' });
  await f.assertInstalled();
  assert.deepEqual(packRequests(f.requests), []);
  assert.deepEqual(fileRequests(f.requests), ['layers/base/b1/files/Data/Mob/0000010.img']);
});

test('without client packs the shadowed base content still comes from base packs', async (t) => {
  const f = await fixture(t, { packClient: false });
  await installRelease(f.install, await loadRelease(f.url));
  await f.assertInstalled();
  // Only the client-only files are fetched one by one; the identical shadowed file came from a base pack.
  const singles = fileRequests(f.requests).sort();
  assert.ok(!singles.includes('layers/client/c1/files/Data/Mob/0000003.img'), singles.join(', '));
  // A pack holding a single file costs the same as that file, so it may be fetched either way.
  assert.ok(singles.filter((entry) => entry.startsWith('layers/client/')).length <= 3, singles.join(', '));
  assert.ok(singles.length <= 5);
  assert.ok((await stat(path.join(f.install, 'Data/Mob/0000003.img'))).isFile());
});

test('rateMeter reports speed and time left from recent samples only', () => {
  let now = 0;
  const meter = rateMeter({ windowMs: 10_000, now: () => now });
  meter.add(0);
  assert.deepEqual(meter.estimate(100), { bytesPerSecond: null, etaSeconds: null });
  for (let second = 1; second <= 30; second += 1) { now = second * 1000; meter.add(second * 1_000_000); }
  assert.deepEqual(meter.estimate(60_000_000), { bytesPerSecond: 1_000_000, etaSeconds: 30 });
  // A stall drags the rate down within the window.
  now = 40_000; meter.add(30_000_000);
  assert.ok(meter.estimate(60_000_000).bytesPerSecond < 1_000_000);
});

test('time left reads naturally', () => {
  assert.equal(formatTimeLeft(20), 'less than a minute left');
  assert.equal(formatTimeLeft(14 * 60), 'about 14 min left');
  assert.equal(formatTimeLeft(65 * 60), 'about 1 h 5 min left');
  assert.equal(formatTimeLeft(null), '');
});

test('downloadMessage is one steady line from aggregate counters', () => {
  const GB = 1024 ** 3;
  assert.equal(downloadMessage({ unit: 'packs', done: 11, total: 91, bytesDone: 3.4 * GB, bytesTotal: 21.7 * GB, bytesPerSecond: 45 * 1024 ** 2, etaSeconds: 370 }),
    'Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, about 6 min left');
  assert.equal(downloadMessage({ unit: 'packs', done: 91, total: 91, bytesDone: 2 * GB, bytesTotal: GB }), 'Downloading 91 of 91 packs, 1.0 of 1.0 GB');
  assert.equal(downloadMessage({ unit: 'files', done: 0, total: 1, bytesDone: 0, bytesTotal: 0 }), 'Downloading 1 of 1 file');
  assert.equal(resumeMessage(8.2 * GB), 'Checked 8.2 GB already downloaded, continuing.');
});

test('parallel pack downloads report one steady, never-backwards progress line', async (t) => {
  const f = await fixture(t);
  const events = [];
  await installRelease(f.install, await loadRelease(f.url), (value) => events.push(value), { packConcurrency: 4 });
  await f.assertInstalled();
  const packLines = events.map((event) => /^Downloading (\d+) of (\d+) packs/u.exec(event.message)).filter(Boolean);
  assert.ok(packLines.length > 5, `${packLines.length} pack lines`);
  assert.equal(new Set(packLines.map((match) => match[2])).size, 1, 'the pack total never changes');
  for (let i = 1; i < packLines.length; i += 1) assert.ok(Number(packLines[i][1]) >= Number(packLines[i - 1][1]), 'the pack number never goes back');
  // No per-pack or per-file chatter while packs download.
  assert.ok(!events.some((event) => /^(Downloading pack |Verified |Downloading Data)/u.test(event.message)), events.map((event) => event.message).join('\n'));
  const downloads = events.filter((event) => /^Downloading \d/u.test(event.message));
  for (let i = 1; i < downloads.length; i += 1) {
    assert.ok(downloads[i].bytesDone >= downloads[i - 1].bytesDone, 'bytes never go back');
    assert.ok(downloads[i].bytesDone <= downloads[i].bytesTotal);
  }
  assert.ok(downloads.every((event) => event.resumed === false));
});

test('a resumed first install says what it kept and counts on from there', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(installRelease(f.install, await loadRelease(f.url), (value) => {
    if (value.filesDone >= 20) controller.abort(new Error('player closed the launcher'));
  }, { signal: controller.signal, packConcurrency: 1 }), /closed the launcher/);
  const release = await loadRelease(f.url, { installDir: f.install });
  const pending = await inspectRelease(f.install, release);
  assert.ok(pending.keptBytes > 0);
  const total = release.files.reduce((sum, file) => sum + file.size, 0);
  assert.equal(pending.keptBytes + pending.bytes, total);
  const events = [];
  const result = await installRelease(f.install, release, (value) => events.push(value), { packConcurrency: 1 });
  await f.assertInstalled();
  assert.equal(result.resumed, true);
  assert.equal(result.keptBytes, pending.keptBytes);
  const first = events.findIndex((event) => event.message.startsWith('Checked '));
  assert.ok(first >= 0, events.map((event) => event.message).join('\n'));
  assert.equal(events[first].message, resumeMessage(pending.keptBytes));
  // The bar continues from what was kept instead of starting at zero.
  const downloads = events.slice(first);
  assert.ok(downloads.every((event) => event.bytesDone >= pending.keptBytes && event.resumed === true));
  // A finished install is not a resume: a later update counts only its own bytes.
  const again = await installRelease(f.install, await loadRelease(f.url, { installDir: f.install }));
  assert.equal(again.resumed, false);
});

test('Play reuses a fresh verification only for the same folder, server and manifest', () => {
  const release = { manifestSha256: 'a'.repeat(64) };
  const recent = { release, installDir: 'C:/Games/SlumsMS', feedUrl: 'https://patch/manifest.json', at: 1_000 };
  const base = { recent, installDir: recent.installDir, feedUrl: recent.feedUrl, now: 2_000, maxAgeMs: 60_000, executablePresent: true,
    offered: { status: 'ok', manifestSha256: release.manifestSha256 } };
  assert.equal(reuseVerified(base), true);
  assert.equal(reuseVerified({ ...base, recent: null }), false);
  assert.equal(reuseVerified({ ...base, installDir: 'D:/Other' }), false);
  assert.equal(reuseVerified({ ...base, feedUrl: 'https://other/manifest.json' }), false);
  assert.equal(reuseVerified({ ...base, now: 1_000 + 60_001 }), false);
  assert.equal(reuseVerified({ ...base, executablePresent: false }), false);
  assert.equal(reuseVerified({ ...base, offered: { status: 'ok', manifestSha256: 'b'.repeat(64) } }), false); // a new release is out
  assert.equal(reuseVerified({ ...base, offered: { status: 'offline' } }), false);
});
