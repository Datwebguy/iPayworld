const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const slugify = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
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
  if (workspace) $('#dashboard').href = `/app?workspace=${encodeURIComponent(workspace.slug)}`;
  persist();
  const focusable = $(`.pane[data-pane="${step}"] input, .pane[data-pane="${step}"] button`);
  if (focusable && step > 1) focusable.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* Step 1: create */
const form = $('#workspace-form');
let slugTouched = false;
form.slug.addEventListener('input', () => { slugTouched = true; });
form.name.addEventListener('input', () => { if (!slugTouched) form.slug.value = slugify(form.name.value); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError(form, '');
  if (!form.checkValidity()) {
    const bad = form.querySelector(':invalid');
    showError(form, bad.name === 'slug' ? 'The handle can only use lowercase letters, numbers and single dashes.' : `Fill in the ${bad.closest('label').firstChild.textContent.trim().toLowerCase()}.`);
    return bad.focus();
  }
  const done = busy($('button[type=submit]', form), 'Creating…');
  try {
    const result = await call('/api/signup', {
      method: 'POST',
      body: JSON.stringify({ name: form.name.value, slug: form.slug.value })
    });
    workspace = result.workspace;
    ownerToken = result.ownerToken;
    $('#ws-name').textContent = workspace.name;
    $('#owner-token').textContent = ownerToken;
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
  try {
    await navigator.clipboard.writeText(ownerToken);
    event.currentTarget.textContent = 'Copied';
    setTimeout(() => { event.target.textContent = 'Copy'; }, 2000);
  } catch { event.currentTarget.textContent = 'Select and copy manually'; }
});
$('#download-key').addEventListener('click', () => {
  const text = `iPay owner key\nWorkspace: ${workspace.name} (${workspace.slug})\nCreated: ${new Date().toISOString()}\n\n${ownerToken}\n`;
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
