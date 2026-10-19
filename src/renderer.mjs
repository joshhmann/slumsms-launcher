const elements = Object.fromEntries([
  'phase-badge', 'phase-label', 'status-heading', 'status-message',
  'release-version', 'progress-area', 'progress-label', 'progress-detail',
  'operation-progress', 'feed-form', 'feed-url', 'feed-notice', 'save-feed',
  'install-dir', 'choose-folder', 'check-files', 'install-update', 'play',
  'play-label', 'action-help', 'error-message',
].map((id) => [id, document.getElementById(id)]));

const phaseNames = {
  idle: 'Not checked',
  checking: 'Checking files',
  ready: 'Ready to play',
  'needs-update': 'Update needed',
  updating: 'Updating files',
  launching: 'Launching',
  error: 'Needs attention',
};
const phaseHeadings = {
  idle: 'Your client, your way.',
  checking: 'Checking your client.',
  ready: 'Ready when you are.',
  'needs-update': 'Your client needs an update.',
  updating: 'Getting everything ready.',
  launching: 'Opening your adventure.',
  error: 'Let’s get you back on track.',
};
const busyPhases = new Set(['checking', 'updating', 'launching']);
const bridge = window.launcher;
const bridgeAvailable = ['settings', 'saveFeed', 'chooseFolder', 'check', 'update', 'play', 'onState']
  .every((method) => typeof bridge?.[method] === 'function');
const configuration = { feedUrl: '', installDir: '' };
let state = { phase: 'idle', message: 'Loading launcher settings…', canPlay: false };
let initialized = false;
let operation = null;
let errorMessage = '';
let validationMessage = '';
let unsubscribe;

function hasUnsavedFeed() {
  return elements['feed-url'].value.trim() !== configuration.feedUrl;
}

function applySettings(settings, { forceFeed = false, invalidate = false } = {}) {
  const previousFeed = configuration.feedUrl;
  const previousDirectory = configuration.installDir;
  const preserveDraft = hasUnsavedFeed();
  if (typeof settings.feedUrl === 'string') configuration.feedUrl = settings.feedUrl;
  if (typeof settings.installDir === 'string') configuration.installDir = settings.installDir;
  if (forceFeed || !preserveDraft) elements['feed-url'].value = configuration.feedUrl;
  if (invalidate && (previousFeed !== configuration.feedUrl || previousDirectory !== configuration.installDir)) {
    state = { phase: 'idle', message: 'Settings changed. Check your client files to continue.', canPlay: false };
  }
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
  const visible = state.phase === 'checking' || state.phase === 'updating';
  elements['progress-area'].hidden = !visible;
  if (!visible) {
    elements['operation-progress'].removeAttribute('value');
    elements['progress-detail'].textContent = '';
    return;
  }
  elements['progress-label'].textContent = state.phase === 'checking' ? 'Verifying client files' : 'Installing client files';
  const details = [];
  if (isCount(state.filesDone) && isCount(state.filesTotal)) {
    details.push(`${state.filesDone.toLocaleString()} / ${state.filesTotal.toLocaleString()} files`);
  }
  if (isCount(state.bytesDone) && isCount(state.bytesTotal)) {
    details.push(`${formatBytes(state.bytesDone)} / ${formatBytes(state.bytesTotal)}`);
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

function render() {
  const dirty = hasUnsavedFeed();
  const busy = operation !== null || busyPhases.has(state.phase);
  const blocked = !bridgeAvailable || !initialized || busy;
  const configured = Boolean(configuration.feedUrl && configuration.installDir);
  const canOperate = !blocked && configured && !dirty;
  const phase = state.phase;

  elements['phase-badge'].dataset.phase = phase;
  elements['phase-label'].textContent = !initialized && bridgeAvailable ? 'Starting' : phaseNames[phase];
  elements['status-heading'].textContent = phaseHeadings[phase];
  elements['status-message'].textContent = phase === 'error'
    ? 'The operation could not be completed. See the details below.'
    : state.message;
  elements['release-version'].textContent = state.version || 'Not checked';
  elements['install-dir'].textContent = configuration.installDir || 'No folder selected';
  elements['install-dir'].title = configuration.installDir;
  elements['feed-url'].disabled = blocked;
  elements['save-feed'].disabled = blocked || !dirty;
  elements['save-feed'].textContent = operation === 'save' ? 'Saving…' : 'Save source';
  elements['choose-folder'].disabled = blocked;
  elements['choose-folder'].textContent = operation === 'folder' ? 'Choosing…' : 'Choose folder';
  elements['check-files'].disabled = !canOperate;
  elements['check-files'].textContent = operation === 'check' || phase === 'checking' ? 'Checking files…' : 'Check files / repair';
  elements['install-update'].disabled = !canOperate || state.canPlay;
  elements['install-update'].textContent = operation === 'update' || phase === 'updating' ? 'Installing…' : 'Install / update';
  elements.play.disabled = !canOperate || !state.canPlay;
  elements['play-label'].textContent = operation === 'play' || phase === 'launching' ? 'Launching…' : 'Play';
  elements['feed-notice'].textContent = validationMessage || (dirty ? 'Unsaved source. Save it before checking, updating, or playing.' : '');
  elements['feed-url'].setAttribute('aria-invalid', validationMessage ? 'true' : 'false');
  elements['error-message'].hidden = !errorMessage;
  elements['error-message'].textContent = errorMessage;

  let help;
  if (!bridgeAvailable) help = 'Open SlumsMS in the desktop launcher to manage your client.';
  else if (!initialized) help = 'Reading your saved release source and install folder…';
  else if (busy) help = 'Keep the launcher open while this operation completes.';
  else if (dirty) help = 'Save the release source to use the client controls.';
  else if (!configured) help = 'Save a release source and choose an install folder to get started.';
  else if (state.canPlay) help = 'Your files match the checked release. You’re ready to play.';
  else if (phase === 'needs-update') help = 'Install / update downloads the missing or changed files, then verifies your client.';
  else help = 'Check files / repair verifies your installation. Install / update applies any needed repairs.';
  elements['action-help'].textContent = help;
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
  void perform('save', async () => {
    const settings = await bridge.saveFeed(url);
    applySettings(settings, { forceFeed: true, invalidate: true });
  });
});

elements['choose-folder'].addEventListener('click', () => {
  void perform('folder', async () => {
    const settings = await bridge.chooseFolder();
    applySettings(settings, { invalidate: true });
  });
});
elements['check-files'].addEventListener('click', () => void perform('check', () => bridge.check()));
elements['install-update'].addEventListener('click', () => void perform('update', () => bridge.update()));
elements.play.addEventListener('click', () => void perform('play', () => bridge.play()));
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
      state = { phase: 'idle', message: 'Choose your release source and install folder, then check your client files.', canPlay: false };
    }
  } catch (error) {
    fail(error);
  } finally {
    initialized = true;
    render();
  }
}

void initialize();
