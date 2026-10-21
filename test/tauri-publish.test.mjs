import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishTauriLauncher, tauriSignatureFields, TAURI_CHANNEL_FILE } from '../tools/publish.mjs';

// Signs with a throwaway key made for this test only (never the real launcher key).
function tauriCli() {
  try { execFileSync('cargo', ['tauri', '--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tauri-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function signedExe(root, version) {
  const exe = path.join(root, `launcher-${version}.exe`);
  const bytes = Buffer.alloc(4096, 7);
  bytes.write('MZ', 0, 'latin1');
  bytes.write(version, 100, 'latin1');
  await writeFile(exe, bytes);
  const key = path.join(root, 'test.key');
  try { await readFile(key); } catch { execFileSync('cargo', ['tauri', 'signer', 'generate', '--ci', '-p', '', '-w', key], { stdio: 'ignore' }); }
  execFileSync('cargo', ['tauri', 'signer', 'sign', '-f', key, '-p', '', '--app-version', version, exe], { stdio: 'ignore' });
  return { exe, signature: `${exe}.sig` };
}

test('a signed Tauri launcher is published immutably with the updater JSON written last', { skip: !tauriCli() && 'cargo tauri is not installed' }, async (t) => {
  const root = await scratch(t);
  const out = path.join(root, 'channel');
  const { exe, signature } = await signedExe(root, '1.5.1');
  assert.equal(tauriSignatureFields(await readFile(signature, 'utf8')).version, '1.5.1');
  const result = await publishTauriLauncher({ exe, signature, output: out, version: '1.5.1', baseUrl: 'https://slumspatch.asslorde.com/launcher-test/', now: new Date('2026-10-21T00:00:00Z') });
  const channel = JSON.parse(await readFile(path.join(out, ...TAURI_CHANNEL_FILE.split('/')), 'utf8'));
  assert.deepEqual(channel, {
    version: '1.5.1', notes: '', pub_date: '2026-10-21T00:00:00.000Z',
    platforms: { 'windows-x86_64': { signature: (await readFile(signature, 'utf8')).trim(), url: 'https://slumspatch.asslorde.com/launcher-test/tauri/1.5.1/SlumsMS-Launcher.exe' } },
  });
  assert.deepEqual(await readFile(path.join(out, 'tauri', '1.5.1', 'SlumsMS-Launcher.exe')), await readFile(exe));
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual((await readdir(path.join(out, 'tauri'))).sort(), ['1.5.1', 'launcher.json']);
  // Never the same or an older version again; never a signature bound to another version.
  await assert.rejects(publishTauriLauncher({ exe, signature, output: out, version: '1.5.1', baseUrl: 'https://slumspatch.asslorde.com/launcher-test/' }), /not newer/u);
  const next = await signedExe(root, '1.5.2');
  await assert.rejects(publishTauriLauncher({ ...next, output: out, version: '1.5.3', baseUrl: 'https://slumspatch.asslorde.com/launcher-test/' }), /signature is for version 1\.5\.2/u);
  await publishTauriLauncher({ ...next, output: out, version: '1.5.2', baseUrl: 'https://slumspatch.asslorde.com/launcher-test/' });
  assert.equal(JSON.parse(await readFile(path.join(out, 'tauri', 'launcher.json'), 'utf8')).version, '1.5.2');
});

test('the base URL must be HTTPS without credentials, and the file must be a Windows program', { skip: !tauriCli() && 'cargo tauri is not installed' }, async (t) => {
  const root = await scratch(t);
  const { exe, signature } = await signedExe(root, '1.5.1');
  const base = { exe, signature, output: path.join(root, 'out'), version: '1.5.1' };
  await assert.rejects(publishTauriLauncher({ ...base, baseUrl: 'http://slumspatch.asslorde.com/' }), /HTTPS/u);
  await assert.rejects(publishTauriLauncher({ ...base, baseUrl: 'https://slums:key@slumspatch.asslorde.com/' }), /credentials/u);
  await assert.rejects(publishTauriLauncher({ ...base, version: '1.5' , baseUrl: 'https://x/' }), /MAJOR\.MINOR\.PATCH/u);
  await writeFile(exe, Buffer.alloc(4096, 1));
  await assert.rejects(publishTauriLauncher({ ...base, baseUrl: 'https://x/' }), /not a Windows executable/u);
});
