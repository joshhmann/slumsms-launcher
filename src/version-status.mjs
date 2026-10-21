/**
 * Installed vs available game version, as shown in the STATUS panel and the Settings footer.
 * Pure: no DOM, so it is unit-tested directly.
 *
 * installed: { status: 'installed', version, layers } | { status: 'unknown' } | { status: 'not-installed' }
 *   'unknown' is an existing client the launcher has not verified since it started recording versions.
 * available: { status: 'ok', version, layers } | { status: 'checking' } | { status: 'access-key' | 'offline' | 'error' }
 */

const layerText = (layers) => (Array.isArray(layers) ? layers : [])
  .filter((layer) => layer && typeof layer.name === 'string' && typeof layer.version === 'string')
  .map((layer) => `${layer.name} ${layer.version}`).join(' · ');

export function versionStatus(installed, available) {
  const have = installed?.status === 'installed' && typeof installed.version === 'string' && installed.version ? installed.version : '';
  const offer = available?.status === 'ok' && typeof available.version === 'string' && available.version ? available.version : '';
  const checking = !available || available.status === 'checking';
  const installedLabel = have || (installed?.status === 'not-installed' ? 'Not installed' : 'Unknown');
  const availableLabel = offer || (checking ? 'Checking…' : 'Couldn’t check');

  let kind;
  if (!offer) kind = checking ? 'checking' : 'couldnt-check';
  else if (installed?.status === 'not-installed') kind = 'not-installed';
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
    installedTitle: have ? layerText(installed.layers) : '',
    availableTitle,
    note: {
      'up-to-date': 'Up to date',
      'update-available': 'Update available',
      'not-installed': 'Not installed',
      unknown: 'Verify to confirm',
      'couldnt-check': '',
      checking: '',
    }[kind],
  };
}

/** Settings footer: "Launcher X · Game installed Y / available Z". */
export function versionFooter(appVersion, installed, available) {
  const status = versionStatus(installed, available);
  return [appVersion && `Launcher ${appVersion}`, `Game installed ${status.installedLabel} / available ${status.availableLabel}`]
    .filter(Boolean).join(' · ');
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
 * The feed line on the main screen: "Feed: live" for the shipped live feed, otherwise a short name
 * ("test (launcher-rc)" on the live host, "custom (host/dir)" elsewhere). `warn` when the feed is not
 * this build's default, so a feed changed by hand (or by another launcher) is never silent.
 */
export function feedLabel(feedUrl, { liveFeedUrl = '', defaultFeedUrl = '' } = {}) {
  if (!feedUrl) return { text: 'Feed: none set', warn: true, name: '' };
  let name;
  try {
    const url = new URL(feedUrl);
    const live = liveFeedUrl ? new URL(liveFeedUrl) : null;
    const folders = url.pathname.split('/').filter(Boolean);
    if (folders.length && /\.json$/iu.test(folders.at(-1))) folders.pop();
    const folder = folders.at(-1) ?? '';
    if (feedUrl === liveFeedUrl) name = 'live';
    else if (live && url.host === live.host) name = folder ? `test (${folder})` : 'test';
    else name = `custom (${url.host}${folder ? `/${folder}` : ''})`;
  } catch {
    name = 'custom';
  }
  const warn = feedUrl !== defaultFeedUrl;
  return { name, warn, text: `Feed: ${name}${warn ? ' · not this launcher’s default' : ''}` };
}
