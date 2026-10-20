import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRelease, launcherVersion } from './updater.mjs';

/**
 * Launcher self-update. The launcher is its own channel (launcher.json beside the game manifest),
 * staged with the game installer's verified, resumable download code into a side folder next to
 * the launcher, then swapped in by a small helper after this process exits.
 */
export const UPDATE_DIRECTORY = '.slumsms-launcher-update';
const ROLLBACK_DIRECTORY = 'rollback';
const STAGE_PREFIX = 'stage-';
const HELPER_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'self-update-helper.mjs');

/**
 * Electron's fs reads any *.asar path as an archive; the launcher's own resources/app.asar must be
 * hashed, copied and moved as a plain file. process.noAsar is global, so it is only set around
 * self-update file work, which never overlaps other launcher operations.
 */
async function plainFiles(action) {
  const previous = process.noAsar;
  process.noAsar = true;
  try { return await action(); } finally { process.noAsar = previous; }
}

/** Compare MAJOR.MINOR.PATCH versions: negative, zero or positive. */
export function compareVersions(left, right) {
  const a = launcherVersion(left).split('.').map(Number);
  const b = launcherVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** 'update' when the channel offers a strictly newer build for this platform; otherwise the reason it does not. */
export function launcherUpdateDecision({ channel, currentVersion, platform, skipVersion = '' }) {
  if (!channel) return 'no launcher channel published';
  if (channel.platform !== platform) return `channel is for ${channel.platform}, this launcher is ${platform}`;
  let order;
  try { order = compareVersions(channel.version, currentVersion); } catch { return `current version ${currentVersion} is not MAJOR.MINOR.PATCH`; }
  if (order < 0) return `channel ${channel.version} is older than ${currentVersion}; never downgrading`;
  if (order === 0) return `already on ${currentVersion}`;
  if (channel.version === skipVersion) return `${channel.version} failed to apply this session`;
  return 'update';
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(filename) {
  try { const stat = await fs.lstat(filename); return stat.isFile() ? stat : null; } catch { return null; }
}

const local = (root, relative) => path.join(root, ...relative.split('/'));

/** Prove the launcher folder is writable (a Program Files install is not) before downloading anything. */
async function probeWritable(directory) {
  const probe = path.join(directory, `.slumsms-write-probe-${randomUUID()}`);
  try {
    await fs.writeFile(probe, '', { flag: 'wx' });
    await fs.rename(probe, `${probe}.renamed`);
    await fs.rm(`${probe}.renamed`, { force: true });
  } catch (error) {
    await fs.rm(probe, { force: true }).catch(() => {});
    throw new Error(`The launcher folder is not writable (${error.code ?? error.message}): ${directory}`);
  }
}

/**
 * Stage `channel` into LAUNCHER_DIR/.slumsms-launcher-update/stage-VERSION. Files identical to the
 * running launcher (same SHA-256) are copied locally; only changed files are downloaded, verified and
 * resumable across restarts exactly like game files. Returns the stage and the files that differ.
 */
export function prepareLauncherUpdate(options) {
  return plainFiles(() => prepare(options));
}

async function prepare({ launcherDir, channel, onProgress = () => {}, concurrency, signal, retryDelayMs }) {
  const root = path.join(launcherDir, UPDATE_DIRECTORY);
  await probeWritable(launcherDir);
  await fs.mkdir(root, { recursive: true });
  const stage = path.join(root, `${STAGE_PREFIX}${channel.version}`);
  // Stages for other versions are stale; this version's stage is resumed.
  for (const entry of await fs.readdir(root)) {
    if (entry.startsWith(STAGE_PREFIX) && entry !== path.basename(stage)) await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
  const changed = [];
  const { files } = channel.release;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (signal?.aborted) throw signal.reason;
    onProgress({ message: `Comparing ${file.path}`, filesDone: index, filesTotal: files.length, bytesDone: 0, bytesTotal: 0 });
    const current = local(launcherDir, file.path);
    const stat = await regularFile(current);
    if (!stat || stat.size !== file.size || await sha256File(current) !== file.sha256) { changed.push(file.path); continue; }
    const staged = local(stage, file.path);
    if (await regularFile(staged)) continue;
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.copyFile(current, staged);
  }
  if (!changed.length) return { stage, changed };
  // installRelease hashes the local copies and downloads only what is missing or different.
  await installRelease(stage, channel.release, onProgress, { mode: 'fast', concurrency, signal, retryDelayMs });
  return { stage, changed };
}

async function waitFor(check, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Start the swap helper and wait until it confirms it is running; only then may the caller exit.
 * The helper waits for `pid` to exit, moves the replaced files into rollback/, copies the staged ones
 * in (the executable last), starts the new launcher and restores everything if any step or the new
 * launcher's first start fails. By default it runs on the staged launcher's own runtime
 * (ELECTRON_RUN_AS_NODE), so it needs nothing that the swap replaces.
 */
export async function startLauncherSwap({ launcherDir, stage, channel, changed, currentVersion, pid = process.pid, relaunchArgs = [], logFile = '',
  runtime = local(stage, channel.executable), env = process.env, startTimeoutMs = 15_000, healthTimeoutMs = 600_000, exitTimeoutMs = 120_000 }) {
  const helperSource = await fs.readFile(HELPER_SOURCE);
  return plainFiles(() => swap({ launcherDir, stage, channel, changed, currentVersion, pid, relaunchArgs, logFile, runtime, env, startTimeoutMs, healthTimeoutMs, exitTimeoutMs, helperSource }));
}

async function swap({ launcherDir, stage, channel, changed, currentVersion, pid, relaunchArgs, logFile, runtime, env, startTimeoutMs, healthTimeoutMs, exitTimeoutMs, helperSource }) {
  const root = path.join(launcherDir, UPDATE_DIRECTORY);
  const helper = path.join(root, 'swap-helper.mjs');
  const jobFile = path.join(root, 'swap-job.json');
  const startedFile = path.join(root, `started-${randomUUID()}`);
  await fs.writeFile(helper, helperSource);
  // The executable is replaced last, so an interrupted swap still leaves the old one in place.
  const ordered = [...changed.filter((file) => file !== channel.executable), ...changed.filter((file) => file === channel.executable)];
  const job = {
    pid, launcherDir, stage, files: ordered, executable: channel.executable, fromVersion: currentVersion, toVersion: channel.version,
    relaunchArgs, logFile, startedFile, rollbackDir: path.join(root, ROLLBACK_DIRECTORY), healthyFile: healthyMarker(launcherDir, channel.version),
    healthTimeoutMs, exitTimeoutMs,
  };
  await fs.writeFile(jobFile, JSON.stringify(job, null, 2));
  // Staged files are written owner-read/write only; POSIX needs the staged runtime executable.
  if (process.platform !== 'win32' && runtime === local(stage, channel.executable)) await fs.chmod(runtime, 0o755);
  const child = spawn(runtime, [helper, jobFile], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const spawned = await new Promise((resolve) => { child.once('spawn', () => resolve(null)); child.once('error', resolve); });
  if (spawned) throw new Error(`Could not start the launcher update helper: ${spawned.message}`);
  const started = await waitFor(async () => exited || Boolean(await regularFile(startedFile)), startTimeoutMs);
  if (!started || exited || !(await regularFile(startedFile))) {
    if (!exited) child.kill();
    throw new Error('The launcher update helper did not start.');
  }
  child.unref();
  await fs.rm(startedFile, { force: true }).catch(() => {});
}

/** The new launcher writes this after its first successful start so the helper keeps the update. */
export function healthyMarker(launcherDir, version) {
  return path.join(launcherDir, UPDATE_DIRECTORY, `healthy-${version}`);
}

/**
 * Remove finished stages (this version and older) and helper files left from earlier updates; keep
 * a newer, partially downloaded stage to resume and the rollback copy of the previous launcher.
 * Errors are ignored: a stage the helper is still running from is removed on a later start.
 */
export function cleanupLauncherUpdates(launcherDir, currentVersion) {
  return plainFiles(() => cleanup(launcherDir, currentVersion));
}

async function cleanup(launcherDir, currentVersion) {
  const root = path.join(launcherDir, UPDATE_DIRECTORY);
  let entries;
  try { entries = await fs.readdir(root); } catch { return []; }
  const notes = [];
  for (const entry of entries) {
    let remove = entry === 'swap-helper.mjs' || entry === 'swap-job.json' || entry.startsWith('started-');
    if (entry.startsWith(STAGE_PREFIX)) {
      const version = entry.slice(STAGE_PREFIX.length);
      try { remove = compareVersions(version, currentVersion) <= 0; } catch { remove = true; }
    }
    if (remove) await fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
  try {
    const journal = JSON.parse(await fs.readFile(path.join(root, ROLLBACK_DIRECTORY, 'rollback.json'), 'utf8'));
    if (journal.state === 'swapping') notes.push(`A launcher swap from ${journal.fromVersion} to ${journal.toVersion} was interrupted; the replaced files are kept in ${path.join(root, ROLLBACK_DIRECTORY)}.`);
  } catch { /* no rollback copy yet */ }
  return notes;
}
