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
  $('#progress').style.width = `${(step / 5) * 100}%`;
  $('#progress-text').textContent = `Step ${step} of 5`;
  if (workspace) $('#dashboard').href = `/app.html?workspace=${encodeURIComponent(workspace.slug)}`;
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
    const result = await call('/api/workspaces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${form.adminToken.value}` },
      body: JSON.stringify({ name: form.name.value, slug: form.slug.value })
    });
    workspace = result.workspace;
    ownerToken = result.ownerToken;
    $('#ws-name').textContent = workspace.name;
    $('#owner-token').textContent = ownerToken;
    form.adminToken.value = '';
    go(2);
  } catch (error) {
    showError(form, /owner token/i.test(error.message) ? 'That admin key was not accepted.' : error.message);
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

/* Step 3: wallet */
$('#provision').addEventListener('click', async event => {
  const pane = $('.pane[data-pane="3"]');
  const task = $('#task-wallet');
  showError(pane, '');
  task.className = 'task running';
  $('#wallet-status').textContent = 'Asking Circle for a wallet on Arc…';
  const done = busy(event.currentTarget, 'Creating…');
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/provision-treasury`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } });
    workspace = result.workspace;
    task.className = 'task done';
    $('#wallet-status').textContent = workspace.walletAddress;
    $('#wallet-address').textContent = workspace.walletAddress;
    setTimeout(() => go(4), 600);
  } catch (error) {
    task.className = 'task failed';
    $('#wallet-status').textContent = 'Not created';
    showError(pane, error.message);
  } finally { done(); }
});

/* Step 4: fund */
$('#copy-address').addEventListener('click', async event => {
  try { await navigator.clipboard.writeText(workspace.walletAddress); event.currentTarget.textContent = 'Copied'; }
  catch { event.currentTarget.textContent = 'Copy failed'; }
});
$('#fund').addEventListener('click', async event => {
  const pane = $('.pane[data-pane="4"]');
  const task = $('#task-fund');
  showError(pane, '');
  task.className = 'task running';
  const done = busy(event.currentTarget, 'Requesting…');
  try {
    await call(`/api/workspaces/${workspace.slug}/fund-testnet`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } });
    task.className = 'task done';
    const note = $('#fund-status');
    note.hidden = false;
    note.textContent = 'Faucet request sent. The USDC usually lands within a minute.';
    setTimeout(() => go(5), 900);
  } catch (error) {
    task.className = 'task failed';
    showError(pane, `${error.message} You can skip this and send USDC to the address yourself.`);
  } finally { done(); }
});
$('#skip-fund').addEventListener('click', () => go(5));

/* Step 5: team keys */
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
        if (workspace.walletAddress) { $('#wallet-status').textContent = workspace.walletAddress; $('#wallet-address').textContent = workspace.walletAddress; $('#task-wallet').className = 'task done'; }
        return go(saved.step);
      }
    }
  } catch {}
  go(1);
})();
