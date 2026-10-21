import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { applyGameOptions, readGameOptions, validateChanges } from './game-options.mjs';

/**
 * config.ini on disk for the Game options panel. The file is the player's (publish marks it
 * player-owned; updates never replace it) and it holds the server address, so this module never
 * creates it: a missing file is left to the install flow, which ships one.
 */
export const CONFIG_FILE = 'config.ini';
/** Executables that read config.ini at start-up: the starter and the client it opens. */
export const GAME_PROCESSES = Object.freeze(['SlumsMS.exe', 'MapleStory.exe']);

const configPath = (installDir) => path.join(installDir, CONFIG_FILE);

async function readText(installDir) {
  try {
    const stat = await fs.lstat(configPath(installDir));
    if (!stat.isFile()) throw new Error(`${CONFIG_FILE} in the game folder is not a regular file.`);
    // latin1 maps every byte to one character and back, so untouched bytes survive exactly.
    return await fs.readFile(configPath(installDir), 'latin1');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** { status: 'missing' } or { status: 'ok', values, legacyMoveAttack, parseErrorLine }. */
export async function readGameConfig(installDir) {
  if (!installDir) return { status: 'missing' };
  const text = await readText(installDir);
  if (text === null) return { status: 'missing' };
  return { status: 'ok', ...readGameOptions(text) };
}

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Apply { id: boolean } to config.ini. Refuses while the game runs (it reads the file only at
 * start-up and some players' clients write it back) and when the file is missing. The new file is
 * written beside the old one and renamed over it, so a crash leaves the old or the new file, never
 * half of one. Returns the options as the client will now read them.
 */
export async function writeGameConfig(installDir, changes, { isGameRunning = async () => false } = {}) {
  const clean = validateChanges(changes);
  if (!installDir) throw failure('Choose a game folder first.', 'CONFIG_MISSING');
  if (await isGameRunning()) throw failure('Close SlumsMS to change game options. They apply the next time the game starts.', 'GAME_RUNNING');
  const before = await readText(installDir);
  if (before === null) throw failure(`${CONFIG_FILE} is missing from the game folder. Install or repair the game first.`, 'CONFIG_MISSING');
  const after = applyGameOptions(before, clean);
  if (after !== before) {
    const target = configPath(installDir);
    const temporary = path.join(installDir, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, after, { encoding: 'latin1', flag: 'wx' });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return { status: 'ok', ...readGameOptions(after) };
}

/** Names from `tasklist /FO CSV /NH` (Windows) or `ps -A -o comm=` that match `names`, case-insensitively. */
export function runningGameNames(output, names = GAME_PROCESSES) {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const found = new Set();
  for (const line of String(output).split(/\r?\n/u)) {
    const csv = /^"([^"]*)"/u.exec(line.trim());
    const name = path.basename((csv ? csv[1] : line.trim()).replaceAll('\\', '/')).toLowerCase();
    if (wanted.has(name)) found.add(wanted.get(name));
  }
  return [...found];
}

/**
 * Whether a game process is running. The client asks for admin rights, so its path cannot be read
 * from a normal launcher; a process with the game's name counts. A failed process list counts as
 * not running (the write itself is still atomic).
 */
export function gameRunning({ names = GAME_PROCESSES, platform = process.platform, run = execFile } = {}) {
  const [command, args] = platform === 'win32' ? ['tasklist.exe', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'comm=']];
  return new Promise((resolve) => {
    run(command, args, { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(!error && runningGameNames(stdout, names).length > 0);
    });
  });
}
