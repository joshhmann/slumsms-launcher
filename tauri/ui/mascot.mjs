// Which Slums-chan picture (a cut-out, or one with a speech bubble) fronts the banner. Like the site's home page (theme.js), the launcher starts on the heart
// (the owner's favourite) and cross-fades to the next every 7 s in the site's order, paused while the window is hidden
// or minimized; with reduced motion it picks one at random and keeps it for the launch. style.css does the fade and
// shows the heart when nothing is set (no JS).
export const MASCOTS = ['heart', 'peace-wink', 'peace', 'chin-hands', 'crossed', 'point-wink', 'point', 'cozy'];
export const ROTATE_MS = 7000;

export function pickMascot(random = Math.random) {
  return MASCOTS[Math.min(MASCOTS.length - 1, Math.floor(random() * MASCOTS.length))];
}

/** The picture after `current`, wrapping around; an unknown one starts over at the first. */
export function nextMascot(current) {
  return MASCOTS[(MASCOTS.indexOf(current) + 1) % MASCOTS.length];
}

/** Set body[data-mascot] and rotate it while the page is visible. Returns a function that stops the rotation. */
export function startRotation({ doc = document, win = window, random = Math.random } = {}) {
  const body = doc.body;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    body.dataset.mascot = pickMascot(random);
    return () => {};
  }
  body.dataset.mascot = MASCOTS[0];
  let timer = null;
  const tick = () => { body.dataset.mascot = nextMascot(body.dataset.mascot); };
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
