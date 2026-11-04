// Little Slums-chan runs along the progress bar (owner, 2026-11-04: "use our images that look like sprites to have
// slums chan run along the progress bar"). The frames are cut from the owner's pixel sheet (2026-10-27): her side walk
// and a second side pose, flipped to face right, swap every 0.16 s in style.css (no timers here), plus the front idle
// pose once the bar is full. This module only follows the bar: renderer.mjs sets <progress value>, which the
// browser mirrors into the attribute, and a value-less (indeterminate) bar has her pace back and forth instead.
// With reduced motion she doesn't swap frames or pace; she just stands at the bar's end of the work done.

/** Where she stands for a <progress>'s value and max attributes: { at: 0..1, mode: 'run' | 'done' | 'pace' }. */
export function runnerFor(value, max) {
  const v = Number.parseFloat(value), m = Number.parseFloat(max ?? '1');
  if (value === null || value === undefined || value === '' || !Number.isFinite(v) || !(m > 0)) return { at: 0, mode: 'pace' };
  const at = Math.min(Math.max(v / m, 0), 1);
  return { at, mode: at >= 1 ? 'done' : 'run' };
}

/** Keep #progress-runner on the bar: sets --at (0..1) and data-mode on its track. Returns a stop function. */
export function startRunner({ doc = document } = {}) {
  const bar = doc.getElementById('operation-progress');
  const track = bar?.closest('.track');
  if (!bar || !track) return () => {};
  const sync = () => {
    const r = runnerFor(bar.getAttribute('value'), bar.getAttribute('max'));
    track.style.setProperty('--at', String(r.at));
    track.dataset.mode = r.mode;
  };
  sync();
  const watch = new doc.defaultView.MutationObserver(sync);
  watch.observe(bar, { attributes: true, attributeFilter: ['value', 'max'] });
  return () => watch.disconnect();
}

if (typeof document !== 'undefined') startRunner();
