const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STEP_KEY = 'ipay-setup';

let workspace = null;
let ownerToken = '';
let step = 1;

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch {
    throw new Error('Could not reach the iPay server.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function showError(scope, message) {
  const el = $('[data-error]', scope);
  el.textContent = message || '';
  el.hidden = !message;
}

function busy(button, label) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = false; button.innerHTML = original; };
}

function persist() {
  // Session only: the owner key must not outlive the tab.
  try { sessionStorage.setItem(STEP_KEY, JSON.stringify({ workspace, step })); } catch {}
  if (workspace && ownerToken) try { sessionStorage.setItem(`ipay-owner-token:${workspace.slug}`, ownerToken); } catch {}
}

function go(next) {
  step = next;
  $$('.pane').forEach(pane => pane.hidden = Number(pane.dataset.pane) !== step);
  $$('#steps li').forEach(li => {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < step);
    li.classList.toggle('current', n === step);
    if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  $('#progress').style.width = `${(step / 4) * 100}%`;
  $('#progress-text').textContent = `Step ${step} of 4`;
  // Setup is finished at step 4; forget it so the next visit opens the entry screen.
  if (step === 4) setTimeout(() => { try { sessionStorage.removeItem(STEP_KEY); } catch {} }, 0);
  if (workspace) $('#dashboard').href = `/app?workspace=${encodeURIComponent(workspace.slug)}`;
  persist();
  const focusable = $(`.pane[data-pane="${step}"] input, .pane[data-pane="${step}"] button`);
  if (focusable && step > 1) focusable.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* Step 1: one entry for everyone. No key creates a workspace; a key signs in. */
const form = $('#workspace-form');
const toSlug = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Accept a pasted "Workspace handle: x / Key: y" block from the copy button or key file.
function parseEntry() {
  let name = form.name.value.trim();
  let key = form.key.value.trim();
  const pasted = `${name}\n${key}`;
  const handle = pasted.match(/Workspace handle:\s*([a-z0-9-]+)/i)?.[1];
  const token = pasted.match(/(ipay_(?:ws|member)_[A-Za-z0-9_-]+)/)?.[1];
  if (token) key = token;
  if (handle) name = handle;
  return { name, key };
}
form.key.addEventListener('input', () => {
  $('#entry-submit').textContent = form.key.value.trim() ? 'Open my workspace' : 'Create my workspace';
});

async function signIn(handle, key) {
  const slug = toSlug(handle);
  const response = await fetch(`/api/workspaces/${encodeURIComponent(slug)}/state`, { headers: { Authorization: `Bearer ${key}` } });
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error("That workspace handle and key don't match. Check both and try again.");
  if (!response.ok) throw new Error('Could not reach iPay. Try again in a moment.');
  try { sessionStorage.setItem(`ipay-owner-token:${slug}`, key); localStorage.setItem('ipay-last-workspace', slug); } catch {}
  location.href = `/app?workspace=${encodeURIComponent(slug)}`;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError(form, '');
  if (!form.checkValidity()) {
    const bad = form.querySelector(':invalid');
    showError(form, 'Enter your business name, or your workspace handle if you already have one.');
    return bad.focus();
  }
  const entry = parseEntry();
  if (entry.key) {
    const doneSignIn = busy($('button[type=submit]', form), 'Opening…');
    try { return await signIn(entry.name, entry.key); }
    catch (error) { showError(form, error.message); doneSignIn(); return; }
  }
  const done = busy($('button[type=submit]', form), 'Creating…');
  try {
    const result = await call('/api/signup', {
      method: 'POST',
      body: JSON.stringify({ name: entry.name })
    });
    workspace = result.workspace;
    ownerToken = result.ownerToken;
    $('#ws-name').textContent = workspace.name;
    $('#owner-token').textContent = ownerToken;
    $('#ws-handle').textContent = workspace.slug;
    try { localStorage.setItem('ipay-last-workspace', workspace.slug); } catch {}
    $('#wallet-status').textContent = workspace.walletAddress ? 'Ready' : 'Created when you add money';
    go(2);
  } catch (error) {
    showError(form, /already in use/i.test(error.message) ? 'That handle is taken. Try another one.' : error.message);
  } finally { done(); }
});

/* Step 2: save the key */
$('#saved-key').addEventListener('change', event => { $('#to-3').disabled = !event.target.checked; });
$('#copy-key').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(`Workspace handle: ${workspace.slug}\nKey: ${ownerToken}`);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy both'; }, 2000);
  } catch { button.textContent = 'Select and copy manually'; }
});
$('#download-key').addEventListener('click', () => {
  const text = `iPay sign-in for ${workspace.name}\nSign in at ${location.origin}/app\n\nWorkspace handle: ${workspace.slug}\nKey: ${ownerToken}\n\nCreated ${new Date().toISOString()}. Keep this file private.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `ipay-${workspace.slug}-owner-key.txt` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#to-3').addEventListener('click', () => go(3));

// Signup creates the account; if Circle was slow then, create it now before funding.
async function ensureAccount() {
  if (workspace.walletAddress) return;
  $('#wallet-status').textContent = 'Creating your account…';
  const result = await call(`/api/workspaces/${workspace.slug}/provision-treasury`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } });
  workspace = result.workspace;
  persist();
  $('#wallet-status').textContent = 'Ready';
}

/* Step 3: add money via the public Circle faucet, watching the balance until it lands */
let watching;
function watchBalance() {
  if (watching) return;
  const task = $('#task-fund');
  task.className = 'task running';
  $('#wallet-status').textContent = 'Waiting for funds…';
  watching = setInterval(async () => {
    try {
      const state = await call(`/api/workspaces/${workspace.slug}/state`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      const balance = Number(state.wallet?.liquid || 0) + Number(state.wallet?.vault || 0);
      if (balance > 0) {
        clearInterval(watching);
        task.className = 'task done';
        $('#wallet-status').textContent = `$${balance.toFixed(2)} received`;
        setTimeout(() => go(4), 1200);
      }
    } catch {}
  }, 5000);
}
$('#copy-address').addEventListener('click', async event => {
  const button = event.currentTarget;
  showError($('.pane[data-pane="3"]'), '');
  try {
    await ensureAccount();
    await navigator.clipboard.writeText(workspace.walletAddress);
    button.textContent = 'Copied';
    watchBalance();
  } catch (error) {
    if (workspace?.walletAddress) {
      button.textContent = workspace.walletAddress;
      button.style.whiteSpace = 'normal';
      button.style.wordBreak = 'break-all';
      watchBalance();
    } else showError($('.pane[data-pane="3"]'), error.message);
  }
});
$('#open-faucet').addEventListener('click', () => watchBalance());
$('#skip-fund').addEventListener('click', () => { clearInterval(watching); go(4); });

/* Step 4: team keys */
$('#member-form').addEventListener('submit', async event => {
  event.preventDefault();
  const memberForm = event.currentTarget;
  showError(memberForm, '');
  const data = new FormData(memberForm);
  const done = busy($('button[type=submit]', memberForm), 'Creating key…');
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: data.get('name'), role: data.get('role') })
    });
    const li = document.createElement('li');
    li.innerHTML = `<span class="who"><span></span><button type="button" class="btn btn-sm">Copy</button></span><code class="mono"></code>`;
    li.querySelector('.who span').textContent = `${result.member.name} · ${result.member.role}. Shown once.`;
    li.querySelector('code').textContent = result.accessToken;
    li.querySelector('button').addEventListener('click', async e => {
      try { await navigator.clipboard.writeText(result.accessToken); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed'; }
    });
    $('#issued').prepend(li);
    memberForm.reset();
  } catch (error) {
    showError(memberForm, error.message);
  } finally { done(); }
});

/* Resume a setup interrupted by a reload in the same tab (past step 2 only, the key is never re-shown). */
(function resume() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STEP_KEY) || 'null');
    if (saved?.workspace && saved.step > 2) {
      workspace = saved.workspace;
      ownerToken = sessionStorage.getItem(`ipay-owner-token:${workspace.slug}`) || '';
      if (ownerToken) {
        if (!workspace.walletAddress) $('#wallet-status').textContent = 'Not created yet';
        return go(saved.step);
      }
    }
  } catch {}
  go(1);
})();

/* On mainnet there is no faucet: the funding step asks for a real USDC deposit instead. */
call('/api/config').then(config => {
  if (config.network?.testnet !== false) return;
  const pane = $('.pane[data-pane="3"]');
  $('.pane-lede', pane).textContent = 'Send USDC on Arc to your payments account. Payments to contractors come out of this balance.';
  $('#open-faucet').closest('li').remove();
  const last = $('.fund-steps li:last-child span', pane);
  if (last) last.textContent = '2';
  $$('#steps li[data-step="3"] small').forEach(el => { el.textContent = 'Send USDC to your account'; });
}).catch(() => {});

/* Returning on this device: prefill the handle so only the key is needed. */
try {
  const last = localStorage.getItem('ipay-last-workspace');
  if (last && step === 1 && !form.name.value) {
    form.name.value = last;
    form.key.focus();
  }
} catch {}
