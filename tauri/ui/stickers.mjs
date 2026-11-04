// The little Slums-chan by the STATUS heading (the owner's chibi stickers, 2026-11-04; the same art as the website's
// page buddy). She shows what the launcher is doing: a magnifier while it checks, a laptop while it downloads, a cheer
// when the game is ready, a facepalm when something went wrong. On a holiday (the computer's own clock) she wears that
// day's sticker instead, except on an error. The holiday rules match the website's theme.js. None with slimes or
// robots (owner). Pure functions first, so test/tauri-ui.test.mjs checks them without a page.

export const STATUS_STICKERS = {
  idle: ['cool', 'Little Slums-chan in pixel sunglasses'],
  checking: ['magnifier', 'Little Slums-chan looks through a magnifying glass'],
  ready: ['cheer', 'Little Slums-chan cheers with a fist in the air'],
  'needs-update': ['check', 'Little Slums-chan holds a checklist'],
  updating: ['laptop', 'Little Slums-chan types on a laptop'],
  'self-updating': ['wrench', 'Little Slums-chan in a hard hat with a wrench'],
  launching: ['gamer', 'Little Slums-chan plays in cat-ear headphones'],
  error: ['facepalm', 'Little Slums-chan facepalms'],
};

const LUNAR = { 2027: [2, 6], 2028: [1, 26], 2029: [2, 13], 2030: [2, 3] };          // Lunar New Year
const MOON = { 2026: [9, 25], 2027: [9, 15], 2028: [10, 3], 2029: [9, 22], 2030: [9, 12] };   // Moon Festival

/** The nth weekday (0 = Sunday) of a month, as a day of the month. */
function nth(year, month, weekday, n) {
  const first = new Date(year, month - 1, 1).getDay();
  return 1 + (weekday - first + 7) % 7 + 7 * (n - 1);
}

/** Easter Sunday (Gregorian, the anonymous algorithm) as [month, day]. */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, e = Math.floor(b / 4), f = b % 4, g = Math.floor((b + 8) / 25);
  const h = (19 * a + b - e - Math.floor((b - g + 1) / 3) + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * f + 2 * i - h - k) % 7, n = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * n + 114) / 31), (h + l - 7 * n + 114) % 31 + 1];
}

/** The holiday for a date: { id, line, alt } or null. The first rule that matches wins, so a single day beats a
 *  longer stretch around it. */
export function holidayFor(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const on = (md) => Boolean(md) && md[0] === m && md[1] === d;
  const between = (m1, d1, m2, d2) => { const t = m * 100 + d; return t >= m1 * 100 + d1 && t <= m2 * 100 + d2; };
  const days = [
    ['aprilfools', on([4, 1]), 'Nothing I say today is true. Probably.', 'Little Slums-chan with a fake moustache for April Fools’'],
    ['valentine', on([2, 14]), 'Happy Valentine’s Day!', 'Little Slums-chan hugs a heart-shaped box'],
    ['whiteday', on([3, 14]), 'Happy White Day!', 'Little Slums-chan holds a blue heart box'],
    ['stpatricks', on([3, 17]), 'Happy St. Patrick’s Day!', 'Little Slums-chan in a green hat'],
    ['setsubun', on([2, 3]), 'Happy Setsubun! Beans out, luck in.', 'Little Slums-chan with an oni mask and beans'],
    ['lunarnewyear', on(LUNAR[y]), 'Happy Lunar New Year!', 'Little Slums-chan holds a red envelope'],
    ['easter', on(easter(y)), 'Happy Easter!', 'Little Slums-chan in bunny ears'],
    ['earthday', on([4, 22]), 'Happy Earth Day!', 'Little Slums-chan hugs a little globe'],
    ['mothersday', m === 5 && d === nth(y, 5, 0, 2), 'Happy Mother’s Day!', 'Little Slums-chan holds carnations'],
    ['fathersday', m === 6 && d === nth(y, 6, 0, 3), 'Happy Father’s Day!', 'Little Slums-chan holds a wrench'],
    ['summer', on([6, 21]), 'First day of summer!', 'Little Slums-chan with sunglasses and a watermelon ice pop'],
    ['july4', on([7, 4]), 'Happy Fourth of July!', 'Little Slums-chan with fireworks'],
    ['tanabata', on([7, 7]), 'Happy Tanabata! Make a wish.', 'Little Slums-chan with a bamboo branch of wishes'],
    ['obon', between(8, 13, 8, 15), 'Happy Obon!', 'Little Slums-chan holds a paper lantern'],
    ['moonfestival', on(MOON[y]), 'Happy Moon Festival!', 'Little Slums-chan with a mooncake and a moon bunny'],
    ['halloween', between(10, 24, 10, 31), 'Happy Halloween! Trick or treat?', 'Little Slums-chan in a witch hat with a jack-o’-lantern'],
    ['thanksgiving', m === 11 && d === nth(y, 11, 4, 4), 'Happy Thanksgiving!', 'Little Slums-chan serves a roast turkey'],
    ['winter', on([12, 21]), 'First day of winter. Bundle up!', 'Little Slums-chan wrapped in a scarf'],
    ['christmas', between(12, 24, 12, 25), 'Merry Christmas!', 'Little Slums-chan in a Santa hat with a present'],
    ['newyear', between(1, 1, 1, 3) || on([12, 31]), 'Happy New Year!', 'Little Slums-chan holds up a New Year sign'],
    ['school', between(9, 1, 9, 7), 'Back to school! Or back to grinding.', 'Little Slums-chan with a stack of books'],
    ['oktoberfest', between(9, 26, 10, 3), 'Prost! Happy Oktoberfest!', 'Little Slums-chan raises a beer stein'],
    ['hanami', between(3, 25, 4, 10), 'Cherry blossom season!', 'Little Slums-chan among cherry blossoms'],
  ];
  const hit = days.find((day) => day[1]);
  return hit ? { id: hit[0], line: hit[2], alt: hit[3] } : null;
}

/** The sticker for a phase on a date: { src, alt, line } (line is the holiday greeting, or ''). */
export function stickerFor(phase, date = new Date()) {
  const holiday = phase === 'error' ? null : holidayFor(date);
  if (holiday) return { src: `./assets/stickers/holiday-${holiday.id}-360.webp`, alt: holiday.alt, line: holiday.line };
  const [name, alt] = STATUS_STICKERS[phase] ?? STATUS_STICKERS.idle;
  return { src: `./assets/stickers/chibi-${name}-360.webp`, alt, line: '' };
}

/** Follow #phase-badge[data-phase] (renderer.mjs sets it) and keep the sticker and its greeting in step. */
export function startStickers({ doc = document, now = () => new Date() } = {}) {
  const badge = doc.getElementById('phase-badge');
  const img = doc.getElementById('status-sticker');
  const note = doc.getElementById('sticker-note');
  if (!badge || !img) return () => {};
  const sync = () => {
    const s = stickerFor(badge.dataset.phase || 'idle', now());
    if (img.getAttribute('src') !== s.src) img.setAttribute('src', s.src);
    img.alt = s.alt;
    if (note) { note.textContent = s.line; note.hidden = !s.line; }
  };
  sync();
  const watch = new doc.defaultView.MutationObserver(sync);
  watch.observe(badge, { attributes: true, attributeFilter: ['data-phase'] });
  return () => watch.disconnect();
}

if (typeof document !== 'undefined') startStickers();
