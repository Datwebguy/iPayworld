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
  button.textContent = 'Creating Workspace...';
  try {
    const result = await call('/api/workspaces', { 
      method: 'POST', 
      headers: { Authorization: `Bearer ${form.get('adminToken')}` }, 
      body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }) 
    });
    workspace = result.workspace;
    ownerToken = result.ownerToken;
    sessionStorage.setItem(`ipay-owner-token:${workspace.slug}`, ownerToken);

    $('#workspace-name').textContent = workspace.name;
    $('#owner-token').textContent = ownerToken;
    $('#create-card').classList.add('hidden');
    $('#success-card').classList.remove('hidden');
  } catch (error) { 
    alert(error.message); 
  } finally { 
    button.disabled = false; 
    button.textContent = 'Create Workspace ->';
  }
});

const copyBtn = $('#copy-owner-btn');
if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    if (!ownerToken) return;
    try {
      await navigator.clipboard.writeText(ownerToken);
      copyBtn.innerHTML = '<span>Copied to Clipboard</span>';
      setTimeout(() => { 
        copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: -2px; margin-right: 4px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy Security Key</span>'; 
      }, 2500);
    } catch {
      alert('Could not copy to clipboard');
    }
  });
}

$('#provision').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  $('#status').textContent = 'Activating Circle Treasury Vault on Arc...';
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/provision-treasury`, { 
      method: 'POST', 
      headers: { Authorization: `Bearer ${ownerToken}` } 
    });
    workspace = result.workspace;
    $('#fund').disabled = false;
    $('#status').textContent = `Treasury Vault Active: ${workspace.walletAddress}`;
  } catch (error) { 
    $('#status').textContent = `Error: ${error.message}`; 
    event.currentTarget.disabled = false; 
  }
});

$('#fund').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  $('#status').textContent = 'Allocating treasury reserve USDC and gas buffer...';
  try {
    await call(`/api/workspaces/${workspace.slug}/fund-testnet`, { 
      method: 'POST', 
      headers: { Authorization: `Bearer ${ownerToken}` } 
    });
    $('#status').textContent = 'Treasury vault funded and verified. Ready to launch.';
    const link = $('#dashboard');
    link.href = `/app.html?workspace=${encodeURIComponent(workspace.slug)}`;
    link.classList.remove('hidden');
  } catch (error) { 
    $('#status').textContent = `Error: ${error.message}`; 
    event.currentTarget.disabled = false; 
  }
});

$('#member-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  button.textContent = 'Generating Access Key...';
  try {
    const result = await call(`/api/workspaces/${workspace.slug}/members`, { 
      method: 'POST', 
      headers: { Authorization: `Bearer ${ownerToken}` }, 
      body: JSON.stringify({ name: form.get('name'), role: form.get('role') }) 
    });
    const token = $('#member-token');
    token.textContent = `${result.member.role} key: ${result.accessToken}`;
    token.classList.remove('hidden');
    event.currentTarget.reset();
  } catch (error) { 
    $('#status').textContent = error.message; 
  } finally { 
    button.disabled = false; 
    button.textContent = 'Issue Team Access Key';
  }
});
