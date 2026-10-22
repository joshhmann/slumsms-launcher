import { versionStatus, versionFooter, formatTimeLeft, actionHelp } from './version-status.mjs';
import { GAME_OPTIONS } from './game-options.mjs';

const elements = Object.fromEntries([
  'phase-badge', 'phase-label', 'status-eyebrow', 'status-heading', 'status-message',
  'install-target', 'install-target-path', 'change-folder-inline', 'release-detail', 'installed-version', 'available-version', 'release-note',
  'news', 'news-list', 'progress-area', 'progress-label', 'progress-detail', 'operation-progress',
  'action-help', 'play', 'play-label', 'error-message', 'open-settings', 'settings-dialog',
  'close-settings', 'install-dir', 'folder-source', 'choose-folder', 'open-folder', 'repair-files',
  'feed-form', 'feed-url', 'feed-help', 'feed-notice', 'save-feed', 'reset-feed', 'settings-error',
  'channel-name', 'channel-select', 'reset-folder', 'question-dialog', 'question-text', 'question-suggested', 'question-live', 'question-skip',
  'version-info', 'open-options', 'options-dialog', 'close-options', 'options-notice', 'options-form', 'restore-options', 'options-saved', 'access-key-form', 'access-key', 'access-key-help', 'save-access-key', 'clear-access-key',
].map((id) => [id, document.getElementById(id)]));

const phaseNames = {
  idle: 'Not checked',
  checking: 'Checking files',
  ready: 'Ready to play',
  'needs-update': 'Update needed',
  updating: 'Updating files',
  'self-updating': 'Updating launcher',
  launching: 'Launching',
  error: 'Needs attention',
};
const phaseHeadings = {
  idle: 'Your client, your way.',
  checking: 'Checking your client.',
  ready: 'Ready when you are.',
  'needs-update': 'Your client needs an update.',
  updating: 'Getting everything ready.',
  'self-updating': 'Updating the launcher.',
  launching: 'Opening your adventure.',
  error: 'Let’s get you back on track.',
};
const busyPhases = new Set(['checking', 'updating', 'self-updating', 'launching']);
const bridgeMethods = ['settings', 'saveFeed', 'resetFeed', 'saveAccessKey', 'clearAccessKey', 'chooseFolder', 'openFolder', 'resetFolder', 'check', 'update', 'repair', 'play', 'setChannel', 'answerMigration', 'onState'];
const bridge = window.launcher;
const bridgeAvailable = bridgeMethods.every((method) => typeof bridge?.[method] === 'function');
const configuration = { feedUrl: '', installDir: '', defaultFeedUrl: '', liveFeedUrl: '', feedOverridden: false, installDirSource: 'default', accessKeySource: 'none', appVersion: '',
  channel: 'live', channelLabel: 'Live', channels: [], showChannelPicker: false };
let state = { phase: 'idle', message: 'Loading launcher settings…', canPlay: false };
let initialized = false;
let operation = null;
let errorMessage = '';
let validationMessage = '';
let renderedNews = '';
let unsubscribe;

// The Advanced field edits the Live server (Test/RC sit beside it), so compare with that.
function hasUnsavedFeed() {
  return elements['feed-url'].value.trim() !== configuration.liveFeedUrl;
}

/** Copy settings from the main process. */
function applySettings(settings, { forceFeed = false } = {}) {
  const preserveDraft = hasUnsavedFeed();
  for (const key of Object.keys(configuration)) {
    if (typeof settings[key] === typeof configuration[key]) configuration[key] = settings[key];
  }
  if (forceFeed || !preserveDraft) elements['feed-url'].value = configuration.liveFeedUrl;
}

function receiveState(nextState) {
  applySettings(nextState);
  state = nextState;
  errorMessage = nextState.phase === 'error' ? nextState.message : '';
  render();
}

function fail(error) {
  errorMessage = typeof error?.message === 'string' ? error.message : String(error);
  if (!errorMessage) errorMessage = 'The launcher could not complete this operation.';
  state = { ...state, phase: 'error', message: 'The operation could not be completed. See the details below.', canPlay: false };
  render();
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

function isCount(value) {
  return Number.isFinite(value) && value >= 0;
}

function renderProgress() {
  const visible = state.phase === 'checking' || state.phase === 'updating' || state.phase === 'self-updating';
  elements['progress-area'].hidden = !visible;
  elements['action-help'].hidden = visible || !elements['action-help'].textContent;
  if (!visible) {
    elements['operation-progress'].removeAttribute('value');
    elements['progress-detail'].textContent = '';
    return;
  }
  elements['progress-label'].textContent = state.phase === 'self-updating' ? 'Updating launcher…'
    : state.phase === 'checking' ? 'Checking game files' : state.fresh || state.resumed ? 'Installing SlumsMS' : 'Downloading update';
  const details = [];
  if (isCount(state.filesDone) && isCount(state.filesTotal)) {
    details.push(`${state.filesDone.toLocaleString()} / ${state.filesTotal.toLocaleString()} files`);
  }
  // The download line ("Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, …") already carries bytes, speed and time left.
  const downloading = state.phase === 'updating' && /^Downloading \d/u.test(state.message ?? '');
  if (!downloading && isCount(state.bytesDone) && isCount(state.bytesTotal)) {
    details.push(`${formatBytes(state.bytesDone)} / ${formatBytes(state.bytesTotal)}`);
  }
  if (!downloading && state.phase !== 'checking' && isCount(state.bytesPerSecond) && state.bytesPerSecond > 0) {
    details.push(`${formatBytes(state.bytesPerSecond)}/s`);
    if (isCount(state.etaSeconds)) details.push(formatTimeLeft(state.etaSeconds));
  }
  elements['progress-detail'].textContent = details.join(' · ');
  const progress = elements['operation-progress'];
  if (isCount(state.bytesDone) && state.bytesTotal > 0) {
    progress.value = Math.min(state.bytesDone / state.bytesTotal, 1);
  } else if (isCount(state.filesDone) && state.filesTotal > 0) {
    progress.value = Math.min(state.filesDone / state.filesTotal, 1);
  } else {
    progress.removeAttribute('value');
  }
}

// Game options: switches the client reads from config.ini. The main process owns the file; the
// page only shows what the game will use and sends one change at a time.
const optionsAvailable = ['gameOptions', 'saveGameOptions', 'resetGameOptions'].every((method) => typeof bridge?.[method] === 'function');
let options = null;
let optionsBusy = false;
let savedTimer;

/** Strip any IPC wrapper text; show only the launcher's own sentence. */
const remoteMessage = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');

function buildOptionsForm() {
  const groups = new Map();
  for (const option of GAME_OPTIONS) {
    if (!groups.has(option.group)) {
      const fieldset = document.createElement('fieldset');
      fieldset.className = 'options-group';
      const legend = document.createElement('legend');
      legend.textContent = option.group.toUpperCase();
      fieldset.append(legend);
      groups.set(option.group, fieldset);
    }
    // The row is not a <label>: a label around its own checkbox can toggle it twice in Chromium.
    const row = document.createElement('div');
    row.className = 'option';
    const title = document.createElement('label');
    title.className = 'option-label';
    title.htmlFor = `option-${option.id}`;
    title.textContent = option.label;
    const help = document.createElement('span');
    help.className = 'option-help';
    help.id = `option-${option.id}-help`;
    help.textContent = option.description;
    const toggle = document.createElement('span');
    toggle.className = 'option-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.id = `option-${option.id}`;
    input.dataset.option = option.id;
    input.setAttribute('aria-describedby', help.id);
    input.addEventListener('change', () => {
      const change = { [option.id]: input.checked };
      void saveOptions(() => bridge.saveGameOptions(change), change);
    });
    const track = document.createElement('span');
    track.className = 'option-track';
    track.setAttribute('aria-hidden', 'true');
    toggle.append(input, track);
    row.append(title, toggle, help);
    groups.get(option.group).append(row);
  }
  elements['options-form'].replaceChildren(...groups.values());
  elements['options-form'].addEventListener('submit', (event) => event.preventDefault());
}

function optionsNotice() {
  if (!optionsAvailable) return { kind: 'error', text: 'Open SlumsMS in the desktop launcher to change game options.' };
  if (!options) return null;
  if (options.error) return { kind: 'error', text: options.error };
  if (options.status === 'missing') return { kind: 'error', text: 'config.ini is not in your game folder yet. Install the game first, then come back here.' };
  if (options.running || options.pending) return { kind: 'pending', text: 'SlumsMS is running. Your changes are kept and written to config.ini once the game is closed (or when you press Play).' };
  if (options.parseErrorLine) return { kind: 'error', text: `Line ${options.parseErrorLine} of config.ini is not something the game can read, so it ignores all of these options. Open the game folder and fix or remove that line.` };
  return null;
}

function renderOptions() {
  const ready = optionsAvailable && options && options.status === 'ok';
  for (const input of elements['options-form'].querySelectorAll('input[data-option]')) {
    input.checked = Boolean(ready && options.values?.[input.dataset.option]);
    input.disabled = !ready || optionsBusy;
  }
  elements['restore-options'].disabled = !ready || optionsBusy;
  const notice = optionsNotice();
  elements['options-notice'].hidden = !notice;
  elements['options-notice'].textContent = notice?.text ?? '';
  elements['options-notice'].dataset.kind = notice?.kind ?? '';
}

async function loadOptions() {
  if (!optionsAvailable) { renderOptions(); return; }
  try { options = await bridge.gameOptions(); } catch (error) { options = { error: remoteMessage(error) }; }
  renderOptions();
}

function showSaved(kind) {
  clearTimeout(savedTimer);
  elements['options-saved'].dataset.kind = kind;
  elements['options-saved'].textContent = kind === 'pending' ? 'Saved. Applies after you close the game.' : 'Saved';
  savedTimer = setTimeout(() => { elements['options-saved'].textContent = ''; }, 2500);
}

/** `shown` is the change the player just made, kept on screen while it saves. */
async function saveOptions(action, shown = {}) {
  if (!optionsAvailable || optionsBusy) return;
  optionsBusy = true;
  if (options?.values) options = { ...options, values: { ...options.values, ...shown } };
  renderOptions();
  try {
    options = await action();
    showSaved(options.saved === 'pending' ? 'pending' : 'written');
  } catch (error) {
    clearTimeout(savedTimer);
    elements['options-saved'].textContent = '';
    // Show the file as it really is after a refused write.
    await loadOptions();
    options = { ...options, error: remoteMessage(error) };
  } finally {
    optionsBusy = false;
    renderOptions();
  }
}

function openOptions() {
  elements['options-saved'].textContent = '';
  if (!elements['options-dialog'].open) elements['options-dialog'].showModal();
  options = null;
  renderOptions();
  void loadOptions();
}

/** Release notes come from the manifest and are rendered strictly as text. */
function renderNews() {
  const news = Array.isArray(state.news) ? state.news : [];
  const key = JSON.stringify(news);
  if (key === renderedNews) return;
  renderedNews = key;
  const list = elements['news-list'];
  list.replaceChildren(...news.map((entry) => {
    const item = document.createElement('li');
    item.className = 'news-item';
    const head = document.createElement('div');
    head.className = 'news-head';
    const title = document.createElement('span');
    title.className = 'news-title';
    title.textContent = entry.title;
    head.append(title);
    if (entry.date) {
      const date = document.createElement('time');
      date.className = 'news-date';
      date.dateTime = entry.date;
      date.textContent = entry.date;
      head.append(date);
    }
    item.append(head);
    if (entry.body) {
      const body = document.createElement('p');
      body.className = 'news-body';
      body.textContent = entry.body;
      item.append(body);
    }
    return item;
  }));
  elements.news.hidden = news.length === 0;
}

/** A first install that stopped part-way: some verified files are already in the folder. */
const resuming = () => state.phase === 'needs-update' && state.fresh && state.keptBytes > 0;

function primaryAction() {
  if (!configuration.feedUrl || (state.phase === 'error' && state.accessKeyNeeded)) return { kind: 'settings', label: 'Open settings', run: openSettings };
  // A newer release seen by the background check while the old one is ready: Update installs it and
  // starts the game (Play itself re-checks the server, so it updates first either way).
  if (state.phase === 'ready' && versionStatus(state.installed, state.available).kind === 'update-available') {
    return { kind: 'update', label: 'Update', run: () => perform('play', () => bridge.play()) };
  }
  if (state.phase === 'ready' && state.canPlay) return { kind: 'play', label: 'Play', run: () => perform('play', () => bridge.play()) };
  if (state.phase === 'needs-update') {
    return { kind: 'update', label: resuming() ? 'Continue install' : state.fresh ? 'Install' : 'Update', run: () => perform('update', () => bridge.update()) };
  }
  return { kind: 'check', label: state.phase === 'error' ? 'Try again' : 'Check for updates', run: checkNow };
}

/** The active channel is always shown; the picker appears only when the key opens more than one. */
function renderChannel(blocked) {
  const custom = configuration.feedOverridden ? ' · custom server' : '';
  elements['channel-name'].textContent = `${configuration.channelLabel || 'Live'}${custom}`;
  elements['channel-name'].title = configuration.feedUrl;
  elements['release-detail'].dataset.channel = configuration.channel;
  const select = elements['channel-select'];
  const channels = Array.isArray(configuration.channels) ? configuration.channels : [];
  select.hidden = !configuration.showChannelPicker || channels.length < 2;
  elements['channel-name'].hidden = !select.hidden && !custom;
  const key = JSON.stringify(channels);
  if (select.dataset.options !== key) {
    select.dataset.options = key;
    select.replaceChildren(...channels.map((channel) => {
      const option = document.createElement('option');
      option.value = channel.id;
      option.textContent = channel.label;
      return option;
    }));
  }
  select.value = configuration.channel;
  select.disabled = blocked;
}

function renderQuestion(blocked) {
  const question = state.migrationQuestion;
  const dialog = elements['question-dialog'];
  if (!question) {
    if (dialog.open) dialog.close();
    return;
  }
  elements['question-text'].textContent = question.message;
  const label = { live: 'Live', test: 'Test', rc: 'RC' }[question.suggested] ?? 'Live';
  elements['question-suggested'].textContent = `Use it as ${label}`;
  elements['question-suggested'].dataset.channel = question.suggested;
  elements['question-live'].hidden = question.suggested === 'live';
  for (const id of ['question-suggested', 'question-live', 'question-skip']) elements[id].disabled = blocked;
  if (!dialog.open && initialized) dialog.showModal();
}

function renderVersions() {
  const status = versionStatus(state.installed, state.available);
  // Same version but files failed verify: not "up to date" until repaired.
  const note = status.kind === 'up-to-date' && state.phase === 'needs-update' ? 'Files need repair' : status.note;
  elements['release-detail'].dataset.kind = note === 'Files need repair' ? 'update-available' : status.kind;
  elements['installed-version'].textContent = status.installedLabel;
  elements['installed-version'].title = status.installedTitle;
  elements['available-version'].textContent = status.availableLabel;
  elements['available-version'].title = status.availableTitle;
  elements['release-note'].textContent = note;
  elements['release-note'].hidden = !note;
}

function busyLabel() {
  if (state.phase === 'self-updating') return 'Updating launcher…';
  if (state.phase === 'updating' || operation === 'update') return state.fresh || state.resumed ? 'Installing…' : 'Updating…';
  if (operation === 'play' || state.phase === 'launching') return 'Launching…';
  if (state.phase === 'checking' || operation === 'check') return 'Checking…';
  return 'Working…';
}

function render() {
  const busy = operation !== null || busyPhases.has(state.phase);
  const blocked = !bridgeAvailable || !initialized || busy;
  const phase = state.phase;
  const fresh = phase === 'needs-update' && state.fresh;
  const action = primaryAction();

  elements['phase-badge'].dataset.phase = phase;
  elements['phase-label'].textContent = !initialized && bridgeAvailable ? 'Starting' : fresh ? 'Not installed' : phaseNames[phase];
  elements['status-eyebrow'].textContent = fresh ? 'FIRST TIME SETUP'
    : phase === 'needs-update' ? 'UPDATE AVAILABLE'
      : phase === 'error' ? 'SOMETHING WENT WRONG' : 'YOUR NEXT ADVENTURE';
  elements['status-heading'].textContent = fresh ? 'Install SlumsMS' : phaseHeadings[phase];
  let message = state.message;
  if (phase === 'error') message = 'The operation could not be completed. See the details below.';
  else if (initialized && !configuration.feedUrl) message = 'No update server is set yet.';
  else if (phase === 'needs-update' && isCount(state.pendingFiles) && isCount(state.pendingBytes)) {
    message = resuming()
      ? `Checked ${formatBytes(state.keptBytes)} already downloaded. ${state.pendingFiles.toLocaleString()} files, ${formatBytes(state.pendingBytes)} left to download.`
      : `${state.pendingFiles.toLocaleString()} files, ${formatBytes(state.pendingBytes)} to download.`;
  }
  elements['status-message'].textContent = message;
  elements['install-target'].hidden = !fresh;
  elements['install-target-path'].textContent = configuration.installDir;
  elements['change-folder-inline'].disabled = blocked;
  renderVersions();
  renderNews();
  renderChannel(blocked);
  renderQuestion(blocked);

  elements.play.dataset.action = action.kind;
  elements.play.disabled = blocked;
  elements['play-label'].textContent = busy ? busyLabel() : action.label;

  const dialogOpen = elements['settings-dialog'].open;
  elements['error-message'].hidden = !errorMessage || dialogOpen;
  elements['error-message'].textContent = errorMessage;
  elements['settings-error'].hidden = !errorMessage || !dialogOpen;
  elements['settings-error'].textContent = errorMessage;

  elements['install-dir'].textContent = configuration.installDir || 'No folder selected';
  elements['install-dir'].title = configuration.installDir;
  elements['folder-source'].textContent = {
    bundled: 'Found next to the launcher.',
    saved: 'Chosen by you.',
    default: 'Default location for this PC.',
  }[configuration.installDirSource] ?? '';
  elements['choose-folder'].disabled = blocked;
  elements['choose-folder'].textContent = operation === 'folder' ? 'Choosing…' : 'Change folder';
  elements['open-folder'].disabled = !bridgeAvailable || !configuration.installDir;
  elements['repair-files'].disabled = blocked || !configuration.feedUrl;
  const dirty = hasUnsavedFeed();
  elements['feed-url'].disabled = blocked;
  elements['save-feed'].disabled = blocked || !dirty;
  elements['save-feed'].textContent = operation === 'save' ? 'Saving…' : 'Save';
  elements['reset-feed'].hidden = !configuration.feedOverridden || !configuration.defaultFeedUrl;
  elements['reset-feed'].disabled = blocked;
  elements['reset-folder'].disabled = blocked || configuration.installDirSource !== 'saved';
  elements['feed-help'].textContent = configuration.feedOverridden && configuration.defaultFeedUrl
    ? `Using a custom server. Default: ${configuration.defaultFeedUrl}`
    : 'Only change this if your server staff gave you a different manifest URL.';
  elements['feed-notice'].textContent = validationMessage || (dirty ? 'Unsaved. Press Save to use this server.' : '');
  elements['feed-url'].setAttribute('aria-invalid', validationMessage ? 'true' : 'false');
  const typedKey = elements['access-key'].value.trim();
  elements['access-key'].disabled = blocked;
  elements['save-access-key'].disabled = blocked || !typedKey;
  elements['save-access-key'].textContent = operation === 'access-key' ? 'Saving…' : 'Save';
  elements['clear-access-key'].hidden = configuration.accessKeySource !== 'saved';
  elements['clear-access-key'].disabled = blocked;
  elements['access-key-help'].textContent = {
    saved: 'Using the key you saved. Enter a new one to replace it.',
    'built-in': 'Using the key built into this launcher. Enter one to override it.',
  }[configuration.accessKeySource] ?? 'Only needed if the update server asks for one.';
  elements['version-info'].textContent = versionFooter(configuration.appVersion, state.installed, state.available);

  elements['action-help'].textContent = actionHelp({
    bridgeAvailable, initialized, phase, busy, feedUrl: configuration.feedUrl, actionKind: action.kind,
    canPlay: state.canPlay, offlinePlay: state.offlinePlay, resuming: resuming(), fresh, accessKeyNeeded: state.accessKeyNeeded,
  });
  renderProgress();
}

async function perform(name, action) {
  if (!bridgeAvailable || !initialized || operation || busyPhases.has(state.phase)) return;
  operation = name;
  errorMessage = '';
  render();
  try {
    await action();
  } catch (error) {
    fail(error);
  } finally {
    operation = null;
    render();
  }
}

function checkNow() {
  if (configuration.feedUrl) return perform('check', () => bridge.check());
  return undefined;
}

/** Run a settings change, then re-check when the feed or folder actually changed. */
async function changeSettings(name, action, { recheck = false } = {}) {
  // State broadcasts may apply the new settings before the call returns, so compare against a snapshot.
  const before = `${configuration.feedUrl}\n${configuration.installDir}`;
  await perform(name, async () => { applySettings(await action(), { forceFeed: true }); });
  if ((recheck || before !== `${configuration.feedUrl}\n${configuration.installDir}`) && !errorMessage) await checkNow();
}

function openSettings() {
  if (!elements['settings-dialog'].open) elements['settings-dialog'].showModal();
  render();
}

function clearValidation() {
  validationMessage = '';
  elements['feed-url'].setCustomValidity('');
}

elements['feed-url'].addEventListener('input', () => {
  clearValidation();
  render();
});

elements['feed-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const url = elements['feed-url'].value.trim();
  try {
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error('Use HTTPS, or localhost HTTP for development.');
  } catch {
    validationMessage = 'Use a complete HTTPS URL, or localhost HTTP for development.';
    elements['feed-url'].setCustomValidity(validationMessage);
    render();
    elements['feed-url'].reportValidity();
    return;
  }
  clearValidation();
  void changeSettings('save', () => bridge.saveFeed(url));
});

// The key is sent to the main process once and never read back into the page.
elements['access-key'].addEventListener('input', render);
elements['access-key-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const key = elements['access-key'].value.trim();
  if (!key) return;
  elements['access-key'].value = '';
  void changeSettings('access-key', () => bridge.saveAccessKey(key), { recheck: true });
});
elements['clear-access-key'].addEventListener('click', () => {
  elements['access-key'].value = '';
  void changeSettings('access-key', () => bridge.clearAccessKey(), { recheck: true });
});
elements['reset-feed'].addEventListener('click', () => void changeSettings('save', () => bridge.resetFeed()));
elements['reset-folder'].addEventListener('click', () => void changeSettings('folder', () => bridge.resetFolder()));
elements['channel-select'].addEventListener('change', () => {
  const channel = elements['channel-select'].value;
  if (channel !== configuration.channel) void changeSettings('channel', () => bridge.setChannel(channel), { recheck: true });
});
const answer = (channel) => void changeSettings('folder', () => bridge.answerMigration(channel), { recheck: true });
elements['question-suggested'].addEventListener('click', () => answer(elements['question-suggested'].dataset.channel));
elements['question-live'].addEventListener('click', () => answer('live'));
elements['question-skip'].addEventListener('click', () => answer(null));
elements['question-dialog'].addEventListener('cancel', (event) => event.preventDefault());
const chooseFolder = () => void changeSettings('folder', () => bridge.chooseFolder());
elements['choose-folder'].addEventListener('click', chooseFolder);
elements['change-folder-inline'].addEventListener('click', chooseFolder);
elements['open-folder'].addEventListener('click', () => {
  bridge.openFolder().then(() => { errorMessage = ''; render(); }, fail);
});
elements['repair-files'].addEventListener('click', () => {
  elements['settings-dialog'].close();
  void perform('update', () => bridge.repair());
});
elements['open-settings'].addEventListener('click', openSettings);
elements['open-options'].addEventListener('click', openOptions);
elements['close-options'].addEventListener('click', () => elements['options-dialog'].close());
elements['restore-options'].addEventListener('click', () => void saveOptions(() => bridge.resetGameOptions()));
elements['close-settings'].addEventListener('click', () => elements['settings-dialog'].close());
elements['settings-dialog'].addEventListener('close', render);
elements.play.addEventListener('click', () => void primaryAction().run());
window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });

async function initialize() {
  if (!bridgeAvailable) {
    fail(new Error('The secure launcher connection is unavailable. Open SlumsMS using the desktop launcher.'));
    return;
  }
  try {
    unsubscribe = bridge.onState(receiveState);
    applySettings(await bridge.settings(), { forceFeed: true });
    if (state.message === 'Loading launcher settings…') {
      state = { phase: 'idle', message: 'Checking for updates…', canPlay: false };
    }
  } catch (error) {
    fail(error);
  } finally {
    initialized = true;
    render();
  }
  if (state.phase !== 'error') await checkNow();
}

buildOptionsForm();
void initialize();
