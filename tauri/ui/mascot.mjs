// Which mascot fronts the banner this launch: the girl (with the bucket blob peeking over STATUS), the bucket blob
// on its own, or the "Bustin' chat since 2009!" illustration. Picked at random each time the launcher opens; style.css shows the girl when nothing is set.
export const MASCOTS = ['girl', 'bucket', 'chat'];

export function pickMascot(random = Math.random) {
  return MASCOTS[Math.min(MASCOTS.length - 1, Math.floor(random() * MASCOTS.length))];
}

if (typeof document !== 'undefined') {
  document.body.dataset.mascot = pickMascot();
}
