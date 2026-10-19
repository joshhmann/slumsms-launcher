import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadRelease, inspectRelease, installRelease } from './updater.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'index.html')).href;
let window;
let settings = { feedUrl: '', installDir: '' };
let busy = false;
let state = { phase: 'idle', message: 'Choose your release feed and installation folder.', canPlay: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function send(patch) {
  state = { ...state, ...settings, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('launcher:state', state);
}
async function persist() {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  const temporary = `${settingsFile()}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2));
  await rename(temporary, settingsFile());
}
function requireSettings() {
  if (!settings.feedUrl || !settings.installDir) throw new Error('Choose a release feed and installation folder first.');
}
async function operation(phase, action) {
  if (busy) throw new Error('A launcher operation is already running.');
  busy = true;
  send({ phase, canPlay: false, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
  try { return await action(); }
  catch (error) { send({ phase: 'error', message: error.message, canPlay: false }); throw error; }
  finally { busy = false; }
}
const progress = (value) => send(value);
async function checkRelease() {
  requireSettings();
  const release = await loadRelease(settings.feedUrl);
  send({ version: release.version, message: 'Verifying installed client files.' });
  const pending = await inspectRelease(settings.installDir, release, progress);
  send({ phase: pending.files.length ? 'needs-update' : 'ready', canPlay: !pending.files.length,
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
  const executable = path.resolve(settings.installDir, ...release.launch.executable.split('/'));
  if (process.platform === 'win32') {
    const argumentsLine = release.launch.args.map(windowsArgument).join(' ');
    const command = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${psLiteral(executable)} -WorkingDirectory ${psLiteral(settings.installDir)}${argumentsLine ? ` -ArgumentList ${psLiteral(argumentsLine)}` : ''}`;
    await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true }, true);
  } else {
    await runProcess(executable, release.launch.args, { cwd: settings.installDir, detached: true });
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
      settings = { feedUrl: typeof saved.feedUrl === 'string' ? saved.feedUrl : '', installDir: typeof saved.installDir === 'string' ? saved.installDir : '' };
    } catch (error) { if (error.code !== 'ENOENT') state.message = `Could not read saved settings: ${error.message}`; }
    for (const [flag, key] of [['--feed-url=', 'feedUrl'], ['--install-dir=', 'installDir']]) {
      const value = process.argv.find(argument => argument.startsWith(flag));
      if (value) settings[key] = value.slice(flag.length);
    }
    window = new BrowserWindow({ width: 1060, height: 860, minWidth: 860, minHeight: 700, backgroundColor: '#16203a',
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.on('close', event => {
      if (busy && dialog.showMessageBoxSync(window, { type: 'warning', title: 'File operation in progress',
        message: 'Quit before this operation finishes?', detail: 'The next check will detect incomplete updates. Temporary staging files may remain.',
        buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    handle('settings', () => { send({}); return { ...settings }; });
    handle('saveFeed', async value => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      const url = new URL(value);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost for development.');
      settings.feedUrl = url.href; await persist();
      send({ phase: 'idle', message: 'Release feed saved. Check files to continue.', canPlay: false, version: undefined });
      return { ...settings };
    });
    handle('chooseFolder', async () => {
      if (busy) throw new Error('Wait for the current operation to finish.');
      const result = await dialog.showOpenDialog(window, { title: 'Choose SlumsMS installation folder', properties: ['openDirectory', 'createDirectory'], defaultPath: settings.installDir || app.getPath('documents') });
      if (!result.canceled) {
        settings.installDir = result.filePaths[0]; await persist();
        send({ phase: 'idle', message: 'Installation folder saved. Check files to continue.', canPlay: false });
      }
      return { ...settings };
    });
    handle('check', () => operation('checking', checkRelease).then(() => undefined));
    handle('update', () => operation('updating', async () => {
      requireSettings();
      const release = await loadRelease(settings.feedUrl);
      send({ version: release.version, message: 'Installing missing or changed files.' });
      await installRelease(settings.installDir, release, progress);
      await checkRelease();
    }));
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
