import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readFeedBytes, releaseURL, launcherVersion } from './updater.mjs';

/**
 * Hand-over to the Tauri launcher (1.5.0). This is the last Electron release: it reaches players
 * through the Electron self-update channel (launcher.json), then on its next start fetches the
 * Tauri build from the same patch server (`tauri/launcher.json`, the Tauri updater format),
 * verifies its minisign signature against the key below and swaps the single Tauri exe in under
 * the same name, so shortcuts keep working. If the new launcher does not report healthy, the
 * Electron exe is put back and this launcher carries on.
 */
export const TAURI_CHANNEL_FILE = 'tauri/launcher.json';
export const TAURI_PLATFORM = 'windows-x86_64';
/** The Tauri launcher's updater public key (minisign, base64 of the .pub text). Public by design. */
export const TAURI_PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDYyRDhGMUY1NjdCN0ZFNzkKUldSNS9yZG45ZkhZWXJGUWlhTDZTZ0xnaGF1aTRtdXV5N0FwNHIrckp5cHEralBYOSsrYXF4WWwK';
export const UPDATE_DIRECTORY = '.slumsms-launcher-update';
const MAX_CHANNEL_BYTES = 1024 * 1024;
export const MAX_TAURI_EXE_BYTES = 64 * 1024 * 1024;

const isBase64 = (value) => typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value.trim());

/** Validate the Tauri updater JSON; the build must sit on the feed's own origin (the key goes nowhere else). */
export function validateTauriChannel(value, feedUrl) {
  if (!value || typeof value !== 'object') throw new Error('Tauri launcher channel must be a JSON object.');
  const version = launcherVersion(value.version, 'Tauri launcher version');
  const entry = value.platforms?.[TAURI_PLATFORM];
  if (!entry || typeof entry !== 'object') throw new Error(`Tauri launcher channel has no ${TAURI_PLATFORM} build.`);
  if (typeof entry.url !== 'string') throw new Error('Tauri launcher url must be an absolute URL.');
  let url;
  try { url = new URL(entry.url); } catch { throw new Error('Tauri launcher url must be an absolute URL.'); }
  releaseURL(url.href);
  if (url.origin !== releaseURL(feedUrl).origin) throw new Error('The Tauri launcher must be served from the patch server itself.');
  if (!isBase64(entry.signature)) throw new Error('Tauri launcher signature is missing.');
  return Object.freeze({ version, url: url.href, signature: entry.signature.trim() });
}

/** Fetch `tauri/launcher.json` beside the feed; null when none is published (404). */
export async function loadTauriChannel(feedUrl, { accessKey = '', signal } = {}) {
  const channelUrl = new URL(TAURI_CHANNEL_FILE, releaseURL(feedUrl)).href;
  let bytes;
  try { ({ bytes } = await readFeedBytes(channelUrl, 'Tauri launcher channel', { feedUrl, accessKey, signal, maxBytes: MAX_CHANNEL_BYTES })); } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`Cannot read the Tauri launcher channel: ${error.message}`); }
  return validateTauriChannel(value, feedUrl);
}

/** Download the Tauri build (key only to the feed origin), with progress. */
export async function downloadTauriBuild(feedUrl, channel, { accessKey = '', signal, onBytes } = {}) {
  const { bytes } = await readFeedBytes(channel.url, 'Tauri launcher', { feedUrl, accessKey, signal, maxBytes: MAX_TAURI_EXE_BYTES, onBytes });
  return bytes;
}

function decodeLines(base64, label) {
  const lines = Buffer.from(base64, 'base64').toString('utf8').split(/\r?\n/u).filter((line) => line.length);
  if (!lines.length) throw new Error(`Invalid ${label}.`);
  return lines;
}

function ed25519Key(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/**
 * Minisign verification (what the Tauri updater does): key ids match, the file signature holds
 * (prehashed "ED" = BLAKE2b-512 of the file, or raw "Ed"), the global signature covers the trusted
 * comment, and the trusted comment binds the build to `expectedVersion` ("version:X" field).
 * Throws on any failure.
 */
export function verifyTauriSignature(bytes, signatureBase64, publicKeyBase64, expectedVersion) {
  const keyLines = decodeLines(publicKeyBase64, 'public key');
  const keyRaw = Buffer.from(keyLines.at(-1).trim(), 'base64');
  if (keyRaw.length !== 42 || keyRaw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('Invalid launcher public key.');
  const sigLines = decodeLines(signatureBase64, 'signature');
  const at = sigLines.findIndex((line) => line.startsWith('trusted comment: '));
  if (at < 1 || at + 1 >= sigLines.length) throw new Error('Invalid launcher signature format.');
  const sigRaw = Buffer.from(sigLines[at - 1].trim(), 'base64');
  const algorithm = sigRaw.subarray(0, 2).toString('latin1');
  if (sigRaw.length !== 74 || (algorithm !== 'ED' && algorithm !== 'Ed')) throw new Error('Invalid launcher signature.');
  if (!sigRaw.subarray(2, 10).equals(keyRaw.subarray(2, 10))) throw new Error('The launcher was signed with a different key.');
  const key = ed25519Key(keyRaw.subarray(10));
  const signature = sigRaw.subarray(10);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : Buffer.from(bytes);
  if (!verify(null, message, key, signature)) throw new Error('The launcher signature does not match the download.');
  const trusted = sigLines[at].slice('trusted comment: '.length);
  const globalSig = Buffer.from(sigLines[at + 1].trim(), 'base64');
  if (globalSig.length !== 64 || !verify(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), key, globalSig)) {
    throw new Error('The launcher signature comment was tampered with.');
  }
  const signed = trusted.split('\t').find((field) => field.startsWith('version:'))?.slice('version:'.length);
  if (signed !== expectedVersion) throw new Error(`The launcher build is signed for version ${signed ?? 'unknown'}, not ${expectedVersion}.`);
  return true;
}

export const handoverMarker = (launcherDir, version) => path.join(launcherDir, UPDATE_DIRECTORY, `healthy-${version}`);

const exists = async (file) => { try { await fs.lstat(file); return true; } catch { return false; } };

async function renameWithRetry(from, to, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await fs.rename(from, to); return; } catch (error) {
      if (error.code === 'ENOENT' || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * Swap the verified Tauri exe in under the launcher's own name and start it. Returns 'handed-over'
 * once it reports healthy (the caller exits); otherwise restores the Electron exe and returns the
 * reason (Electron carries on). Only the exe is touched; resources/ and the DLLs stay.
 */
export async function handoverToTauri({ launcherDir, exeName = 'SlumsMS Launcher.exe', bytes, version, fromVersion, relaunchArgs = [], log = () => {}, healthTimeoutMs = 90_000 }) {
  const updateDir = path.join(launcherDir, UPDATE_DIRECTORY);
  const staged = path.join(updateDir, `handover-${version}`, exeName);
  const rollback = path.join(updateDir, 'electron-rollback', exeName);
  const exe = path.join(launcherDir, exeName);
  const marker = handoverMarker(launcherDir, version);
  await fs.mkdir(path.dirname(staged), { recursive: true });
  await fs.writeFile(staged, bytes, { mode: 0o755 });
  await fs.mkdir(path.dirname(rollback), { recursive: true });
  await fs.rm(rollback, { force: true });
  await fs.rm(marker, { force: true });
  // Windows lets a running exe be renamed (not overwritten).
  await fs.rename(exe, rollback);
  try { await fs.rename(staged, exe); } catch (error) {
    await fs.rename(rollback, exe);
    return `Could not put the new launcher in place: ${error.message}`;
  }
  log(`Hand-over: starting launcher ${version} in place of ${fromVersion}.`);
  let child;
  let exited = null;
  let reason;
  try {
    child = spawn(exe, [`--handover-from=electron-${fromVersion}`, ...relaunchArgs], { cwd: launcherDir, detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('exit', (code) => { exited = code ?? 'signal'; });
    const failed = await new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', resolve); });
    if (failed) reason = `the new launcher did not start: ${failed.message}`;
  } catch (error) { reason = `the new launcher did not start: ${error.message}`; }
  if (!reason) {
    const deadline = Date.now() + healthTimeoutMs;
    for (;;) {
      if (await exists(marker)) { child.unref(); return 'handed-over'; }
      if (exited !== null) { reason = `the new launcher exited before it was ready (${exited})`; break; }
      if (Date.now() > deadline) { reason = 'the new launcher did not report ready in time'; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await exists(marker)) { child.unref(); return 'handed-over'; }
    try { child.kill(); } catch { /* already gone */ }
  }
  const failedCopy = path.join(updateDir, `failed-handover-${version}-${exeName}`);
  try {
    await fs.rm(failedCopy, { force: true });
    await renameWithRetry(exe, failedCopy).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await fs.rename(rollback, exe);
  } catch (error) {
    reason += `; restoring the Electron launcher also failed: ${error.message}`;
  }
  log(`Hand-over to ${version} rolled back: ${reason}`);
  return reason;
}
