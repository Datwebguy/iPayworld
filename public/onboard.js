const $ = selector => document.querySelector(selector);
let workspace;
let ownerToken;
const api = '';

async function call(path, options = {}) {
  const response = await fetch(`${api}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

$('#workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await call('/api/workspaces', { method: 'POST', headers: { Authorization: `Bearer ${form.get('adminToken')}` }, body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }) });
    workspace = result.workspace;
    ownerToken = result.ownerToken;
    $('#workspace-name').textContent = workspace.name;
    $('#owner-token').textContent = ownerToken;
    $('#create-card').classList.add('hidden');
    $('#success-card').classList.remove('hidden');
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
});

$('#provision').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  $('#status').textContent = 'Creating Circle Agent Wallet…';
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/provision-treasury`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } });
    workspace = result.workspace;
    $('#fund').disabled = false;
    $('#status').textContent = `Wallet ready: ${workspace.walletAddress}`;
  } catch (error) { $('#status').textContent = error.message; event.currentTarget.disabled = false; }
});

$('#fund').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  $('#status').textContent = 'Requesting Arc Testnet USDC and gas…';
  try {
    await call(`/api/workspaces/${workspace.slug}/fund-testnet`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } });
    $('#status').textContent = 'Funding requested. The balance will update shortly.';
    const link = $('#dashboard');
    link.href = `/app.html?workspace=${encodeURIComponent(workspace.slug)}`;
    link.classList.remove('hidden');
  } catch (error) { $('#status').textContent = error.message; event.currentTarget.disabled = false; }
});

$('#member-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/members`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ name: form.get('name'), role: form.get('role') }) });
    const token = $('#member-token');
    token.textContent = `${result.member.role} credential: ${result.accessToken}`;
    token.classList.remove('hidden');
    event.currentTarget.reset();
  } catch (error) { $('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
