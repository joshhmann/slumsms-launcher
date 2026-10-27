// "Signed in as" (tickets 104 and 105): one row in the STATUS strip, and a small dialog with three ways to sign in
// to the website: the game username and password, a new account with an invite code, or a code typed in game
// (@weblogin). The launcher's main process talks to the site and keeps the session; the page only ever sees the
// account state ({ status, site, character, alerts, offline, code, expiresAt, note }). Passwords are cleared from
// the form as soon as they are sent.

const MODES = ['password', 'signup', 'code'];

/** What the strip shows for an account state. */
export function accountRow(account) {
  const site = account?.site === 'TEST' ? ' (TEST site)' : '';
  switch (account?.status) {
    case 'signed-in': {
      const alerts = Number.isInteger(account.alerts) && account.alerts > 0 ? `${account.alerts} new price alert${account.alerts === 1 ? '' : 's'}` : '';
      return { label: 'signed in as', value: `${account.character || 'your account'}${site}`, alerts, action: 'Sign out', note: account.offline ? 'website not reachable' : '' };
    }
    case 'code':
      return { label: 'website', value: `waiting for @weblogin ${account.code}${site}`, alerts: '', action: 'Cancel', note: '' };
    case 'signed-out':
      return { label: 'website', value: `not signed in${site}`, alerts: '', action: 'Sign in', note: account.note ?? '' };
    default:
      return { label: 'website', value: '…', alerts: '', action: '', note: '' };
  }
}

/** "9:41 left" for a code that runs out at `expiresAt` (ms). */
export function codeTimeLeft(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
}

/** The checks the launcher makes before sending (the game server makes the real ones and says why). */
export function formProblem(mode, { code = '', user = '', pass = '' }) {
  if (mode === 'signup' && !code.trim()) return 'Enter your invite code.';
  if (!user.trim()) return 'Enter your username.';
  if (!pass) return 'Enter your password.';
  return '';
}

export function startAccount({ doc = document, bridge = window.launcher, onState = bridge?.onState } = {}) {
  const methods = ['signInCode', 'cancelSignIn', 'signIn', 'signUp', 'signOut', 'openMarket'];
  if (!methods.every((m) => typeof bridge?.[m] === 'function') || typeof onState !== 'function') return () => {};
  const $ = (id) => doc.getElementById(id);
  const row = $('account-row'), dialog = $('account-dialog'), form = $('account-form'), error = $('account-error');
  let account = null, mode = 'password', busy = false, ticker = null;

  const remote = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
  const showError = (text) => { error.textContent = text; error.hidden = !text; };
  const clearPasswords = () => { for (const input of form.querySelectorAll('input[type="password"]')) input.value = ''; };

  function renderRow() {
    const view = accountRow(account);
    row.hidden = !account;
    $('account-label').textContent = view.label;
    $('account-value').textContent = view.value;
    $('account-alerts').textContent = view.alerts;
    $('account-alerts').hidden = !view.alerts;
    $('account-note').textContent = view.note;
    $('account-note').hidden = !view.note;
    $('account-action').textContent = view.action;
    $('account-action').hidden = !view.action;
  }

  function renderDialog() {
    const waiting = account?.status === 'code';
    for (const m of MODES) {
      const tab = $(`account-tab-${m}`);
      tab.setAttribute('aria-selected', String(m === mode));
      tab.disabled = busy;
    }
    form.dataset.mode = mode;
    $('account-code-field').hidden = mode !== 'signup';
    $('account-user-field').hidden = mode === 'code';
    $('account-pass-field').hidden = mode === 'code';
    $('account-code-help').hidden = mode !== 'code';
    $('account-submit').textContent = mode === 'signup' ? 'Create account' : mode === 'code' ? (waiting ? 'Get a new code' : 'Get a code') : 'Sign in';
    $('account-submit').disabled = busy;
    $('account-waiting').hidden = !(mode === 'code' && waiting);
    if (waiting) {
      $('account-code').textContent = account.code;
      $('account-time').textContent = codeTimeLeft(account.expiresAt);
    }
    $('account-site').textContent = account?.site === 'TEST' ? 'the TEST server' : 'SlumsMS';
  }

  function render() {
    renderRow();
    if (dialog.open) renderDialog();
    clearInterval(ticker);
    ticker = account?.status === 'code' && dialog.open ? setInterval(renderDialog, 1000) : null;
  }

  function receive(next) {
    if (!next?.account) return;
    const was = account?.status;
    account = next.account;
    if (account.status === 'signed-in' && was !== 'signed-in' && dialog.open) dialog.close();
    render();
  }

  function open() {
    showError('');
    if (account?.status === 'code') mode = 'code';
    dialog.showModal();
    render();
    (mode === 'signup' ? $('account-invite') : mode === 'code' ? $('account-submit') : $('account-user')).focus();
  }

  async function run(task) {
    busy = true;
    showError('');
    render();
    try {
      await task();
    } catch (e) {
      showError(remote(e));
    } finally {
      busy = false;
      render();
    }
  }

  $('account-action').addEventListener('click', () => {
    if (account?.status === 'signed-in') run(() => bridge.signOut().then((a) => receive({ account: a })));
    else if (account?.status === 'code') run(() => bridge.cancelSignIn().then((a) => receive({ account: a })));
    else open();
  });
  $('account-alerts').addEventListener('click', () => bridge.openMarket().catch(() => {}));
  for (const m of MODES) {
    $(`account-tab-${m}`).addEventListener('click', () => { mode = m; showError(''); clearPasswords(); render(); });
  }
  $('close-account').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearPasswords(); render(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    if (mode === 'code') {
      run(() => bridge.signInCode().then((a) => receive({ account: a })));
      return;
    }
    const value = { code: $('account-invite').value, user: $('account-user').value, pass: $('account-pass').value };
    clearPasswords();
    const problem = formProblem(mode, value);
    if (problem) { showError(problem); return; }
    run(() => (mode === 'signup' ? bridge.signUp(value) : bridge.signIn(value)).then((a) => receive({ account: a })));
    value.pass = '';
  });

  const stop = onState(receive);
  return () => { stop?.(); clearInterval(ticker); };
}

if (typeof document !== 'undefined') {
  startAccount();
}
