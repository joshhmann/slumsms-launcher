import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseIni, serializeIni, getValue, readGameOptions, applyGameOptions, explicitGameOptions, validateChanges, DEFAULT_VALUES, GAME_OPTIONS } from '../src/game-options.mjs';
import { readGameConfig, writeGameConfig, runningGameNames, gameRunning } from '../src/game-config.mjs';

// A real player's config.ini (CRLF), plus things a player might add by hand.
const REAL = [
  '[general]', 'resolution=5', '',
  '[discord]', 'enableactivitystatus=true', '',
  '[clienthax]', 'nobulb=true', 'customcolor=true', 'moveattack=true', 'ChairOpacity=255', 'SkillOpacity=255', '',
  '[config]', 'host=203.0.113.7', 'port=8484', '',
  '[debug]', 'attackdiag=1', '',
].join('\r\n');

async function folder(t, contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'slumsms-options-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (contents !== undefined) await writeFile(path.join(dir, 'config.ini'), contents);
  return dir;
}

const lines = (text) => text.split(/\r\n|\n/u);

test('parse and serialize give back the exact text: CRLF, LF, CR, BOM, comments, no final newline, unknown sections', () => {
  const samples = [
    REAL,
    REAL.replaceAll('\r\n', '\n'),
    'ï»¿; made by hand\r\n[clienthax]\r\nNoBulb = TRUE ; keep\r\n\r\n[mystery]\r\nfoo:bar\r\n# hash comment\r\n  indented continuation\r\nlast=1',
    'a=1\rb=2\r',
    '',
    '\r\n\r\n',
    '[config]\nhost=café.example\nport=8484', // a latin1 byte survives as one character
  ];
  for (const text of samples) assert.equal(serializeIni(parseIni(text)), text);
});

test('reading follows the client: case-insensitive names, inline comments, defaults when absent or unreadable', () => {
  const { values } = readGameOptions('[ClientHax]\r\nNoBulb = off ; I like the bulb\r\njumpshoot=maybe\r\n');
  assert.equal(values.nobulb, false);
  assert.equal(values.jumpshoot, true); // unreadable -> client default
  assert.equal(values.discord, true); // absent -> client default
  assert.equal(values.attackwalk, false);
  // A repeated key joins its values, which no longer parse: the client falls back to its default.
  assert.equal(readGameOptions('[clienthax]\nnobulb=false\nnobulb=false\n').values.nobulb, true);
  assert.equal(readGameOptions('[clienthax]\nnobulb=false\n[clienthax]\nnobulb=false\n').values.nobulb, true);
  assert.deepEqual(readGameOptions('').values, DEFAULT_VALUES);
});

test('a line the client cannot parse is reported (the client then ignores every option)', () => {
  assert.equal(readGameOptions(REAL).parseErrorLine, 0);
  assert.equal(readGameOptions('[clienthax]\r\nnobulb=true\r\njust some words\r\n').parseErrorLine, 3);
  assert.equal(readGameOptions('[clienthax\r\n').parseErrorLine, 1);
});

test('editing touches only the owned keys and keeps everything else byte-for-byte', () => {
  const after = applyGameOptions(REAL, { nobulb: false, discord: false, customcolor: false });
  const before = lines(REAL);
  const now = lines(after);
  assert.equal(now.length, before.length);
  const changed = before.map((line, index) => [line, now[index]]).filter(([a, b]) => a !== b);
  assert.deepEqual(changed, [
    ['enableactivitystatus=true', 'enableactivitystatus=false'],
    ['nobulb=true', 'nobulb=false'],
    ['customcolor=true', 'customcolor=false'],
  ]);
  assert.ok(after.includes('[config]\r\nhost=203.0.113.7\r\nport=8484\r\n'));
  assert.ok(after.includes('[debug]\r\nattackdiag=1\r\n'));
  assert.ok(!/(^|[^\r])\n/u.test(after), 'every line ending stays CRLF');
  // Setting a value that is already there changes nothing.
  assert.equal(applyGameOptions(REAL, { nobulb: true }), REAL);
});

test('the key spelling, spacing and inline comment of an edited line are kept', () => {
  const text = '[ClientHax]\r\nNoBulb = TRUE ; was on\r\n';
  assert.equal(applyGameOptions(text, { nobulb: false }), '[ClientHax]\r\nNoBulb = false ; was on\r\n');
});

test('a missing key joins its section; a missing section is appended with the file\'s line endings', () => {
  const added = applyGameOptions(REAL, { doubletapjump: false, winkey: false });
  assert.ok(added.includes('SkillOpacity=255\r\ndoubletapjump=false\r\nenablewinkey=false\r\n\r\n[config]'), added);
  const noSection = applyGameOptions('[config]\nhost=x\nport=1', { nobulb: false, discord: false });
  assert.equal(noSection, '[config]\nhost=x\nport=1\n\n[clienthax]\nnobulb=false\n\n[discord]\nenableactivitystatus=false\n');
  assert.equal(readGameOptions(noSection).values.nobulb, false);
});

test('repeats and continuation lines of an edited key are removed so the new value parses', () => {
  const text = '[clienthax]\nnobulb=false\ncustomcolor=true\nnobulb=false\n';
  const after = applyGameOptions(text, { nobulb: false });
  assert.equal(after, '[clienthax]\nnobulb=false\ncustomcolor=true\n');
  assert.equal(readGameOptions(after).values.nobulb, false);
});

test('legacy moveattack: slide off by default, jump and charge follow it; new keys win; moveattack is never written', () => {
  const legacyOff = '[clienthax]\r\nmoveattack=false\r\n';
  assert.deepEqual(pick(readGameOptions(legacyOff).values), { attackwalk: false, attackjump: false, chargemove: false });
  assert.equal(readGameOptions(legacyOff).legacyMoveAttack, false);
  const legacyOn = '[clienthax]\r\nmoveattack=true\r\n';
  assert.deepEqual(pick(readGameOptions(legacyOn).values), { attackwalk: false, attackjump: true, chargemove: true });
  assert.deepEqual(pick(readGameOptions('').values), { attackwalk: false, attackjump: true, chargemove: true });
  assert.deepEqual(pick(readGameOptions('[clienthax]\nmoveattack=false\nattackjump=true\nattackwalk=on\n').values), { attackwalk: true, attackjump: true, chargemove: false });
  // Changing one movement key writes all three (the others at their current values) and leaves moveattack in place.
  const after = applyGameOptions(legacyOff, { attackjump: true });
  assert.equal(after, '[clienthax]\r\nmoveattack=false\r\nattackwalk=false\r\nattackjump=true\r\nchargemove=false\r\n');
  assert.deepEqual(pick(readGameOptions(after).values), { attackwalk: false, attackjump: true, chargemove: false });
  // Restore defaults writes every owned key, never moveattack.
  const restored = applyGameOptions(legacyOff, DEFAULT_VALUES);
  assert.equal(restored.match(/moveattack/gu).length, 1);
  assert.deepEqual(readGameOptions(restored).values, DEFAULT_VALUES);
});
const pick = ({ attackwalk, attackjump, chargemove }) => ({ attackwalk, attackjump, chargemove });

test('double-tap jump defaults off and is read and written like the others', () => {
  assert.equal(readGameOptions('').values.doubletapjump, false);
  const after = applyGameOptions(REAL, { doubletapjump: true });
  assert.equal(readGameOptions(after).values.doubletapjump, true);
  assert.ok(!/attackwalk|attackjump|chargemove/u.test(after), 'an unrelated change does not add the movement keys');
  assert.equal(readGameOptions(applyGameOptions(after, { doubletapjump: false })).values.doubletapjump, false);
  const option = GAME_OPTIONS.find((o) => o.id === 'doubletapjump');
  assert.equal(option.description, 'Press jump again in mid-air to use your Ninja Bounce (air only). Off by default.');
  assert.ok(!/Flash Jump/u.test(option.label + option.description));
});

// Every fallback is the client's own default for that key (client line client-1.5.0-fixes3):
// - discord, winkey, nobulb, customcolor, jumpshoot, jumpmagic: mapleroot/ijl15/YourStuff.h doini(),
//   reader.GetBoolean(section, key, "true") (a non-null char* default, so true);
// - attackwalk / attackjump / chargemove: src/attackstop_patch.h ResolveMoveAttackSettings,
//   attackWalk.value_or(false), attackJump/chargeMove.value_or(legacy), legacy = moveAttack.value_or(true);
// - doubletapjump: src/bounce.cpp ReadIniBool("clienthax", "doubletapjump", false) (false since client
//   1.5.0), read with GetPrivateProfileStringA;
// - config.example.ini ships the same values.
// Change this table only together with the client.
const CLIENT_DEFAULTS = [
  ['discord', 'discord', 'enableactivitystatus', true, undefined], // YourStuff.h
  ['winkey', 'clienthax', 'enablewinkey', true, undefined],        // YourStuff.h
  ['nobulb', 'clienthax', 'nobulb', true, undefined],              // YourStuff.h
  ['customcolor', 'clienthax', 'customcolor', true, undefined],    // YourStuff.h
  ['attackwalk', 'clienthax', 'attackwalk', false, undefined],     // attackstop_patch.h
  ['attackjump', 'clienthax', 'attackjump', true, undefined],      // attackstop_patch.h (moveattack default true)
  ['chargemove', 'clienthax', 'chargemove', true, undefined],      // attackstop_patch.h (moveattack default true)
  ['doubletapjump', 'clienthax', 'doubletapjump', false, 'profile'], // bounce.cpp
  ['jumpshoot', 'clienthax', 'jumpshoot', true, undefined],        // YourStuff.h
  ['jumpmagic', 'clienthax', 'jumpmagic', true, undefined],        // YourStuff.h
];

test('every fallback matches the client default', async () => {
  const page = await import('../tauri/ui/game-options.mjs');
  for (const table of [GAME_OPTIONS, page.GAME_OPTIONS]) {
    assert.equal(table.length, CLIENT_DEFAULTS.length);
    for (const [id, section, key, fallback, reader] of CLIENT_DEFAULTS) {
      const option = table.find((o) => o.id === id);
      assert.deepEqual([option.section, option.key, option.fallback, option.reader], [section, key, fallback, reader], id);
      assert.equal(readGameOptions('').values[id], fallback, id);
    }
  }
  // The Tauri page and the Electron main process share one module text.
  assert.equal(await readFile(new URL('../tauri/ui/game-options.mjs', import.meta.url), 'utf8'), await readFile(new URL('../src/game-options.mjs', import.meta.url), 'utf8'));
});

test('double-tap jump is read like GetPrivateProfileString and written without an inline comment', () => {
  assert.equal(readGameOptions('[clienthax]\r\ndoubletapjump=true ; on please\r\n').values.doubletapjump, false);
  assert.equal(readGameOptions('[clienthax]\ndoubletapjump=true\ndoubletapjump=false\n').values.doubletapjump, true);
  assert.equal(readGameOptions('[clienthax]\ndoubletapjump = "on"\n').values.doubletapjump, true);
  assert.equal(readGameOptions('[clienthax]\ndoubletapjump: true\n').values.doubletapjump, false);
  const on = applyGameOptions('[clienthax]\r\ndoubletapjump=false ; off for now\r\nnobulb=true ; keep\r\n', { doubletapjump: true, nobulb: false });
  assert.equal(on, '[clienthax]\r\ndoubletapjump=true\r\nnobulb=false ; keep\r\n');
  assert.equal(applyGameOptions('[clienthax]\ndoubletapjump: false ; x\n', { doubletapjump: true }), '[clienthax]\ndoubletapjump=true\n');
  assert.equal(applyGameOptions('[clienthax]\ndoubletapjump: x\ndoubletapjump=off\n', { doubletapjump: true }), '[clienthax]\ndoubletapjump=true\n');
});

test('every option is written explicitly with what the panel shows', () => {
  const shown = readGameOptions(REAL).values;
  const after = explicitGameOptions(REAL);
  assert.deepEqual(readGameOptions(after).values, shown);
  const ini = parseIni(after);
  for (const option of GAME_OPTIONS) assert.notEqual(getValue(ini, option.section, option.key), undefined, option.id);
  assert.ok(!after.includes('doubletapjump=true'));
  // Every original line survives, in order; only new lines were added.
  const old = REAL.split('\r\n');
  let next = 0;
  for (const line of after.split('\r\n')) if (line === old[next]) next += 1;
  assert.equal(next, old.length);
  assert.ok(after.includes('[config]\r\nhost=203.0.113.7\r\nport=8484\r\n'));
  assert.ok(after.includes('[debug]\r\nattackdiag=1\r\n'));
  assert.equal(after.match(/moveattack/gu).length, 1);
  assert.ok(!/[^\r]\n/u.test(after), 'CRLF kept');
  assert.equal(explicitGameOptions(after), after);
  assert.ok(explicitGameOptions('[clienthax]\r\nNoBulb = yes ; mine\r\n').startsWith('[clienthax]\r\nNoBulb = yes ; mine\r\n'));
  const junk = explicitGameOptions('[clienthax]\nnobulb=maybe\njumpshoot=false\n', { discord: false });
  assert.deepEqual([junk.includes('nobulb=true\n'), readGameOptions(junk).values.jumpshoot, readGameOptions(junk).values.discord], [true, false, false]);
  assert.deepEqual(pick(readGameOptions(explicitGameOptions('[clienthax]\nmoveattack=false\n')).values), { attackwalk: false, attackjump: false, chargemove: false });
  assert.throws(() => explicitGameOptions(REAL, { host: true }), /Unknown game option/);
});

test('only known options with on/off values are accepted', () => {
  assert.throws(() => validateChanges({ host: true }), /Unknown game option/);
  assert.throws(() => validateChanges({ nobulb: 'false' }), /on or off/);
  assert.throws(() => applyGameOptions(REAL, { attackdiag: true }), /Unknown game option/);
  assert.deepEqual(validateChanges({ nobulb: false }), { nobulb: false });
  assert.ok(GAME_OPTIONS.every((option) => option.section !== 'config' && option.section !== 'debug' && option.key !== 'moveattack'));
});

test('a missing config.ini is reported and never created', async (t) => {
  const dir = await folder(t);
  assert.deepEqual(await readGameConfig(dir), { status: 'missing' });
  await assert.rejects(writeGameConfig(dir, { nobulb: false }), (error) => error.code === 'CONFIG_MISSING');
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(await readGameConfig(''), { status: 'missing' });
});

test('writing refuses while the game runs and leaves the file alone', async (t) => {
  const dir = await folder(t, REAL);
  await assert.rejects(writeGameConfig(dir, { nobulb: false }, { isGameRunning: async () => true }),
    (error) => error.code === 'GAME_RUNNING' && /Close SlumsMS/.test(error.message));
  assert.equal(await readFile(path.join(dir, 'config.ini'), 'latin1'), REAL);
});

test('the file is replaced atomically, other bytes survive, and no temporary file is left', async (t) => {
  const original = Buffer.concat([Buffer.from('[general]\r\nname='), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('\r\n'), Buffer.from(REAL)]);
  const dir = await folder(t, original);
  const result = await writeGameConfig(dir, { nobulb: false, attackwalk: true });
  assert.equal(result.values.nobulb, false);
  assert.equal(result.values.attackwalk, true);
  const written = await readFile(path.join(dir, 'config.ini'));
  assert.deepEqual(written.subarray(0, 20), original.subarray(0, 20)); // the non-UTF-8 bytes are untouched
  assert.equal(written.toString('latin1'), applyGameOptions(original.toString('latin1'), { nobulb: false, attackwalk: true }));
  assert.deepEqual(await readdir(dir), ['config.ini']);
  assert.deepEqual((await readGameConfig(dir)).values, result.values);
});

test('the game process is found in tasklist and ps output, by name and case-insensitively', async () => {
  const tasklist = '"System Idle Process","0","Services","0","8 K"\r\n"MAPLESTORY.EXE","4321","Console","1","812,000 K"\r\n"electron.exe","77","Console","1","1 K"\r\n';
  assert.deepEqual(runningGameNames(tasklist), ['MapleStory.exe']);
  assert.deepEqual(runningGameNames('init\nbash\n/opt/wine/SlumsMS.exe\n'), ['SlumsMS.exe']);
  assert.deepEqual(runningGameNames('"SlumsMS Launcher.exe","1"\r\n'), []);
  const fake = (output, error = null) => (command, args, options, callback) => callback(error, output);
  assert.equal(await gameRunning({ platform: 'win32', run: fake(tasklist) }), true);
  assert.equal(await gameRunning({ platform: 'win32', run: fake('') }), false);
  assert.equal(await gameRunning({ platform: 'win32', run: fake('', new Error('no tasklist')) }), false);
});
