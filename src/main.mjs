import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadRelease, inspectRelease, installRelease } from './updater.mjs';
import { readLauncherConfig, detectBundledClient, standaloneInstallDir, validateFeedUrl, validAccessKey, effectiveAccessKey } from './launcher-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'index.html')).href;
let window;
// settings.json (per-user app data, never the game folder) holds only the player's overrides;
// launcher.config.json supplies the defaults. The access key never leaves the main process.
let settings = { feedUrl: '', installDir: '', accessKey: '' };
let config = { feedUrl: '', clientExecutable: '', downloadConcurrency: 12, accessKey: '' };
let bundledDir = '';
let busy = false;
let state = { phase: 'idle', message: 'Checking for updates…', canPlay: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

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
  send({ phase, canPlay: false, accessKeyNeeded: false, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
  try { return await action(); }
  catch (error) { send({ phase: 'error', message: error.message, accessKeyNeeded: error.code === 'ACCESS_KEY_REQUIRED', canPlay: false }); throw error; }
  finally { busy = false; }
}
// Progress arrives per downloaded chunk; forward at most ~10 updates a second to the page.
// Only counts and a short message cross IPC, never the release file list.
let lastProgress = 0;
function progress(value) {
  const now = Date.now();
  if (now - lastProgress < 100 && value.filesDone !== value.filesTotal) return;
  lastProgress = now;
  send({ message: value.message, filesDone: value.filesDone, filesTotal: value.filesTotal, bytesDone: value.bytesDone, bytesTotal: value.bytesTotal });
}
// mode 'fast' trusts files whose size and mtime match the install state; 'full' (Repair) hashes everything.
async function checkRelease(mode = 'fast') {
  const { feedUrl, installDir } = requireSettings();
  const release = await loadRelease(feedUrl, { installDir, accessKey: accessKey() });
  send({ version: release.version, news: release.news ?? [], message: 'Verifying installed client files.' });
  const fresh = !(await exists(path.resolve(installDir, ...release.launch.executable.split('/'))));
  const pending = await inspectRelease(installDir, release, progress, { mode });
  send({ phase: pending.files.length ? 'needs-update' : 'ready', canPlay: !pending.files.length, fresh: fresh && pending.files.length > 0,
    pendingFiles: pending.files.length, pendingBytes: pending.bytes,
    message: pending.files.length ? `${pending.files.length} files need installing or repair.` : 'All release files verified. Ready to play.' });
  return { release, pending };
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
        accessKey: validAccessKey(saved.accessKey) ? saved.accessKey : '' };
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
    window.on('close', event => {
      if (busy && dialog.showMessageBoxSync(window, { type: 'warning', title: 'File operation in progress',
        message: 'Quit before this operation finishes?', detail: 'The next check will detect incomplete updates. Temporary staging files may remain.',
        buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    handle('settings', () => { send({}); return effective(); });
    handle('saveFeed', async value => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      const href = validateFeedUrl(value);
      settings.feedUrl = href === config.feedUrl ? '' : href; await persist();
      send({ phase: 'idle', message: 'Update server saved.', canPlay: false, version: undefined, news: [] });
      return effective();
    });
    handle('resetFeed', async () => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      settings.feedUrl = ''; await persist();
      send({ phase: 'idle', message: 'Update server reset to the default.', canPlay: false, version: undefined, news: [] });
      return effective();
    });
    const saveKey = async (value, message) => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      if (!validAccessKey(value)) throw new Error('The access key cannot contain control characters or exceed 256 characters.');
      settings.accessKey = value; await persist();
      send({ phase: 'idle', message, canPlay: false, version: undefined, news: [] });
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
      }
      return effective();
    });
    handle('openFolder', async () => {
      const { installDir } = effective();
      if (!(await exists(installDir))) throw new Error('The game folder does not exist yet. Install the game first.');
      const failure = await shell.openPath(installDir);
      if (failure) throw new Error(failure);
    });
    handle('check', () => operation('checking', checkRelease).then(() => undefined));
    const install = mode => operation('updating', async () => {
      const { feedUrl, installDir } = requireSettings();
      const release = await loadRelease(feedUrl, { installDir, accessKey: accessKey() });
      send({ version: release.version, news: release.news ?? [], message: mode === 'full' ? 'Verifying every file and repairing damage.' : 'Installing missing or changed files.' });
      await installRelease(installDir, release, progress, { mode, concurrency: config.downloadConcurrency });
      await checkRelease();
    });
    handle('update', () => install('fast'));
    handle('repair', () => install('full'));
    handle('play', () => operation('checking', async () => {
      const { release, pending } = await checkRelease();
      if (pending.files.length) throw new Error('Install or repair the pending files before playing.');
      send({ phase: 'launching', message: 'Starting the client. Accept its Windows prompt if shown.', canPlay: false });
      await launch(release);
      send({ phase: 'ready', message: 'Client process started.', canPlay: true });
    }));
    await window.loadFile(path.join(here, 'index.html'));
  }).catch(error => { dialog.showErrorBox('SlumsMS Launcher', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
