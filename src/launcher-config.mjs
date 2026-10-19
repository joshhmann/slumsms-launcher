import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const localHosts = ['localhost', '127.0.0.1', '[::1]'];
export const DEFAULT_DOWNLOAD_CONCURRENCY = 12;

/** Normalize a release feed URL; only HTTPS, or HTTP on localhost for development. */
export function validateFeedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHosts.includes(url.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost for development.');
  }
  return url.href;
}

/** An access key is the HTTP Basic password for user "slums"; empty means none. */
export function validAccessKey(value) {
  return typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Pick the access key for a feed: the player's saved key wins; otherwise the built-in key, but only
 * while the feed is the built-in one, so a custom server never receives the shipped key.
 */
export function effectiveAccessKey({ savedKey = '', defaultKey = '', feedUrl = '', defaultFeedUrl = '' }) {
  if (savedKey) return savedKey;
  if (!defaultKey || !feedUrl || !defaultFeedUrl) return '';
  try { return new URL(feedUrl).origin === new URL(defaultFeedUrl).origin ? defaultKey : ''; } catch { return ''; }
}

/** Read launcher.config.json files in order; later files override earlier ones and missing files are skipped. */
export async function readLauncherConfig(files) {
  const config = { feedUrl: '', clientExecutable: '', downloadConcurrency: DEFAULT_DOWNLOAD_CONCURRENCY, accessKey: '' };
  for (const file of files) {
    let raw;
    try { raw = await readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error(`Launcher config is not valid JSON: ${file}`); }
    if (!value || typeof value !== 'object') throw new Error(`Launcher config must be a JSON object: ${file}`);
    if (typeof value.feedUrl === 'string' && value.feedUrl) {
      try { config.feedUrl = validateFeedUrl(value.feedUrl); } catch (error) {
        throw new Error(`Launcher config feedUrl is invalid in ${file}: ${error.message}`);
      }
    }
    if (typeof value.clientExecutable === 'string' && value.clientExecutable) {
      const name = value.clientExecutable;
      if (name === '.' || name === '..' || /[\\/]/u.test(name)) throw new Error(`Launcher config clientExecutable must be a file name in ${file}.`);
      config.clientExecutable = name;
    }
    if (value.accessKey !== undefined) {
      if (!validAccessKey(value.accessKey)) throw new Error(`Launcher config accessKey must be a string without control characters in ${file}.`);
      config.accessKey = value.accessKey;
    }
    if (value.downloadConcurrency !== undefined) {
      const count = value.downloadConcurrency;
      if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new Error(`Launcher config downloadConcurrency must be an integer from 1 to 32 in ${file}.`);
      config.downloadConcurrency = count;
    }
  }
  return config;
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

/** Find a client shipped with the launcher: the launcher's own folder, or its parent when shipped in a subfolder. */
export async function detectBundledClient(launcherDir, clientExecutable) {
  if (!clientExecutable) return '';
  for (const directory of [launcherDir, path.dirname(launcherDir)]) {
    if (await isFile(path.join(directory, clientExecutable))) return directory;
  }
  return '';
}

/** Default folder for a standalone install; per-user so it never needs elevation. */
export function standaloneInstallDir({ home, platform = process.platform, env = process.env }) {
  const base = platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : home;
  return path.join(base, 'SlumsMS');
}
