import test from 'node:test';
import assert from 'node:assert/strict';
import { playPlan } from '../src/version-status.mjs';


const ok = (sha, version = '1.4.1') => ({ status: 'ok', version, layers: [], manifestSha256: sha });

test('Play updates first when the server offers a release the folder is not', () => {
  const record = { release: '1.4.0', manifestSha256: 'a'.repeat(64) };
  assert.equal(playPlan({ offered: ok('b'.repeat(64)), record }), 'update');
  // A republish under the same version is still a different manifest.
  assert.equal(playPlan({ offered: ok('b'.repeat(64), '1.4.0'), record }), 'update');
  assert.equal(playPlan({ offered: ok('a'.repeat(64), '1.4.0'), record }), 'verify');
  // No record (never verified, or pre-record client): let the update path inspect and fill it.
  assert.equal(playPlan({ offered: ok('a'.repeat(64)), record: null }), 'update');
  assert.equal(playPlan({ offered: ok('a'.repeat(64)), record: { release: '1.4.0', manifestSha256: '' } }), 'update');
});

test('Play starts the installed client when the server cannot be asked', () => {
  const record = { release: '1.4.0', manifestSha256: 'a'.repeat(64) };
  for (const status of ['offline', 'access-key', 'error']) assert.equal(playPlan({ offered: { status, message: 'x' }, record }), 'offline');
  assert.equal(playPlan({ offered: undefined, record }), 'offline');
});

