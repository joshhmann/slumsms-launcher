// Launcher swap helper. It runs as plain Node (the staged launcher with ELECTRON_RUN_AS_NODE, or node
// in tests) from LAUNCHER_DIR/.slumsms-launcher-update, after the old launcher has exited, because a
// running Windows executable cannot be overwritten. It imports nothing from the app it replaces.
//
//   1. wait for the old launcher's process to exit (give up, changing nothing, if it never does);
//   2. move each replaced file into rollback/ and copy the staged file in, executable last;
//   3. start the new launcher and wait for it to report a healthy first start;
//   4. if any step fails, or the new launcher exits without reporting, restore rollback/ and start
//      the old launcher with --self-update-failed=VERSION so it skips that version for one session.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

// Under ELECTRON_RUN_AS_NODE, fs would open resources/app.asar as an archive; move it as a file.
process.noAsar = true;
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const local = (root, relative) => path.join(root, ...relative.split('/'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  const line = `${new Date().toISOString()} [swap ${job.fromVersion} -> ${job.toVersion}] ${message}\n`;
  try { if (job.logFile) appendFileSync(job.logFile, line); else process.stderr.write(line); } catch { /* logging never blocks the swap */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Antivirus scanners and the exiting process briefly hold files on Windows; retry those errors.
async function retry(action) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); } catch (error) {
      if (attempt >= 40 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      await sleep(250);
    }
  }
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch { return false; }
}

function start(version, args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(local(job.launcherDir, job.executable), [...job.relaunchArgs, ...args], { cwd: job.launcherDir, detached: true, stdio: 'ignore', env });
  child.once('error', (error) => log(`Could not start launcher ${version}: ${error.message}`));
  return child;
}

const done = [];
const journal = (state) => writeFileSync(path.join(job.rollbackDir, 'rollback.json'),
  JSON.stringify({ state, fromVersion: job.fromVersion, toVersion: job.toVersion, files: job.files, at: new Date().toISOString() }, null, 2));

async function swap() {
  await retry(() => fs.rm(job.rollbackDir, { recursive: true, force: true }));
  await fs.mkdir(job.rollbackDir, { recursive: true });
  journal('swapping');
  for (const relative of job.files) {
    const target = local(job.launcherDir, relative);
    const backup = local(job.rollbackDir, relative);
    const entry = { relative, target, backup, backedUp: false };
    done.push(entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await exists(target)) {
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await retry(() => fs.rename(target, backup));
      entry.backedUp = true;
    }
    await retry(() => fs.copyFile(local(job.stage, relative), target));
    if (process.platform !== 'win32' && relative === job.executable) await fs.chmod(target, 0o755);
  }
  journal('swapped');
}

async function rollback() {
  for (const entry of [...done].reverse()) {
    await retry(() => fs.rm(entry.target, { force: true }));
    if (entry.backedUp) await retry(() => fs.rename(entry.backup, entry.target));
  }
  done.length = 0;
  journal('rolled-back');
}

async function main() {
  writeFileSync(job.startedFile, String(process.pid));
  log(`Helper started; waiting for launcher process ${job.pid} to exit.`);
  if (!await waitUntil(() => !alive(job.pid), job.exitTimeoutMs)) {
    log('The old launcher did not exit; nothing was changed.');
    return;
  }
  try {
    await swap();
  } catch (error) {
    log(`Swap failed (${error.message}); restoring ${job.fromVersion}.`);
    try { await rollback(); } catch (restore) { log(`RESTORE FAILED (${restore.message}); the replaced files are in ${job.rollbackDir}.`); return; }
    start(job.fromVersion, [`--self-update-failed=${job.toVersion}`]);
    return;
  }
  log(`Installed ${job.files.length} changed files; starting ${job.toVersion}.`);
  await fs.rm(job.healthyFile, { force: true }).catch(() => {});
  const child = start(job.toVersion, [`--self-updated=${job.toVersion}`]);
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  const healthy = await waitUntil(async () => exited || await exists(job.healthyFile), job.healthTimeoutMs);
  if (await exists(job.healthyFile)) {
    await fs.rm(job.healthyFile, { force: true }).catch(() => {});
    log(`Launcher ${job.toVersion} started; the previous files stay in ${job.rollbackDir}.`);
  } else if (exited) {
    log(`Launcher ${job.toVersion} exited before its first window; restoring ${job.fromVersion}.`);
    try { await rollback(); } catch (restore) { log(`RESTORE FAILED (${restore.message}); the replaced files are in ${job.rollbackDir}.`); return; }
    start(job.fromVersion, [`--self-update-failed=${job.toVersion}`]);
  } else if (!healthy) {
    log(`Launcher ${job.toVersion} is still starting after ${job.healthTimeoutMs} ms; leaving it running.`);
  }
  child.unref();
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(200);
  }
  return false;
}

main().catch((error) => log(`Helper failed: ${error.stack ?? error.message}`)).finally(() => process.exit(0));
