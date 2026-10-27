import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountRow, codeTimeLeft, formProblem } from '../tauri/ui/account.mjs';

test('the STATUS strip says who is signed in, with the alert count and the TEST site marked', () => {
  assert.deepEqual(accountRow({ status: 'signed-in', site: 'Live', character: 'Momo', alerts: 2 }),
    { label: 'signed in as', value: 'Momo', alerts: '2 new price alerts', action: 'Sign out', note: '' });
  assert.equal(accountRow({ status: 'signed-in', site: 'Live', character: 'Momo', alerts: 1 }).alerts, '1 new price alert');
  assert.equal(accountRow({ status: 'signed-in', site: 'Live', character: 'Momo', alerts: 0 }).alerts, '');
  assert.equal(accountRow({ status: 'signed-in', site: 'TEST', character: 'Momo' }).value, 'Momo (TEST site)');
  assert.equal(accountRow({ status: 'signed-in', site: 'Live', character: 'Momo', offline: true }).note, 'website not reachable');
  assert.equal(accountRow({ status: 'signed-in', site: 'Live', character: '' }).value, 'your account');
});

test('signed out offers Sign in and passes on why; a running code offers Cancel', () => {
  assert.deepEqual(accountRow({ status: 'signed-out', site: 'Live', note: 'The website signed you out. Sign in again.' }),
    { label: 'website', value: 'not signed in', alerts: '', action: 'Sign in', note: 'The website signed you out. Sign in again.' });
  const waiting = accountRow({ status: 'code', site: 'Live', code: 'K7Q4ZP', expiresAt: 0 });
  assert.equal(waiting.value, 'waiting for @weblogin K7Q4ZP');
  assert.equal(waiting.action, 'Cancel');
  assert.equal(accountRow(null).action, '', 'nothing to press before the launcher has said');
});

test('a code counts down in minutes and seconds and stops at zero', () => {
  assert.equal(codeTimeLeft(600_000, 0), '10:00 left');
  assert.equal(codeTimeLeft(61_500, 0), '1:02 left');
  assert.equal(codeTimeLeft(0, 5000), '0:00 left');
});

test('the forms only stop empty fields; the game server judges the rest', () => {
  assert.equal(formProblem('password', { user: '', pass: 'x' }), 'Enter your username.');
  assert.equal(formProblem('password', { user: 'momo', pass: '' }), 'Enter your password.');
  assert.equal(formProblem('password', { user: 'momo', pass: 'x' }), '');
  assert.equal(formProblem('signup', { code: ' ', user: 'momo', pass: 'x' }), 'Enter your invite code.');
  assert.equal(formProblem('signup', { code: 'AB12', user: 'momo', pass: 'x' }), '');
});

test('every bridge command the page can call is registered in the Tauri app', () => {
  const bridge = readFileSync(new URL('../tauri/ui/bridge.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../tauri/app/src/main.rs', import.meta.url), 'utf8');
  const commands = [...bridge.matchAll(/\w+: '(\w+)'/gu)].map((m) => m[1]);
  assert.ok(commands.includes('account_sign_in') && commands.includes('open_market'));
  const registered = new Set([...main.matchAll(/launcher::(?:account::)?(\w+),/gu)].map((m) => m[1]));
  for (const command of commands) assert.ok(registered.has(command), `${command} is not in generate_handler!`);
});

test('the sign-in dialog never asks the browser to remember a password', () => {
  const html = readFileSync(new URL('../tauri/ui/index.html', import.meta.url), 'utf8');
  const form = html.slice(html.indexOf('id="account-form"'), html.indexOf('</form>', html.indexOf('id="account-form"')));
  assert.match(html, /<form class="account-form" id="account-form" autocomplete="off">/u);
  assert.equal((form.match(/type="password"/gu) ?? []).length, 1);
});
