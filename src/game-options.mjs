/**
 * Game options: the [discord]/[clienthax] switches the client reads from config.ini at start-up.
 *
 * Pure text functions (no Node imports) so the page can share the option list. The file is read and
 * written as latin1, one byte per character, so everything this module does not own (comments,
 * order, unknown sections and keys, CRLF, [config] host/port, [debug]) comes back byte-for-byte.
 *
 * Reading follows the client's parser (inih in mapleroot/ijl15/INIReader.h): section and key names
 * are case-insensitive, `;`/`#` start a comment line, ` ;` starts an inline comment, a repeated key
 * (or an indented continuation line) joins values with a newline so the boolean no longer parses
 * and the client falls back to its default. Booleans are true/yes/on/1 and false/no/off/0.
 */

/** What the client does with each key, in player words. `fallback` is the client's value when the key is absent. */
export const GAME_OPTIONS = Object.freeze([
  { id: 'discord', section: 'discord', key: 'enableactivitystatus', fallback: true, group: 'General',
    label: 'Show your game on Discord', description: 'Shows your character\'s name, level and job as your Discord status while you play.' },
  { id: 'winkey', section: 'clienthax', key: 'enablewinkey', fallback: true, group: 'General',
    label: 'Allow the Windows key', description: 'Keeps the Windows key working while the game window is active.' },
  { id: 'nobulb', section: 'clienthax', key: 'nobulb', fallback: true, group: 'Display',
    label: 'Hide the quest lightbulb', description: 'Stops the lightbulb popping up when a new quest becomes available.' },
  { id: 'customcolor', section: 'clienthax', key: 'customcolor', fallback: true, group: 'Display',
    label: 'Orange name and skill text', description: 'Shows your name and level in the stat window, and skill names, in orange.' },
  { id: 'attackwalk', section: 'clienthax', key: 'attackwalk', fallback: false, group: 'Movement', legacy: 'walk',
    label: 'Keep walking while attacking', description: 'Your character keeps sliding along the ground while an attack plays. Off: you stop to attack.' },
  { id: 'attackjump', section: 'clienthax', key: 'attackjump', fallback: true, group: 'Movement', legacy: 'follow',
    label: 'Jump while attacking', description: 'Lets you jump in the middle of an attack instead of waiting for it to finish.' },
  { id: 'chargemove', section: 'clienthax', key: 'chargemove', fallback: true, group: 'Movement', legacy: 'follow',
    label: 'Move while charging skills', description: 'Lets you move while holding a charged or key-down skill (like Hurricane or Big Bang).' },
  { id: 'doubletapjump', section: 'clienthax', key: 'doubletapjump', fallback: true, group: 'Movement',
    label: 'Double-tap jump to Flash Jump', description: 'Press jump again in mid-air to bounce (Ninja Bounce, or Flash Jump for thieves). Doesn\'t work in jump quests.' },
  { id: 'jumpshoot', section: 'clienthax', key: 'jumpshoot', fallback: true, group: 'Movement',
    label: 'Shoot in mid-air', description: 'Lets bow, crossbow, claw and gun attacks fire while you are jumping.' },
  { id: 'jumpmagic', section: 'clienthax', key: 'jumpmagic', fallback: true, group: 'Movement',
    label: 'Cast magic in mid-air', description: 'Lets magic attacks be cast while you are jumping.' },
].map((option) => Object.freeze(option)));

/** MapleRoot's single switch for all three movement keys; read for older files, never written. */
export const LEGACY_MOVEATTACK = Object.freeze({ section: 'clienthax', key: 'moveattack' });

export const DEFAULT_VALUES = Object.freeze(Object.fromEntries(GAME_OPTIONS.map((option) => [option.id, option.fallback])));
const byId = new Map(GAME_OPTIONS.map((option) => [option.id, option]));
const BOM = 'ï»¿'; // UTF-8 BOM as latin1 characters

const isSpace = (character) => character === ' ' || character === '\t' || character === '\r' || character === '\n' || character === '\v' || character === '\f';
const lskip = (text) => { let i = 0; while (i < text.length && isSpace(text[i])) i += 1; return text.slice(i); };
const rstrip = (text) => { let i = text.length; while (i > 0 && isSpace(text[i - 1])) i -= 1; return text.slice(0, i); };

/** inih's find_chars_or_comment: index of the first of `chars`, or of a ';' that follows whitespace. */
function findCharsOrComment(text, chars) {
  let wasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    if ((chars && chars.includes(text[i])) || (wasSpace && text[i] === ';')) return i;
    wasSpace = isSpace(text[i]);
  }
  return text.length;
}

/** Parse into lines, keeping each line's own terminator so joining them gives the input back exactly. */
export function parseIni(text) {
  if (typeof text !== 'string') throw new TypeError('config.ini text must be a string.');
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(BOM.length) : text;
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  for (const match of body.matchAll(pattern)) {
    if (match[0] === '' && match.index === body.length) break;
    lines.push({ text: match[1], eol: match[2] });
  }
  const eol = lines.find((line) => line.eol)?.eol ?? '\r\n';
  // Classify like inih.
  let section = '';
  let previous = null; // the key line a continuation belongs to
  let error = 0;
  lines.forEach((line, index) => {
    const raw = line.text;
    const start = lskip(rstrip(raw));
    line.section = section;
    if (start.startsWith(';') || start.startsWith('#')) { line.kind = 'comment'; return; }
    if (previous && start && start.length < rstrip(raw).length) {
      line.kind = 'continuation';
      line.owner = previous;
      const end = findCharsOrComment(start, null);
      line.value = rstrip(start.slice(0, end));
      return;
    }
    if (start.startsWith('[')) {
      const end = findCharsOrComment(start.slice(1), ']');
      if (start[1 + end] === ']') {
        section = start.slice(1, 1 + end);
        line.kind = 'section';
        line.section = section;
        previous = null;
      } else {
        line.kind = 'invalid';
        if (!error) error = index + 1;
      }
      return;
    }
    if (!start) { line.kind = 'blank'; return; }
    const end = findCharsOrComment(start, '=:');
    if (start[end] === '=' || start[end] === ':') {
      line.kind = 'key';
      line.name = rstrip(start.slice(0, end));
      let value = lskip(start.slice(end + 1));
      value = rstrip(value.slice(0, findCharsOrComment(value, null)));
      line.value = value;
      line.key = `${section.toLowerCase()}=${line.name.toLowerCase()}`;
      previous = line;
    } else {
      line.kind = 'invalid';
      if (!error) error = index + 1;
    }
  });
  return { bom, eol, lines, parseErrorLine: error };
}

export function serializeIni(ini) {
  return (ini.bom ? BOM : '') + ini.lines.map((line) => line.text + line.eol).join('');
}

const keyOf = (section, key) => `${section.toLowerCase()}=${key.toLowerCase()}`;

/** The value the client sees for a key (repeats and continuations joined with "\n"), or undefined. */
export function getValue(ini, section, key) {
  const wanted = keyOf(section, key);
  let value;
  for (const line of ini.lines) {
    const isKey = line.kind === 'key' && line.key === wanted;
    const isMore = line.kind === 'continuation' && line.owner.key === wanted;
    if (!isKey && !isMore) continue;
    value = value === undefined || value === '' ? line.value : `${value}\n${line.value}`;
  }
  return value;
}

/** inih GetBoolean without a default: true, false, or null when absent or unreadable. */
export function parseBoolean(value) {
  if (value === undefined) return null;
  const lower = value.toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(lower)) return true;
  if (['false', 'no', 'off', '0'].includes(lower)) return false;
  return null;
}

/**
 * What the client will do: { values: { id: boolean }, legacyMoveAttack: boolean|null, parseErrorLine }.
 * Movement keys follow the client's precedence (src/attackstop_patch.h ResolveMoveAttackSettings):
 * attackwalk defaults off whatever moveattack says; attackjump and chargemove default to moveattack.
 */
export function readGameOptions(text) {
  const ini = typeof text === 'string' ? parseIni(text) : text;
  const legacy = parseBoolean(getValue(ini, LEGACY_MOVEATTACK.section, LEGACY_MOVEATTACK.key));
  const values = {};
  for (const option of GAME_OPTIONS) {
    const own = parseBoolean(getValue(ini, option.section, option.key));
    values[option.id] = own ?? (option.legacy === 'follow' ? (legacy ?? option.fallback) : option.fallback);
  }
  return { values, legacyMoveAttack: legacy, parseErrorLine: ini.parseErrorLine };
}

/** Keep the original key spelling, spacing and inline comment; replace only the value. */
function rewriteValue(line, value) {
  const match = /^(\s*[^=:]*?\s*[=:][ \t]*)(.*)$/su.exec(line.text);
  if (!match) return `${line.name}=${value}`;
  const rest = match[2];
  const comment = findCharsOrComment(rest, null);
  const before = rest.slice(0, comment);
  const trailing = before.length - rstrip(before).length;
  return match[1] + value + rest.slice(comment - trailing);
}

/** Set one key: the first line keeps its place, repeats and continuations go, a new key joins the end of its section. */
function setValue(ini, section, key, value) {
  const wanted = keyOf(section, key);
  const matches = ini.lines.filter((line) => (line.kind === 'key' && line.key === wanted) || (line.kind === 'continuation' && line.owner.key === wanted));
  if (matches.length) {
    const [first, ...rest] = matches;
    first.text = rewriteValue(first, value);
    first.value = value;
    ini.lines = ini.lines.filter((line) => !rest.includes(line));
    return;
  }
  const line = { text: `${key}=${value}`, eol: ini.eol, kind: 'key', name: key, value, key: wanted, section };
  const headers = ini.lines.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === 'section' && entry.section.toLowerCase() === section.toLowerCase());
  if (headers.length) {
    // After the last key of the section's first block, else straight after its header.
    let at = headers[0].index;
    for (let i = at + 1; i < ini.lines.length && ini.lines[i].kind !== 'section'; i += 1) {
      if (ini.lines[i].kind === 'key' || ini.lines[i].kind === 'continuation') at = i;
    }
    if (!ini.lines[at].eol) ini.lines[at].eol = ini.eol;
    ini.lines.splice(at + 1, 0, line);
    return;
  }
  const last = ini.lines.at(-1);
  if (last && !last.eol) last.eol = ini.eol;
  if (last && last.kind !== 'blank') ini.lines.push({ text: '', eol: ini.eol, kind: 'blank', section: last.section });
  ini.lines.push({ text: `[${section}]`, eol: ini.eol, kind: 'section', section }, line);
}

/** The three keys that replace MapleRoot's moveattack; a change to any of them writes all three. */
export const MOVE_ATTACK_IDS = Object.freeze(['attackwalk', 'attackjump', 'chargemove']);

/**
 * Apply { id: boolean } changes to config.ini text and return the new text. Only the keys of the
 * changed options are touched, except that a change to one movement key writes all three (with the
 * values the client uses now), so the file no longer depends on `moveattack`. `moveattack` itself is
 * never written or removed (an older client still reads it).
 */
export function applyGameOptions(text, changes) {
  const ini = parseIni(text);
  if (MOVE_ATTACK_IDS.some((id) => id in changes)) {
    const { values } = readGameOptions(ini);
    changes = { ...Object.fromEntries(MOVE_ATTACK_IDS.map((id) => [id, values[id]])), ...changes };
  }
  for (const [id, value] of Object.entries(changes)) {
    const option = byId.get(id);
    if (!option) throw new Error(`Unknown game option: ${id}.`);
    if (typeof value !== 'boolean') throw new Error(`Game option ${id} must be on or off.`);
    setValue(ini, option.section, option.key, value ? 'true' : 'false');
  }
  return serializeIni(ini);
}

/** Validate a change set from the page: known ids with boolean values only. */
export function validateChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Game options must be an object.');
  const clean = {};
  for (const [id, value] of Object.entries(changes)) {
    if (!byId.has(id)) throw new Error(`Unknown game option: ${id}.`);
    if (typeof value !== 'boolean') throw new Error(`Game option ${id} must be on or off.`);
    clean[id] = value;
  }
  return clean;
}
