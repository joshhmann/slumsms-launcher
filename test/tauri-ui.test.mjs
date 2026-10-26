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

test('reduced motion can land on any of the eight pictures', async () => {
  const { pickMascot, MASCOTS } = await import('../tauri/ui/mascot.mjs');
  // the site's home order, heart first
  assert.deepEqual(MASCOTS, ['heart', 'peace-wink', 'peace', 'chin-hands', 'crossed', 'point-wink', 'point', 'cozy']);
  assert.equal(pickMascot(() => 0), 'heart');
  assert.equal(pickMascot(() => 0.124), 'heart');
  assert.equal(pickMascot(() => 0.125), 'peace-wink');
  assert.equal(pickMascot(() => 0.5), 'crossed');
  assert.equal(pickMascot(() => 0.875), 'cozy');
  assert.equal(pickMascot(() => 1), 'cozy');   // a random() that returns 1 still gives a valid picture
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

test('the banner starts on the heart and cross-fades through the pictures in order every 7 s, wrapping around', async () => {
  const { startRotation, nextMascot, ROTATE_MS } = await import('../tauri/ui/mascot.mjs');
  assert.equal(ROTATE_MS, 7000);
  assert.equal(nextMascot('cozy'), 'heart');
  assert.equal(nextMascot('unknown'), 'heart');
  const page = fakePage();
  const stop = startRotation({ doc: page.doc, win: page.win, random: () => 0.9 });   // random is for reduced motion only
  assert.equal(page.doc.body.dataset.mascot, 'heart');
  assert.deepEqual([...page.timers.values()].map((timer) => timer.ms), [7000]);
  const seen = [];
  for (let i = 0; i < 8; i += 1) { page.fire(); seen.push(page.doc.body.dataset.mascot); }
  assert.deepEqual(seen, ['peace-wink', 'peace', 'chin-hands', 'crossed', 'point-wink', 'point', 'cozy', 'heart']);
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
  startRotation({ doc: page.doc, win: page.win, random: () => 0.4 });
  assert.equal(page.doc.body.dataset.mascot, 'chin-hands');
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.size, 0);
});
