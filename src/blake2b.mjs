/**
 * BLAKE2b-512 (RFC 7693), unkeyed, in plain JavaScript. Electron's crypto is BoringSSL, which has
 * no blake2b ("Digest method not supported"), and minisign's prehashed "ED" signatures need it.
 * 64-bit words are kept as (low, high) 32-bit pairs in a Uint32Array.
 */

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// v and m hold word i at [2i] (low) and [2i + 1] (high).
const v = new Uint32Array(32);
const m = new Uint32Array(32);

function add(a, b) { // v[a] += v[b]
  const lo = v[a] + v[b];
  v[a + 1] = (v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0)) >>> 0;
  v[a] = lo >>> 0;
}
function addM(a, i) { // v[a] += m[i]
  const lo = v[a] + m[i];
  v[a + 1] = (v[a + 1] + m[i + 1] + (lo >= 0x100000000 ? 1 : 0)) >>> 0;
  v[a] = lo >>> 0;
}
function xorRot(d, s, r) { // v[d] = rotr64(v[d] ^ v[s], r), r in {32, 24, 16, 63}
  const lo = v[d] ^ v[s];
  const hi = v[d + 1] ^ v[s + 1];
  if (r === 32) { v[d] = hi; v[d + 1] = lo; return; }
  if (r === 63) { // rotr 63 = rotl 1
    v[d] = ((lo << 1) | (hi >>> 31)) >>> 0;
    v[d + 1] = ((hi << 1) | (lo >>> 31)) >>> 0;
    return;
  }
  v[d] = ((lo >>> r) | (hi << (32 - r))) >>> 0;
  v[d + 1] = ((hi >>> r) | (lo << (32 - r))) >>> 0;
}
function G(a, b, c, d, x, y) {
  add(a, b); addM(a, x); xorRot(d, a, 32);
  add(c, d); xorRot(b, c, 24);
  add(a, b); addM(a, y); xorRot(d, a, 16);
  add(c, d); xorRot(b, c, 63);
}

function compress(h, block, offset, countLo, countHi, last) {
  // Words 0..7 = state, 8..15 = IV with the byte counter (word 12) and final flag (word 14) mixed in.
  for (let i = 0; i < 16; i += 1) { v[i] = h[i]; v[16 + i] = IV[i]; }
  for (let i = 0; i < 32; i += 1) {
    const at = offset + 4 * i;
    m[i] = (block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) | (block[at + 3] << 24)) >>> 0;
  }
  v[24] ^= countLo; v[25] ^= countHi;
  if (last) { v[28] = ~v[28] >>> 0; v[29] = ~v[29] >>> 0; }
  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10];
    G(0, 8, 16, 24, 2 * s[0], 2 * s[1]);
    G(2, 10, 18, 26, 2 * s[2], 2 * s[3]);
    G(4, 12, 20, 28, 2 * s[4], 2 * s[5]);
    G(6, 14, 22, 30, 2 * s[6], 2 * s[7]);
    G(0, 10, 20, 30, 2 * s[8], 2 * s[9]);
    G(2, 12, 22, 24, 2 * s[10], 2 * s[11]);
    G(4, 14, 16, 26, 2 * s[12], 2 * s[13]);
    G(6, 8, 18, 28, 2 * s[14], 2 * s[15]);
  }
  for (let i = 0; i < 16; i += 1) h[i] = (h[i] ^ v[i] ^ v[i + 16]) >>> 0;
}

/** BLAKE2b-512 of `input` (Buffer/Uint8Array); returns a 64-byte Buffer. */
export function blake2b512(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010000 ^ 64; // parameter block: digest length 64, no key, fanout 1, depth 1
  const block = new Uint8Array(128);
  let count = 0;
  let offset = 0;
  // Every full block except the very last one is compressed with last = false.
  while (data.length - offset > 128) {
    count += 128;
    compress(h, data, offset, count >>> 0, Math.floor(count / 0x100000000) >>> 0, false);
    offset += 128;
  }
  block.set(data.subarray(offset));
  count += data.length - offset;
  compress(h, block, 0, count >>> 0, Math.floor(count / 0x100000000) >>> 0, true);
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i += 1) out.writeUInt32LE(h[i], 4 * i);
  return out;
}
