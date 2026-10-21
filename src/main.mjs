import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile, appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadRelease, inspectRelease, installRelease, loadLauncherChannel, readInstalledRecord, checkAvailableRelease } from './updater.mjs';
import { launcherUpdateDecision, prepareLauncherUpdate, startLauncherSwap, cleanupLauncherUpdates, healthyMarker } from './self-update.mjs';
import { reuseVerified, playPlan } from './version-status.mjs';
import { readGameConfig, writeGameConfig, gameRunning } from './game-config.mjs';
import { DEFAULT_VALUES, validateChanges } from './game-options.mjs';
import { readLauncherConfig, detectBundledClient, standaloneInstallDir, validateFeedUrl, validAccessKey, effectiveAccessKey } from './launcher-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'index.html')).href;
let window;
// settings.json (per-user app data, never the game folder) holds only the player's overrides;
// launcher.config.json supplies the defaults. The access key never leaves the main process.
let settings = { feedUrl: '', installDir: '', accessKey: '', pendingGameOptions: null };
let config = { feedUrl: '', clientExecutable: '', downloadConcurrency: 12, accessKey: '' };
let bundledDir = '';
let busy = false;
let state = { phase: 'idle', message: 'Checking for updates…', canPlay: false, installed: { status: 'unknown' }, available: { status: 'checking' } };
const AVAILABLE_INTERVAL_MS = 10 * 60_000;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const logFile = () => path.join(app.getPath('userData'), 'launcher.log');
const argument = flag => process.argv.find(value => value.startsWith(flag))?.slice(flag.length);

/** Append to launcher.log in the per-user app data folder (rotated at 1 MiB). Never log the access key. */
async function log(message) {
  console.log(message);
  try {
    await mkdir(path.dirname(logFile()), { recursive: true });
    if ((await stat(logFile()).catch(() => null))?.size > 1024 * 1024) await rename(logFile(), `${logFile()}.old`);
    await appendFile(logFile(), `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging never stops the launcher */ }
}

function accessKey() {
  return effectiveAccessKey({ savedKey: settings.accessKey, defaultKey: config.accessKey, feedUrl: settings.feedUrl || config.feedUrl, defaultFeedUrl: config.feedUrl });
}
function effective() {
  return {
    feedUrl: settings.feedUrl || config.feedUrl,
    installDir: settings.installDir || bundledDir || standaloneInstallDir({ home: app.getPath('home') }),
    defaultFeedUrl: config.feedUrl,
    feedOverridden: Boolean(settings.feedUrl),
    installDirSource: settings.installDir ? 'saved' : bundledDir ? 'bundled' : 'default',
    accessKeySource: settings.accessKey ? 'saved' : accessKey() ? 'built-in' : 'none',
    appVersion: app.getVersion(),
  };
}
function send(patch) {
  state = { ...state, ...effective(), ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('launcher:state', state);
}
async function persist() {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  const temporary = `${settingsFile()}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, settingsFile());
}
function requireSettings() {
  const current = effective();
  if (!current.feedUrl || !current.installDir) throw new Error('Set an update server in Settings first.');
  return current;
}
async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}
async function operation(phase, action) {
  if (busy) throw new Error('A launcher operation is already running.');
  busy = true;
  send({ phase, canPlay: false, accessKeyNeeded: false, offlinePlay: false, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: null, etaSeconds: null });
  try { return await action(); }
  catch (error) {
    const denied = error.code === 'ACCESS_KEY_REQUIRED';
    send({ phase: 'error', message: error.message, accessKeyNeeded: denied, canPlay: false, ...(denied ? { available: { status: 'access-key' } } : {}) });
    throw error;
  }
  finally { busy = false; }
}
// Progress arrives per downloaded chunk; forward at most ~10 updates a second to the page.
// Only counts and a short message cross IPC, never the release file list.
let lastProgress = 0;
function progress(value) {
  const now = Date.now();
  if (now - lastProgress < 100 && value.filesDone !== value.filesTotal) return;
  lastProgress = now;
  send({ message: value.message, filesDone: value.filesDone, filesTotal: value.filesTotal, bytesDone: value.bytesDone, bytesTotal: value.bytesTotal,
    bytesPerSecond: value.bytesPerSecond ?? null, etaSeconds: value.etaSeconds ?? null, resumed: Boolean(value.resumed) });
}
// mode 'fast' trusts files whose size and mtime match the install state; 'full' (Repair) hashes everything.
async function checkRelease(mode = 'fast') {
  const { feedUrl, installDir } = requireSettings();
  const release = await loadRelease(feedUrl, { installDir, accessKey: accessKey() });
  send({ version: release.version, news: release.news ?? [], available: availableFrom(release), message: 'Checking installed game files.' });
  const fresh = !(await exists(path.resolve(installDir, ...release.launch.executable.split('/'))));
  const pending = await inspectRelease(installDir, release, progress, { mode });
  await refreshInstalled();
  if (!pending.files.length) markVerified(release, installDir);
  send({ phase: pending.files.length ? 'needs-update' : 'ready', canPlay: !pending.files.length, fresh: fresh && pending.files.length > 0,
    pendingFiles: pending.files.length, pendingBytes: pending.bytes, keptBytes: pending.keptBytes,
    message: pending.files.length ? `${pending.files.length} files need installing or repair.` : 'All release files verified. Ready to play.' });
  return { release, pending };
}
// The release this session last verified with nothing pending. Play right after an install, a
// check or a repair reuses it (when the server still offers the same manifest) instead of walking
// every file again; it is spent once the game starts, so the next Play checks sizes and dates.
const VERIFIED_REUSE_MS = 30 * 60_000;
let lastVerified = null;
function markVerified(release, installDir) {
  lastVerified = { release, installDir, feedUrl: effective().feedUrl, at: Date.now() };
}
async function recentlyVerified() {
  const { feedUrl, installDir } = effective();
  const recent = lastVerified;
  if (!recent || recent.installDir !== installDir || recent.feedUrl !== feedUrl) return null;
  const executablePresent = await exists(path.resolve(installDir, ...recent.release.launch.executable.split('/')));
  const offered = executablePresent ? await checkAvailableRelease(feedUrl, { accessKey: accessKey() }) : null;
  return reuseVerified({ recent, installDir, feedUrl, now: Date.now(), maxAgeMs: VERIFIED_REUSE_MS, executablePresent, offered }) ? recent.release : null;
}
// Installed: what this game folder last fully verified as (.slumsms-launcher/installed.json, written by
// the updater). Available: the server's top-level manifest only; never layer manifests or files.
const availableFrom = release => ({ status: 'ok', version: release.version, layers: release.layers.map(({ name, version }) => ({ name, version })) });
async function refreshInstalled() {
  const { installDir } = effective();
  let installed = { status: 'not-installed' };
  if (installDir) {
    const record = await readInstalledRecord(installDir);
    if (record) installed = { status: 'installed', version: record.release, layers: record.layers.map(({ name, version }) => ({ name, version })) };
    else if (await exists(path.join(installDir, config.clientExecutable || 'SlumsMS.exe'))) installed = { status: 'unknown' };
  }
  send({ installed });
}
let availableRequest = 0;
async function refreshAvailable({ reset = false } = {}) {
  const { feedUrl } = effective();
  const request = ++availableRequest;
  // A periodic re-check keeps showing the last answer; a changed server or key starts over.
  if (reset || state.available?.status !== 'ok') send({ available: { status: 'checking' } });
  if (!feedUrl) { send({ available: { status: 'error' } }); return; }
  const result = await checkAvailableRelease(feedUrl, { accessKey: accessKey() });
  if (request !== availableRequest) return; // the server or key changed meanwhile
  if (result.status !== 'ok') await log(`Version check: ${result.status}: ${result.message}`);
  send({ available: result.status === 'ok' ? { status: 'ok', version: result.version, layers: result.layers } : { status: result.status } });
}
function refreshVersions(options) {
  return Promise.all([refreshInstalled(), refreshAvailable(options)]).catch(error => log(`Version check failed: ${error.message}`));
}
function runProcess(command, args, options, waitForExit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: waitForExit ? ['ignore', 'ignore', 'pipe'] : 'ignore' });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    if (waitForExit) child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Launch failed (${code}).`)));
    else child.once('spawn', () => { child.unref(); resolve(); });
  });
}
// Start-Process uses Windows ShellExecute, including the client's UAC manifest.
// Encode the PowerShell command separately from Windows argument-line quoting.
function windowsArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
async function launch(release) {
  const { installDir } = effective();
  const executable = path.resolve(installDir, ...release.launch.executable.split('/'));
  if (process.platform === 'win32') {
    const argumentsLine = release.launch.args.map(windowsArgument).join(' ');
    const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psLiteral(executable)} -WorkingDirectory ${psLiteral(installDir)}${argumentsLine ? ` -ArgumentList ${psLiteral(argumentsLine)}` : ''}`;
    await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true }, true);
  } else {
    await runProcess(executable, release.launch.args, { cwd: installDir, detached: true });
  }
}

// Self-update runs once, before the first game check. Any failure is logged and the current launcher
// carries on; the swap only starts once a complete, verified build is staged beside it.
const launcherFolder = () => path.dirname(app.getPath('exe'));
let selfUpdateChecked = false;
async function selfUpdate() {
  if (selfUpdateChecked) return false;
  selfUpdateChecked = true;
  const current = app.getVersion();
  const updated = argument('--self-updated=');
  if (!app.isPackaged) return false;
  for (const note of await cleanupLauncherUpdates(launcherFolder(), current)) await log(`Self-update: ${note}`);
  if (process.argv.includes('--no-self-update') || process.env.SLUMSMS_NO_SELF_UPDATE === '1') return false;
  // A build that still reports its old version after updating would update forever; stop the loop.
  if (updated && updated !== current) { await log(`Self-update: started as ${updated} but this build reports ${current}; skipping launcher updates this session.`); return false; }
  const { feedUrl } = effective();
  if (!feedUrl) return false;
  const stalled = new AbortController();
  let watchdog;
  try {
    const channel = await loadLauncherChannel(feedUrl, { accessKey: accessKey(), signal: AbortSignal.timeout(15_000) });
    const decision = launcherUpdateDecision({ channel, currentVersion: current, platform: `${process.platform}-${process.arch}`, skipVersion: argument('--self-update-failed=') });
    if (decision !== 'update') { await log(`Self-update: ${decision}.`); return false; }
    await log(`Self-update: staging launcher ${channel.version} (running ${current}).`);
    send({ phase: 'self-updating', message: `Updating launcher to ${channel.version}…`, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    // No progress for a minute means a stalled download; give up and keep this launcher.
    let last = Date.now();
    watchdog = setInterval(() => { if (Date.now() - last > 60_000) stalled.abort(new Error('The launcher download stalled.')); }, 5_000);
    const { stage, changed } = await prepareLauncherUpdate({ launcherDir: launcherFolder(), channel, concurrency: config.downloadConcurrency, signal: stalled.signal,
      onProgress: value => { last = Date.now(); progress({ ...value, message: `Updating launcher to ${channel.version}…` }); } });
    if (!changed.length) { await log(`Self-update: ${channel.version} has no changed files; nothing to swap.`); return false; }
    send({ message: 'Restarting the launcher…', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    const relaunchArgs = process.argv.slice(1).filter(value => value.startsWith('--feed-url=') || value.startsWith('--install-dir=') || value === '--no-sandbox');
    await startLauncherSwap({ launcherDir: launcherFolder(), stage, channel, changed, currentVersion: current, relaunchArgs, logFile: logFile() });
    await log(`Self-update: ${changed.length} files staged for ${channel.version}; restarting.`);
    app.exit(0);
    return true;
  } catch (error) {
    await log(`Self-update failed; keeping launcher ${current}: ${error.message}`);
    // A missing key is fixed in Settings, whose save re-checks; try the launcher update again then.
    if (error.code === 'ACCESS_KEY_REQUIRED') selfUpdateChecked = false;
    send({ phase: 'checking', message: 'Checking for updates…', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
    return false;
  } finally { clearInterval(watchdog); }
}

// Game options (config.ini). Writes are serialized; while the game runs, changes wait in
// settings.json (per game folder) and are written when the game is closed and the panel is
// opened again, or at the next Play.
let installAbort = null;
let gameOptionsQueue = Promise.resolve();
const serialized = task => { const run = gameOptionsQueue.then(task, task); gameOptionsQueue = run.catch(() => {}); return run; };
function readPending(value) {
  if (!value || typeof value !== 'object' || typeof value.installDir !== 'string') return null;
  try { return { installDir: value.installDir, changes: validateChanges(value.changes) }; } catch { return null; }
}
const pendingFor = installDir => settings.pendingGameOptions?.installDir === installDir ? settings.pendingGameOptions.changes : null;
const isGameRunning = () => gameRunning();
async function gameOptionsState(extra = {}) {
  const { installDir } = effective();
  const current = await readGameConfig(installDir);
  const pending = pendingFor(installDir);
  const running = await isGameRunning();
  // Show what the game will use once the waiting changes are written.
  const values = current.status === 'ok' && pending ? { ...current.values, ...pending } : current.values;
  return { ...current, values, defaults: DEFAULT_VALUES, running, pending: Boolean(pending), ...extra };
}
function flushPendingGameOptions() {
  return serialized(async () => {
    const { installDir } = effective();
    const pending = pendingFor(installDir);
    if (!pending) return;
    try {
      await writeGameConfig(installDir, pending, { isGameRunning });
      settings.pendingGameOptions = null; await persist();
      await log('Game options: applied changes saved while the game was running.');
    } catch (error) {
      if (error.code === 'CONFIG_MISSING') { settings.pendingGameOptions = null; await persist(); }
      if (error.code !== 'GAME_RUNNING') await log(`Game options: could not apply saved changes: ${error.message}`);
    }
  });
}
function saveGameOptions(changes) {
  return serialized(async () => {
    const { installDir } = effective();
    try {
      await writeGameConfig(installDir, { ...(pendingFor(installDir) ?? {}), ...changes }, { isGameRunning });
      if (pendingFor(installDir)) { settings.pendingGameOptions = null; await persist(); }
      return gameOptionsState({ saved: 'written' });
    } catch (error) {
      if (error.code !== 'GAME_RUNNING') throw error;
      settings.pendingGameOptions = { installDir, changes: { ...(pendingFor(installDir) ?? {}), ...changes } };
      await persist();
      return gameOptionsState({ saved: 'pending' });
    }
  });
}

function handle(name, action) {
  ipcMain.handle(`launcher:${name}`, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== page) throw new Error('Untrusted launcher request.');
    return action(...args);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    try {
      const saved = JSON.parse(await readFile(settingsFile(), 'utf8'));
      settings = { feedUrl: typeof saved.feedUrl === 'string' ? saved.feedUrl : '', installDir: typeof saved.installDir === 'string' ? saved.installDir : '',
        accessKey: validAccessKey(saved.accessKey) ? saved.accessKey : '', pendingGameOptions: readPending(saved.pendingGameOptions) };
    } catch (error) { if (error.code !== 'ENOENT') state.message = `Could not read saved settings: ${error.message}`; }
    for (const [flag, key] of [['--feed-url=', 'feedUrl'], ['--install-dir=', 'installDir']]) {
      const value = process.argv.find(argument => argument.startsWith(flag));
      if (value) settings[key] = value.slice(flag.length);
    }
    // Built-in defaults ship in the app; an optional launcher.config.json beside the packaged exe overrides them.
    const launcherDir = path.dirname(app.getPath('exe'));
    try {
      config = await readLauncherConfig([path.join(here, 'launcher.config.json'), ...(app.isPackaged ? [path.join(launcherDir, 'launcher.config.json')] : [])]);
    } catch (error) { state = { ...state, phase: 'error', message: error.message }; }
    if (app.isPackaged) bundledDir = await detectBundledClient(launcherDir, config.clientExecutable);
    window = new BrowserWindow({ width: 1060, height: 860, minWidth: 860, minHeight: 700, backgroundColor: '#16203a',
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    let quitting = false;
    window.on('close', event => {
      if (!busy || quitting) return;
      event.preventDefault();
      if (dialog.showMessageBoxSync(window, { type: 'warning', title: 'File operation in progress',
        message: 'Quit before this operation finishes?', detail: 'Everything already downloaded is kept. The next install checks it and continues from there.',
        buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) return;
      // Stop the install cleanly so it records what it finished, then quit (at most a few seconds).
      quitting = true;
      installAbort?.abort(new Error('The launcher was closed.'));
      const stopped = Date.now();
      const wait = setInterval(() => { if (!busy || Date.now() - stopped > 5_000) { clearInterval(wait); app.exit(0); } }, 100);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    handle('settings', () => { send({}); return effective(); });
    handle('saveFeed', async value => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      const href = validateFeedUrl(value);
      settings.feedUrl = href === config.feedUrl ? '' : href; await persist();
      send({ phase: 'idle', message: 'Update server saved.', canPlay: false, version: undefined, news: [] });
      void refreshVersions({ reset: true });
      return effective();
    });
    handle('resetFeed', async () => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      settings.feedUrl = ''; await persist();
      send({ phase: 'idle', message: 'Update server reset to the default.', canPlay: false, version: undefined, news: [] });
      void refreshVersions({ reset: true });
      return effective();
    });
    const saveKey = async (value, message) => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      if (!validAccessKey(value)) throw new Error('The access key cannot contain control characters or exceed 256 characters.');
      settings.accessKey = value; await persist();
      send({ phase: 'idle', message, canPlay: false, version: undefined, news: [] });
      void refreshVersions({ reset: true });
      return effective();
    };
    handle('saveAccessKey', value => {
      const key = typeof value === 'string' ? value.trim() : value;
      return saveKey(key, key ? 'Access key saved.' : 'Saved access key cleared.');
    });
    handle('clearAccessKey', () => saveKey('', 'Saved access key cleared.'));
    handle('chooseFolder', async () => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      const result = await dialog.showOpenDialog(window, { title: 'Choose SlumsMS game folder', properties: ['openDirectory', 'createDirectory'], defaultPath: effective().installDir });
      if (!result.canceled) {
        settings.installDir = result.filePaths[0]; await persist();
        send({ phase: 'idle', message: 'Game folder saved.', canPlay: false });
        void refreshInstalled().catch(error => log(`Version check failed: ${error.message}`));
      }
      return effective();
    });
    handle('openFolder', async () => {
      const { installDir } = effective();
      if (!(await exists(installDir))) throw new Error('The game folder does not exist yet. Install the game first.');
      const failure = await shell.openPath(installDir);
      if (failure) throw new Error(failure);
    });
    handle('check', () => operation('checking', async () => { if (!(await selfUpdate())) await checkRelease(); }).then(() => undefined));
    // Download and verify what the folder lacks; also the first half of Play when a new release is out.
    const installFiles = async (mode, message) => {
      const { feedUrl, installDir } = requireSettings();
      const release = await loadRelease(feedUrl, { installDir, accessKey: accessKey() });
      send({ phase: 'updating', version: release.version, news: release.news ?? [], available: availableFrom(release),
        message: message || (mode === 'full' ? 'Verifying every file and repairing damage.' : 'Checking what is already installed.') });
      installAbort = new AbortController();
      try {
        await installRelease(installDir, release, progress, { mode, concurrency: config.downloadConcurrency, signal: installAbort.signal });
      } finally { installAbort = null; }
      // installRelease verified every file it kept or wrote; no second pass over the folder.
      markVerified(release, installDir);
      await refreshInstalled();
      send({ phase: 'ready', canPlay: true, fresh: false, pendingFiles: 0, pendingBytes: 0, message: 'All release files verified. Ready to play.' });
      void flushPendingGameOptions();
      return release;
    };
    const install = mode => operation('updating', () => installFiles(mode));
    handle('update', () => install('fast'));
    handle('repair', () => install('full'));
    // Play always asks the server first: a release that went out while the launcher sat open is
    // installed before the game starts. Only when the server cannot be asked does Play start the
    // installed client as-is ("Couldn't check for updates"); the game server's MIN_CLIENT_BUILD gate
    // refuses it at login if it is really too old.
    handle('play', () => operation('checking', async () => {
      const { feedUrl, installDir } = requireSettings();
      send({ message: 'Checking for updates…' });
      const offered = await checkAvailableRelease(feedUrl, { accessKey: accessKey() });
      const record = await readInstalledRecord(installDir);
      const plan = playPlan({ offered, record });
      let release;
      let offline = false;
      if (plan === 'offline') {
        await log(`Play: could not check for updates (${offered.status}: ${offered.message}); starting the installed client.`);
        release = lastVerified?.installDir === installDir ? lastVerified.release : null;
        const launchInfo = release?.launch ?? record?.launch ?? { executable: config.clientExecutable || 'SlumsMS.exe', args: [] };
        if (!(await exists(path.resolve(installDir, ...launchInfo.executable.split('/'))))) {
          throw new Error(`Couldn't check for updates (${offered.message}) and the game is not installed in this folder yet.`);
        }
        release = { launch: launchInfo };
        offline = true;
        send({ available: { status: offered.status } });
      } else {
        send({ available: { status: 'ok', version: offered.version, layers: offered.layers } });
        if (plan === 'update') {
          await log(`Play: ${offered.version} is out (installed: ${record?.release ?? 'unknown'}); updating before launch.`);
          release = await installFiles('fast', `Updating to ${offered.version} before starting the game…`);
        } else {
          release = await recentlyVerified().catch(() => null);
          if (!release) {
            const checked = await checkRelease();
            release = checked.pending.files.length ? await installFiles('fast', 'Repairing changed files before starting the game…') : checked.release;
          }
        }
      }
      await flushPendingGameOptions();
      send({ phase: 'launching', message: 'Starting the client. Accept its Windows prompt if shown.', canPlay: false });
      lastVerified = null;
      await launch(release);
      send({ phase: 'ready', canPlay: true, offlinePlay: offline,
        message: offline ? 'Couldn’t check for updates. Started the installed version.' : 'Client process started.' });
    }));
    handle('gameOptions', async () => { await flushPendingGameOptions(); return gameOptionsState(); });
    handle('saveGameOptions', changes => saveGameOptions(validateChanges(changes)));
    handle('resetGameOptions', () => saveGameOptions({ ...DEFAULT_VALUES }));
    await window.loadFile(path.join(here, 'index.html'));
    // Show installed vs available before the player acts, and notice a new release while the launcher sits open.
    void refreshVersions();
    setInterval(() => { if (!busy) void refreshAvailable().catch(error => log(`Version check failed: ${error.message}`)); }, AVAILABLE_INTERVAL_MS).unref();
    if (app.isPackaged) {
      // Tell the swap helper this build starts, so it keeps the update instead of rolling back.
      const updated = argument('--self-updated=');
      if (updated === app.getVersion()) {
        await writeFile(healthyMarker(launcherFolder(), updated), String(process.pid)).catch(error => log(`Self-update: could not confirm start: ${error.message}`));
        await log(`Self-update: now running launcher ${updated}.`);
      }
    }
  }).catch(error => { dialog.showErrorBox('SlumsMS Launcher', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
