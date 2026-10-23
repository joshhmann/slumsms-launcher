import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake2b512 } from '../src/blake2b.mjs';
import { verifyTauriSignature } from '../src/handover.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'handover');
const hex = (value) => blake2b512(Buffer.from(value)).toString('hex');

test('BLAKE2b-512 matches the published test vectors', () => {
  // RFC 7693 Appendix A.
  assert.equal(hex('abc'), 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
  // Unkeyed BLAKE2b-512 of the empty string (reference implementation).
  assert.equal(hex(''), '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce');
  assert.equal(hex('The quick brown fox jumps over the lazy dog'), 'a8add4bdddfd93e4877d2746e62817b116364a1fa7bc148d95090bc7333b3673f82401cf7aa2e4cb1ecd90296e3f14cb5413f8ed77be73045b13914cdcd6a918');
});

test('BLAKE2b-512 agrees with OpenSSL across block boundaries', () => {
  for (const length of [1, 63, 64, 111, 112, 127, 128, 129, 255, 256, 257, 1000, 65_536, 1_000_003]) {
    const bytes = crypto.randomBytes(length);
    assert.equal(blake2b512(bytes).toString('hex'), crypto.createHash('blake2b512').update(bytes).digest('hex'), `length ${length}`);
  }
});

test('the verifier works where crypto has no blake2b (Electron/BoringSSL)', async (t) => {
  const original = crypto.createHash;
  t.mock.method(crypto, 'createHash', (name, ...rest) => {
    if (/blake2b/iu.test(name)) throw new Error('Digest method not supported');
    return original(name, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  assert.throws(() => crypto.createHash('blake2b512'), /Digest method not supported/);
  const bytes = await readFile(path.join(fixtures, 'fake-launcher.exe'));
  const signature = (await readFile(path.join(fixtures, 'fake-launcher.exe.sig'), 'utf8')).trim();
  const key = (await readFile(path.join(fixtures, 'test.key.pub'), 'utf8')).trim();
  assert.equal(verifyTauriSignature(bytes, signature, key, '1.5.0'), true);
  const flipped = Buffer.from(bytes);
  flipped[0] ^= 1;
  assert.throws(() => verifyTauriSignature(flipped, signature, key, '1.5.0'), /does not match/);
});
