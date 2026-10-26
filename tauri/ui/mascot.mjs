// Which mascot fronts the banner this launch: the girl (with the bucket blob peeking over STATUS) or the bucket blob
// on its own. Picked at random each time the launcher opens; style.css shows the girl when nothing is set.
export const MASCOTS = ['girl', 'bucket'];

export function pickMascot(random = Math.random) {
  return MASCOTS[Math.min(MASCOTS.length - 1, Math.floor(random() * MASCOTS.length))];
}

if (typeof document !== 'undefined') {
  document.body.dataset.mascot = pickMascot();
}
