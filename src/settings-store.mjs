import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Launcher settings live per launcher install: userData/installs/<key>/settings.json, keyed by the
 * folder the launcher runs from. Up to 1.3.2 every launcher on a PC shared userData/settings.json, so
 * a test build's feed and folder silently became the everyday launcher's too. Self-update swaps files
 * in place, so the key survives launcher updates.
 */
export const LEGACY_SETTINGS = 'settings.json';

export function installKey(launcherDir, platform = process.platform) {
  const normalized = path.resolve(launcherDir).replace(/[\\/]+$/u, '');
  const comparable = platform === 'win32' ? normalized.toLowerCase() : normalized;
  return createHash('sha256').update(comparable).digest('hex').slice(0, 16);
}

export function settingsPath(userData, launcherDir, platform = process.platform) {
  return path.join(userData, 'installs', installKey(launcherDir, platform), 'settings.json');
}

/**
 * Read this install's settings text. With no per-install file yet, the first launcher install that
 * starts claims the old shared settings.json (renamed to settings.json.migrated-<key>, so the claim is
 * atomic and happens once) and copies it to its own file; every other install starts from defaults.
 * Returns { text, migrated } with text null when there is nothing to read.
 */
export async function loadInstallSettings({ userData, launcherDir, platform = process.platform }) {
  const file = settingsPath(userData, launcherDir, platform);
  try { return { text: await readFile(file, 'utf8'), migrated: false, file }; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const legacy = path.join(userData, LEGACY_SETTINGS);
  const claimed = `${legacy}.migrated-${installKey(launcherDir, platform)}`;
  try { await rename(legacy, claimed); } catch (error) {
    if (error.code === 'ENOENT') return { text: null, migrated: false, file };
    throw error;
  }
  const text = await readFile(claimed, 'utf8');
  await writeInstallSettings(file, text);
  return { text, migrated: true, file };
}

export async function writeInstallSettings(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}
