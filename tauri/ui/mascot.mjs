// Which picture fronts the banner: the girl (with the bucket blob peeking over STATUS), the bucket blob on its own, or
// one of the two "Bustin' chat since 2009!" illustrations (chat, chat-smug). Like the site, the launcher starts on a
// random one and cross-fades to the next every 7 s, paused while the window is hidden or minimized; with reduced
// motion it keeps one picture per launch. style.css does the fade and shows the girl when nothing is set (no JS).
export const MASCOTS = ['girl', 'bucket', 'chat', 'chat-smug'];
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
  body.dataset.mascot = pickMascot(random);
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
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
