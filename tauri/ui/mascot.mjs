// Which Slums-chan picture fronts the banner. Like the site's home page (theme.js), the launcher starts on the heart
// (the owner's favourite) and cross-fades to the next every 7 s in the site's order, paused while the window is hidden
// or minimized; with reduced motion it picks one at random and keeps it for the launch. style.css does the fade and
// shows the heart when nothing is set (no JS). The month's season pictures (the owner's season stickers, 2026-11-04)
// join at the end, as on the site; the cut-outs with slimes were retired the same day.
export const BASE_MASCOTS = ['heart', 'peace-wink', 'chin-hands', 'point-wink', 'reach-wink', 'chin-heart'];
export const SEASONS = {
  newyear: [1], cocoa: [12, 1, 2], hearts: [2], blossom: [3, 4], umbrella: [4], reading: [5, 6], sunflower: [6, 7],
  picnic: [7, 8], notepad: [9], autumn: [10, 11], shopping: [11], present: [12],
};
export const ROTATE_MS = 7000;

/** The pictures for a month (1-12): the six every month, then that month's seasons. */
export function mascotsFor(month) {
  return BASE_MASCOTS.concat(Object.keys(SEASONS).filter((name) => SEASONS[name].includes(month)).map((name) => `season-${name}`));
}

export function pickMascot(random = Math.random, list = BASE_MASCOTS) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** The picture after `current`, wrapping around; an unknown one starts over at the first. */
export function nextMascot(current, list = BASE_MASCOTS) {
  return list[(list.indexOf(current) + 1) % list.length];
}

/** Set body[data-mascot] and rotate it while the page is visible. Returns a function that stops the rotation. */
export function startRotation({ doc = document, win = window, random = Math.random, month = new Date().getMonth() + 1 } = {}) {
  const list = mascotsFor(month);
  const body = doc.body;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    body.dataset.mascot = pickMascot(random, list);
    return () => {};
  }
  body.dataset.mascot = list[0];
  let timer = null;
  const tick = () => { body.dataset.mascot = nextMascot(body.dataset.mascot, list); };
  const sync = () => {
    if (doc.hidden && timer !== null) {
      win.clearInterval(timer);
      timer = null;
    } else if (!doc.hidden && timer === null) {
      timer = win.setInterval(tick, ROTATE_MS);
    }
  };
  sync();
  doc.addEventListener('visibilitychange', sync);
  return () => {
    doc.removeEventListener('visibilitychange', sync);
    if (timer !== null) win.clearInterval(timer);
    timer = null;
  };
}

if (typeof document !== 'undefined') {
  startRotation();
}
