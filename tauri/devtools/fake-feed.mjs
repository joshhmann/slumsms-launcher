#!/usr/bin/env node
/**
 * A local fake patch server for developing and testing the launcher (never a real feed).
 *
 *   node tauri/devtools/fake-feed.mjs build OUT_DIR [--files N] [--version 1.0.0] [--exe-from PROGRAM.exe]
 *       Builds Live, Test and RC channels with the real publisher (tools/publish.mjs): a "base" layer
 *       of N synthetic Data files with first-install packs, and a small "client" layer with
 *       SlumsMS.exe, slums.dll and config.ini. Test/RC get their own client layer and manifest.
 *   node tauri/devtools/fake-feed.mjs serve OUT_DIR [--port 8787]
 *       Serves it like nginx on the patch host: HTTP Basic auth, user "slums" with key "player-local"
 *       opens Live only; user "slumsdev" with key "dev-local" opens Live, /launcher-test/ and
 *       /launcher-rc/. Range requests are supported. These keys exist only on this dev server.
 *
 * The launcher only allows HTTP on loopback, so point it at http://127.0.0.1:PORT/manifest.json.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { publishLayer, publishPacks, publishLayeredRelease } = await import(pathToFileURL(path.join(here, '..', '..', 'tools', 'publish.mjs')).href);
export const PLAYER = { user: 'slums', key: 'player-local' };
export const DEV = { user: 'slumsdev', key: 'dev-local' };

const option = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

async function writeTree(root, files) {
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
  }
}

function syntheticBase(count) {
  const files = {};
  for (let i = 0; i < count; i += 1) {
    const size = 2000 + ((i * 7919) % 60000);
    const bytes = Buffer.alloc(size);
    for (let b = 0; b < size; b += 1) bytes[b] = (b * 31 + i * 17) % 251;
    files[`Data/${['Mob', 'Map', 'Npc', 'Skill'][i % 4]}/${String(i).padStart(7, '0')}.img`] = bytes;
  }
  files['Data/Etc/empty.img'] = Buffer.alloc(0);
  files['Data/Etc/dup-a.img'] = Buffer.from('identical content');
  files['Data/Etc/dup-b.img'] = Buffer.from('identical content');
  return files;
}

// --exe-from PATH ships a real program as SlumsMS.exe so Play can be exercised (e.g. rundll32.exe,
// which exits at once without a window when started without arguments).
let exeFrom = null;
const clientFiles = (label) => ({
  'SlumsMS.exe': exeFrom ?? Buffer.from(`fake SlumsMS starter (${label})`),
  'slums.dll': Buffer.from(`fake slums.dll (${label})`),
  'config.ini': Buffer.from('[config]\r\nhost=127.0.0.1\r\nport=8484\r\n\r\n[clienthax]\r\nmoveattack=true ; legacy switch\r\nnobulb=true\r\n\r\n[discord]\r\nenableactivitystatus=true\r\n'),
});

async function build(out, { count, version }) {
  await fs.mkdir(out, { recursive: true });
  const stage = await fs.mkdtemp(path.join(out, '.stage-'));
  try {
    await writeTree(path.join(stage, 'base'), syntheticBase(count));
    const channels = [['', version, 'live'], ['launcher-test/', `${version}-test`, 'test'], ['launcher-rc/', `${version}-rc1`, 'rc']];
    for (const [prefix, release, label] of channels) {
      const output = path.join(out, prefix);
      await fs.mkdir(output, { recursive: true });
      await publishLayer({ source: path.join(stage, 'base'), output, layer: 'base', version: 'v83-local' });
      await publishPacks({ output, layer: 'base', version: 'v83-local', packSize: 1024 * 1024 });
      await writeTree(path.join(stage, `client-${label}`), clientFiles(label));
      await publishLayer({ source: path.join(stage, `client-${label}`), output, layer: 'client', version: release });
      await publishLayeredRelease({ output, version: release, layers: [['base', 'v83-local'], ['client', release]].map(([name, v]) => ({ name, version: v })),
        news: [{ title: `Local ${label} feed`, date: '2026-10-21', body: 'A fake feed served from this computer for launcher testing.' }] });
      console.log(`built ${label}: ${path.join(output, 'manifest.json')} (${release})`);
    }
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

function serve(root, port) {
  const allowed = (header, dev) => [DEV, ...(dev ? [] : [PLAYER])].some(({ user, key }) => header === `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, '');
    const devOnly = /^launcher-(test|rc)\//u.test(relative);
    const log = (status) => console.log(`${status} ${request.headers.range ? `[${request.headers.range}] ` : ''}${url.pathname}`);
    if (!allowed(request.headers.authorization, devOnly)) {
      log(401);
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SlumsMS patch (local)"' });
      response.end();
      return;
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) { log(400); response.writeHead(400).end(); return; }
    let stat;
    try { stat = await fs.stat(file); } catch { stat = null; }
    if (!stat?.isFile()) { log(404); response.writeHead(404).end(); return; }
    const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      log(206);
      response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    log(200);
    response.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': /(manifest|launcher)\.json$/u.test(relative) ? 'no-cache' : 'max-age=31536000' });
    createReadStream(file).pipe(response);
  });
  server.listen(port, '127.0.0.1', () => console.log(`fake feed on http://127.0.0.1:${port}/manifest.json (player key "${PLAYER.key}", dev key "${DEV.key}")`));
}

const [command, dir, ...rest] = process.argv.slice(2);
if (option(rest, '--exe-from')) exeFrom = await fs.readFile(option(rest, '--exe-from'));
if (command === 'build' && dir) await build(path.resolve(dir), { count: Number(option(rest, '--files', '300')), version: option(rest, '--version', '1.0.0') });
else if (command === 'serve' && dir) serve(path.resolve(dir), Number(option(rest, '--port', '8787')));
else { console.error('usage: fake-feed.mjs build OUT_DIR [--files N] [--version V] | serve OUT_DIR [--port P]'); process.exit(2); }
