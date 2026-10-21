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
