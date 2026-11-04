import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHelp } from '../tauri/ui/version-status.mjs';

const base = { bridgeAvailable: true, initialized: true, phase: 'ready', busy: false, feedUrl: 'https://example.test/manifest.json', actionKind: 'play', canPlay: true, offlinePlay: false, resuming: false, fresh: false, accessKeyNeeded: false };

test('a ready, verified client gets no help line repeating "verified"', () => {
  assert.equal(actionHelp(base), '');
});

test('the help line still explains every other state', () => {
  assert.match(actionHelp({ ...base, actionKind: 'update' }), /new release is out/);
  assert.match(actionHelp({ ...base, offlinePlay: true }), /Couldn’t check for updates/);
  assert.match(actionHelp({ ...base, phase: 'needs-update', canPlay: false, fresh: true }), /Install downloads the game/);
  assert.match(actionHelp({ ...base, phase: 'needs-update', canPlay: false }), /only the files that changed/);
  assert.match(actionHelp({ ...base, phase: 'error', canPlay: false, accessKeyNeeded: true }), /access key/);
  assert.match(actionHelp({ ...base, busy: true }), /Keep the launcher open/);
  assert.match(actionHelp({ ...base, feedUrl: '' }), /Set the update server/);
  assert.equal(actionHelp({ ...base, initialized: false }), 'Starting…');
});

test('reduced motion can land on any picture of the month, and the retired cut-outs are gone', async () => {
  const { pickMascot, mascotsFor, BASE_MASCOTS } = await import('../tauri/ui/mascot.mjs');
  // the site's home order, heart first; the cut-outs with slimes were retired (owner, 2026-11-04)
  assert.deepEqual(BASE_MASCOTS, ['heart', 'peace-wink', 'chin-hands', 'point-wink', 'reach-wink', 'chin-heart']);
  assert.deepEqual(mascotsFor(11), [...BASE_MASCOTS, 'season-autumn', 'season-shopping']);
  assert.deepEqual(mascotsFor(7), [...BASE_MASCOTS, 'season-sunflower', 'season-picnic']);
  for (let m = 1; m <= 12; m += 1) assert.ok(mascotsFor(m).length > BASE_MASCOTS.length, `month ${m} has a season picture`);
  const nov = mascotsFor(11);
  assert.equal(pickMascot(() => 0, nov), 'heart');
  assert.equal(pickMascot(() => 0.99, nov), 'season-shopping');
  assert.equal(pickMascot(() => 1, nov), 'season-shopping');   // a random() that returns 1 still gives a valid picture
});

test('every picture the rotor can show has an image and a stylesheet rule', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { mascotsFor } = await import('../tauri/ui/mascot.mjs');
  const html = readFileSync(new URL('../tauri/ui/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../tauri/ui/style.css', import.meta.url), 'utf8');
  const all = new Set(); for (let m = 1; m <= 12; m += 1) mascotsFor(m).forEach((name) => all.add(name));
  for (const name of all) {
    assert.match(html, new RegExp(`class="pic-${name}"`), name);
    assert.match(css, new RegExp(`body\\[data-mascot="${name}"\\] \\.pic-${name}`), name);
  }
  for (const src of html.matchAll(/src="\.\/(assets\/[^"]+)"/g)) assert.ok(existsSync(new URL(`../tauri/ui/${src[1]}`, import.meta.url)), src[1]);
  assert.doesNotMatch(html, /cut-(peace|crossed|point|cozy)/);
});

test('the status sticker follows the phase, and holidays win except on an error', async () => {
  const { stickerFor, holidayFor, easter } = await import('../tauri/ui/stickers.mjs');
  const day = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const plain = day('2026-11-04');
  assert.equal(stickerFor('ready', plain).src, './assets/stickers/chibi-cheer-360.webp');
  assert.equal(stickerFor('updating', plain).src, './assets/stickers/chibi-laptop-360.webp');
  assert.equal(stickerFor('checking', plain).src, './assets/stickers/chibi-magnifier-360.webp');
  assert.equal(stickerFor('error', plain).src, './assets/stickers/chibi-facepalm-360.webp');
  assert.equal(stickerFor('something-new', plain).src, './assets/stickers/chibi-cool-360.webp');
  assert.equal(stickerFor('ready', plain).line, '');
  assert.equal(stickerFor('ready', day('2026-10-31')).src, './assets/stickers/holiday-halloween-360.webp');
  assert.equal(stickerFor('ready', day('2026-10-31')).line, 'Happy Halloween! Trick or treat?');
  assert.equal(stickerFor('error', day('2026-10-31')).src, './assets/stickers/chibi-facepalm-360.webp');
  assert.deepEqual(easter(2027), [3, 28]);
  assert.deepEqual(easter(2028), [4, 16]);
  const want = { '2026-11-26': 'thanksgiving', '2026-11-25': null, '2027-03-28': 'easter', '2027-05-09': 'mothersday',
    '2027-06-20': 'fathersday', '2027-04-01': 'aprilfools', '2027-04-02': 'hanami', '2027-02-06': 'lunarnewyear',
    '2026-12-25': 'christmas', '2027-01-02': 'newyear' };
  for (const [d, id] of Object.entries(want)) assert.equal(holidayFor(day(d))?.id ?? null, id, d);
});

test('every sticker the launcher can show is in the assets, with none of slimes or robots', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const { STATUS_STICKERS, holidayFor } = await import('../tauri/ui/stickers.mjs');
  const dir = new URL('../tauri/ui/assets/stickers/', import.meta.url);
  for (const [name] of Object.values(STATUS_STICKERS)) assert.ok(existsSync(new URL(`chibi-${name}-360.webp`, dir)), name);
  const seen = new Set();
  for (let t = new Date(2027, 0, 1); t.getFullYear() === 2027; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) {
    const h = holidayFor(t); if (h) seen.add(h.id);
  }
  for (const id of seen) assert.ok(existsSync(new URL(`holiday-${id}-360.webp`, dir)), id);
  assert.equal(seen.size, 23);
  assert.deepEqual(readdirSync(dir).filter((f) => /slime|robot/.test(f)), []);
});

// A fake page for startRotation: a body with a dataset, document.hidden, and timers that only run when told to.
function fakePage({ reducedMotion = false } = {}) {
  const listeners = new Map();
  const timers = new Map();
  let nextId = 1;
  const doc = {
    body: { dataset: {} },
    hidden: false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const win = {
    matchMedia: (query) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' }),
    setInterval: (fn, ms) => { timers.set(nextId, { fn, ms }); return nextId++; },
    clearInterval: (id) => timers.delete(id),
  };
  const fire = () => [...timers.values()].forEach((timer) => timer.fn());
  const setHidden = (hidden) => { doc.hidden = hidden; listeners.get('visibilitychange')?.(); };
  return { doc, win, timers, fire, setHidden, listeners };
}

test('the banner starts on the heart and cross-fades through the month\'s pictures in order every 7 s, wrapping around', async () => {
  const { startRotation, nextMascot, mascotsFor, ROTATE_MS } = await import('../tauri/ui/mascot.mjs');
  assert.equal(ROTATE_MS, 7000);
  const nov = mascotsFor(11);
  assert.equal(nextMascot('reach-wink', nov), 'chin-heart');
  assert.equal(nextMascot('season-shopping', nov), 'heart');
  assert.equal(nextMascot('unknown', nov), 'heart');
  const page = fakePage();
  const stop = startRotation({ doc: page.doc, win: page.win, random: () => 0.9, month: 11 });   // random is for reduced motion only
  assert.equal(page.doc.body.dataset.mascot, 'heart');
  assert.deepEqual([...page.timers.values()].map((timer) => timer.ms), [7000]);
  const seen = [];
  for (let i = 0; i < 8; i += 1) { page.fire(); seen.push(page.doc.body.dataset.mascot); }
  assert.deepEqual(seen, ['peace-wink', 'chin-hands', 'point-wink', 'reach-wink', 'chin-heart', 'season-autumn', 'season-shopping', 'heart']);
  stop();
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.size, 0);
});

test('the rotation pauses while the window is hidden or minimized and resumes when it is back', async () => {
  const { startRotation } = await import('../tauri/ui/mascot.mjs');
  const page = fakePage();
  startRotation({ doc: page.doc, win: page.win, random: () => 0 });
  page.setHidden(true);
  assert.equal(page.timers.size, 0);
  page.fire();
  assert.equal(page.doc.body.dataset.mascot, 'heart');
  page.setHidden(true);   // a second hidden event changes nothing
  page.setHidden(false);
  assert.equal(page.timers.size, 1);
  page.setHidden(false);  // nor does a second visible one: still one timer
  assert.equal(page.timers.size, 1);
  page.fire();
  assert.equal(page.doc.body.dataset.mascot, 'peace-wink');
});

test('with reduced motion the banner keeps one picture per launch', async () => {
  const { startRotation } = await import('../tauri/ui/mascot.mjs');
  const page = fakePage({ reducedMotion: true });
  startRotation({ doc: page.doc, win: page.win, random: () => 0.35, month: 11 });
  assert.equal(page.doc.body.dataset.mascot, 'chin-hands');
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.size, 0);
});
