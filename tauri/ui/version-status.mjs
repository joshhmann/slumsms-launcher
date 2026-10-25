/**
 * The versions the STATUS panel and the Settings footer show. Pure: no DOM, so it is unit-tested directly.
 *
 *   Server    - the release the game server is on: the feed's (manifest's) top-level `version`.
 *   Installed - the release this game folder was last verified as (installed.json).
 *   Client    - the slums.dll build in the folder (slums-build.txt, 1.6.0+), else the installed
 *               record's `client` layer version.
 *   Launcher  - this app's own version.
 *
 * installed: { status: 'installed', version, layers, clientBuild? } | { status: 'unknown', clientBuild? } | { status: 'not-installed' }
 *   'unknown' is an existing client the launcher has not verified since it started recording versions.
 *   clientBuild is { release: '1.6.0', build: 10600 } from slums-build.txt beside slums.dll.
 * available: { status: 'ok', version, layers, minClientBuild? } | { status: 'checking' } | { status: 'access-key' | 'offline' | 'error' }
 *   minClientBuild (optional) is the oldest client build the game server lets in.
 */

const layerText = (layers) => (Array.isArray(layers) ? layers : [])
  .filter((layer) => layer && typeof layer.name === 'string' && typeof layer.version === 'string')
  .map((layer) => `${layer.name} ${layer.version}`).join(' · ');

const isBuild = (n) => Number.isSafeInteger(n) && n > 0;

/** "1.6.0" -> 10600 (major*10000+minor*100+patch); NaN for anything else ("2026.10.19-1", "v83"). */
export function buildNumber(release) {
  const match = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/u.exec(typeof release === 'string' ? release.trim() : '');
  return match ? Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]) : NaN;
}

/**
 * The installed client: { label, title, build, source }.
 *   source 'file'  - slums-build.txt: label "1.6.0 (build 10600)".
 *   source 'layer' - no file (clients before 1.6.0): the installed record's client layer version;
 *                    build is known only when that version is MAJOR.MINOR.PATCH.
 *   source 'none'  - label "Unknown", build NaN.
 * Never throws: a missing or odd value is just "Unknown".
 */
export function clientVersion(installed) {
  const file = installed && installed.status !== 'not-installed' ? installed.clientBuild : undefined;
  if (file && typeof file.release === 'string' && file.release && isBuild(file.build)) {
    return { label: `${file.release} (build ${file.build})`, title: 'From slums-build.txt in the game folder.', build: file.build, source: 'file' };
  }
  const layer = installed?.status === 'installed' && Array.isArray(installed.layers)
    ? installed.layers.find((entry) => entry && entry.name === 'client' && typeof entry.version === 'string' && entry.version)
    : undefined;
  if (layer) return { label: layer.version, title: 'Client layer of the installed release (this client has no build file).', build: buildNumber(layer.version), source: 'layer' };
  return { label: 'Unknown', title: '', build: NaN, source: 'none' };
}

/**
 * "Client update needed: the server needs build 10600 or newer" when the server's manifest names a
 * minClientBuild and the installed client is known to be older; '' otherwise (no field, unknown
 * client, not installed, or the check failed). Play installs the new release, so this is a note,
 * not a new flow.
 */
export function clientUpdateNote(installed, available) {
  const min = available?.status === 'ok' ? available.minClientBuild : undefined;
  if (!isBuild(min) || !installed || installed.status === 'not-installed') return '';
  const { build } = clientVersion(installed);
  return isBuild(build) && build < min ? `Client update needed: the server needs build ${min} or newer` : '';
}

export function versionStatus(installed, available) {
  const have = installed?.status === 'installed' && typeof installed.version === 'string' && installed.version ? installed.version : '';
  const offer = available?.status === 'ok' && typeof available.version === 'string' && available.version ? available.version : '';
  const checking = !available || available.status === 'checking';
  const installedLabel = have || (installed?.status === 'not-installed' ? 'Not installed' : 'Unknown');
  const availableLabel = offer || (checking ? 'Checking…' : 'Couldn’t check');
  const client = clientVersion(installed);
  const clientNote = clientUpdateNote(installed, available);

  let kind;
  if (!offer) kind = checking ? 'checking' : 'couldnt-check';
  else if (installed?.status === 'not-installed') kind = 'not-installed';
  else if (clientNote) kind = 'update-available'; // the server refuses this client: Play updates first
  else if (!have) kind = 'unknown';
  else kind = have === offer ? 'up-to-date' : 'update-available';

  const availableTitle = !offer && available?.status === 'access-key' ? 'The update server needs an access key.'
    : !offer && available?.status === 'offline' ? 'Could not reach the update server.'
      : !offer && available?.status === 'error' ? 'The update server sent an unexpected answer.'
        : layerText(available?.layers);
  return {
    kind,
    installedLabel,
    availableLabel,
    /** The server's release: the same value as availableLabel, under its clearer name. */
    serverLabel: availableLabel,
    installedTitle: have ? layerText(installed.layers) : '',
    availableTitle,
    clientLabel: client.label,
    clientTitle: clientNote ? `${clientNote}.` : client.title,
    clientKnown: client.source !== 'none',
    clientNote,
    note: clientNote ? 'Client update needed' : {
      'up-to-date': 'Up to date',
      'update-available': 'Update available',
      'not-installed': 'Not installed',
      unknown: 'Verify to confirm',
      'couldnt-check': '',
      checking: '',
    }[kind],
  };
}

/** Settings footer: "Launcher X · Server Y · Installed Z · Client 1.6.0 (build 10600)". */
export function versionFooter(appVersion, installed, available) {
  const status = versionStatus(installed, available);
  return [appVersion && `Launcher ${appVersion}`, `Server ${status.serverLabel}`, `Installed ${status.installedLabel}`, `Client ${status.clientLabel}`]
    .filter(Boolean).join(' · ');
}

/** The launcher row in the STATUS panel. */
export function launcherLabel(appVersion) {
  return typeof appVersion === 'string' && appVersion ? appVersion : 'Unknown';
}

/** Download time left, rounded the way people read it ("about 1 h 5 min left"). */
export function formatTimeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/**
 * Whether Play may reuse this session's last full check instead of walking the folder again:
 * same folder and server, recent enough, the game executable still there, and the server still
 * offering exactly the manifest that was verified. `offered` is checkAvailableRelease's answer.
 */
export function reuseVerified({ recent, installDir, feedUrl, now, maxAgeMs, executablePresent, offered }) {
  if (!recent || recent.installDir !== installDir || recent.feedUrl !== feedUrl) return false;
  if (!(now - recent.at >= 0 && now - recent.at <= maxAgeMs) || !executablePresent) return false;
  return offered?.status === 'ok' && Boolean(recent.release?.manifestSha256) && offered.manifestSha256 === recent.release.manifestSha256;
}

/**
 * What Play does, decided right before launching from a fresh look at the top-level manifest
 * (`offered`, checkAvailableRelease's answer) and the folder's installed.json record (`record`).
 *   'offline' - the check failed (no connection, 401/403, bad answer): start the installed client and
 *               say "Couldn't check for updates"; the game server refuses a client that is too old.
 *   'update'  - the server offers a release this folder has not verified as: update, then start.
 *   'verify'  - the folder says it is this release: fast-verify (or reuse a recent verify), then start.
 */
export function playPlan({ offered, record }) {
  if (offered?.status !== 'ok') return 'offline';
  if (!record?.manifestSha256 || record.manifestSha256 !== offered.manifestSha256) return 'update';
  return 'verify';
}


/**
 * The small help line under the status message. Empty when the status message already says it:
 * a ready, verified client ("All release files verified. Ready to play.") needs no second
 * "All game files verified." line, so the renderer hides the line instead.
 */
export function actionHelp({ bridgeAvailable, initialized, phase, busy, feedUrl, actionKind, canPlay, offlinePlay, resuming, fresh, accessKeyNeeded, clientNote }) {
  if (!bridgeAvailable) return 'Open SlumsMS in the desktop launcher to manage your client.';
  if (!initialized) return 'Starting…';
  if (phase === 'self-updating') return 'The launcher restarts by itself when the update is ready.';
  if (busy) return 'Keep the launcher open while this finishes.';
  if (!feedUrl) return 'Set the update server in Settings to get started.';
  if (clientNote && phase === 'ready' && canPlay) return `${clientNote}. Update installs it, then starts the game.`;
  if (clientNote && phase === 'needs-update') return `${clientNote}. Update downloads only the files that changed.`;
  if (phase === 'ready' && canPlay && actionKind === 'update') return 'A new release is out. Update downloads only the files that changed, then starts the game.';
  if (phase === 'ready' && offlinePlay) return 'Couldn’t check for updates. If the game says it is out of date, try again once you are online.';
  if (phase === 'ready' && canPlay) return '';
  if (resuming) return 'Continue install picks up where the last download stopped.';
  if (fresh) return 'Install downloads the game, then checks every file.';
  if (phase === 'needs-update') return 'Update downloads only the files that changed.';
  if (phase === 'error' && accessKeyNeeded) return 'Open Settings and enter the access key your server staff gave you.';
  if (phase === 'error') return 'Try again, or open Settings to repair files or change the game folder.';
  return 'Check for updates to verify your game files.';
}
