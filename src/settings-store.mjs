import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Launcher settings live per launcher install: userData/installs/<key>/settings.json, keyed by the
 * folder the launcher runs from, and inside that per channel (channels.mjs). Up to 1.3.2 every
 * launcher on a PC shared userData/settings.json, so a test build's feed and folder silently became
 * the everyday launcher's too. Self-update swaps files in place, so the key survives launcher updates.
 */
export const LEGACY_SETTINGS = 'settings.json';
export const LEGACY_BACKUP = 'settings.json.backup-before-1.3.3';

export function installKey(launcherDir, platform = process.platform) {
  const normalized = path.resolve(launcherDir).replace(/[\\/]+$/u, '');
  const comparable = platform === 'win32' ? normalized.toLowerCase() : normalized;
  return createHash('sha256').update(comparable).digest('hex').slice(0, 16);
}

export function settingsPath(userData, launcherDir, platform = process.platform) {
  return path.join(userData, 'installs', installKey(launcherDir, platform), 'settings.json');
}

async function readOrNull(file) {
  try { return await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * This install's settings text, or (when it has none yet) the old shared settings.json for a one-time
 * migration. The shared file is never changed or removed: launchers older than 1.3.3 still read it.
 * Returns { text, legacyText, file }; text is null until this install has saved once.
 */
export async function loadInstallSettings({ userData, launcherDir, platform = process.platform }) {
  const file = settingsPath(userData, launcherDir, platform);
  const text = await readOrNull(file);
  const legacyText = text === null ? await readOrNull(path.join(userData, LEGACY_SETTINGS)) : null;
  return { text, legacyText, file };
}

/** Keep one copy of the shared file as it was before the first 1.3.3 migration (never overwritten). */
export async function backupLegacySettings(userData) {
  const backup = path.join(userData, LEGACY_BACKUP);
  if (await readOrNull(backup) !== null) return backup;
  try { await copyFile(path.join(userData, LEGACY_SETTINGS), backup); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
  return backup;
}

export async function writeInstallSettings(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}
