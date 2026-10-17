const $ = selector => document.querySelector(selector);
const workspaceSlug = new URLSearchParams(window.location.search).get('workspace');
const money = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Wallet not connected';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const time = value => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
let data;
let view = 'overview';
let filter = 'all';
let verifyingId;
let toastTimer;
let ownerToken = '';

function endpoint(path) {
  if (!workspaceSlug) return path;
  const root = `/api/workspaces/${encodeURIComponent(workspaceSlug)}`;
  if (path === '/api/state') return `${root}/state`;
  if (path === '/api/milestones') return `${root}/milestones`;
  if (path === '/api/earn/deposit') return `${root}/earn/deposit`;
  const action = path.match(/^\/api\/milestones\/([a-f0-9-]+)\/(verify|release)$/);
  return action ? `${root}/milestones/${action[1]}/${action[2]}` : path;
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 4000);
}
async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}), ...options?.headers } });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Server returned an unexpected response'); }
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}
async function refresh() {
  data = await request(endpoint('/api/state'));
  render();
  if (data.mode === 'demo') loadArcWallet();
  if (workspaceSlug) {
    $('#earn-vault-address').textContent = data.wallet?.vaultAddress ? shortAddress(data.wallet.vaultAddress) : 'Treasury not provisioned';
    $('#earn-vault-balance').textContent = `${Number(data.wallet?.vault || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
    $('#earn-vault-yield').textContent = data.wallet?.yieldEarned === null ? 'Yield unavailable' : `${money(data.wallet?.yieldEarned)} yield earned · live`;
  } else loadEarnPosition();
}
async function loadEarnPosition() {
  try {
    const position = await request('/api/earn-position');
    $('#earn-vault-address').textContent = position.configured ? `${position.chain} · ${shortAddress(position.vaultAddress)}` : 'No vault configured';
    $('#earn-vault-balance').textContent = position.configured ? `${Number(position.currentBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC` : 'Not connected';
    $('#earn-vault-yield').textContent = position.configured && position.yieldEarned !== null ? `${money(position.yieldEarned)} yield earned · live` : 'Position · read only';
  } catch (error) {
    $('#earn-vault-address').textContent = 'Could not read Earn vault';
    $('#earn-vault-balance').textContent = 'Unavailable';
    $('#earn-vault-yield').textContent = error.message;
  }
}
async function loadArcWallet() {
  try {
    const wallet = await request('/api/arc-wallet');
    $('#arc-wallet-address').textContent = wallet.configured ? shortAddress(wallet.address) : 'No wallet address configured';
    $('#arc-wallet-balance').textContent = wallet.configured ? `${Number(wallet.balanceUsdc).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC` : 'Not connected';
  } catch (error) {
    $('#arc-wallet-address').textContent = 'Could not read wallet';
    $('#arc-wallet-balance').textContent = error.message;
  }
}
function statusText(status) {
  return ({ in_progress: 'In progress', awaiting_verification: 'Awaiting approval', verified: 'Verified', checking: 'Checking risk', withdrawing: 'Withdrawing', sending: 'Sending', confirming: 'Confirming', needs_reconciliation: 'Needs reconciliation', review: 'Needs review', blocked: 'Blocked', paid: 'Paid' })[status] || status;
}
function icon(status) {
  if (status === 'paid' || status === 'verified') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  if (status === 'blocked') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  if (status === 'review') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
}
function actionHtml(m) {
  if (['in_progress', 'awaiting_verification'].includes(m.status)) return `<button class="row-action" data-action="verify" data-id="${m.id}">Verify Work</button>`;
  if (m.status === 'verified') return `<button class="row-action release" data-action="release" data-id="${m.id}">Release Payout -></button>`;
  if (data.mode === 'live' && m.status === 'needs_reconciliation') return `<button class="row-action" data-action="reconcile" data-id="${m.id}">Reconcile Tx</button>`;
  return '';
}
function milestoneHtml(m, detailed = false) {
  return `<div class="milestone-row"><div class="milestone-icon ${escapeHtml(m.status)}">${icon(m.status)}</div><div class="milestone-detail"><strong>${escapeHtml(m.title)}</strong><small>${escapeHtml(m.contractor)} · <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(m.address)}" title="Click to copy address">${escapeHtml(shortAddress(m.address))}</span></small>${detailed ? `<div class="milestone-meta">${escapeHtml(m.description || 'No description')}${m.evidence ? ` · Evidence: ${escapeHtml(m.evidence)}` : ''}${m.risk ? ` · Risk: ${escapeHtml(m.risk.verdict)} (${escapeHtml(m.risk.source)})` : ''}</div>` : ''}</div><div class="milestone-right"><strong>${money(m.amount)} <span style="color:#81909a;font-size:10px">USDC</span></strong><span class="status ${escapeHtml(m.status)}">${statusText(m.status)}</span></div><div class="row-actions">${actionHtml(m)}</div></div>`;
}
function activityHtml(a, detailed = false) {
  const glyph = {
    payment: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
    risk_check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    milestone_verified: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    milestone_created: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    release_failed: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    budget_funded: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>'
  }[a.type] || '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>';
  let extra = '';
  if (detailed) {
    if (a.txHash) extra += `<div class="audit-extra">${a.simulated ? 'Simulated tx' : 'Arc tx'}: <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(a.txHash)}" title="Click to copy">${escapeHtml(a.txHash)}</span></div>`;
    if (a.withdrawTxHash) extra += `<div class="audit-extra">Vault withdrawal tx: <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(a.withdrawTxHash)}" title="Click to copy">${escapeHtml(a.withdrawTxHash)}</span></div>`;
    if (a.risk) extra += `<div class="audit-extra">Risk: ${escapeHtml(a.risk.verdict)} · ${escapeHtml(a.risk.reason)} · ${a.risk.signatureVerified ? 'signature verified' : 'no verified signature'}${a.risk.decisionId ? ` · Decision ${escapeHtml(a.risk.decisionId)}` : ''}</div>${a.risk.signedProof ? `<button class="proof-button" data-proof-id="${escapeHtml(a.id)}">Inspect Signed Proof -></button>` : ''}`;
    if (a.evidence) extra += `<div class="audit-extra">Evidence: ${escapeHtml(a.evidence)}</div>`;
    if (a.yieldSnapshot !== undefined) extra += `<div class="audit-extra">Yield snapshot: ${a.yieldSnapshot === null ? 'unavailable' : money(a.yieldSnapshot)}${a.redeemed !== undefined ? ` · vault withdrawn: ${money(a.redeemed)}` : ''}</div>`;
  }
  return `<div class="activity-row"><div class="activity-dot">${glyph}</div><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.detail)}${a.simulated ? ' · simulated' : ''}</small>${extra}</div><div class="activity-time">${time(a.at)}</div></div>`;
}
function render() {
  if (!data) return;
  $('#mode-pill').textContent = data.mode === 'demo' ? '● Demo mode' : '● Live testnet';
  if (data.mode === 'live') {
    $('#arc-wallet-address').textContent = shortAddress(data.wallet.address);
    $('#arc-wallet-balance').textContent = `${Number(data.wallet.liquid).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
  }
  $('#budget-source').textContent = data.mode === 'live' ? 'Live Circle wallet and Earn vault' : 'Simulated USDC on Arc';
  $('#verify-submit').textContent = data.mode === 'live' ? 'Verify & release real USDC' : 'Verify & run risk check';
  $('#demo-notice-text').innerHTML = data.mode === 'live' ? '<strong>Live Arc payments enabled</strong> — verifying a milestone can withdraw vault USDC and pay the contractor after a LOW signed CompliR verdict.' : data.screeningMode === 'live' ? '<strong>Live CompliR screening</strong> — signed verdicts are checked; dashboard wallet balances, vault yield, and Arc transfers remain simulated. No funds move.' : '<strong>Interactive demo</strong> — balances, yield, risk results, and transaction hashes are simulated. No funds move on Arc.';
  $('#network-type').textContent = data.mode === 'demo' ? 'Demo network' : 'Arc';
  $('#create-button').disabled = false;
  $('#nav-count').textContent = data.milestones.filter(m => !['paid', 'blocked'].includes(m.status)).length;
  $('#total-budget').innerHTML = `${money(data.wallet.liquid + data.wallet.vault)} <small>USDC</small>`;
  $('#available').innerHTML = `${money(data.available)} <small>USDC</small>`;
  $('#vault').innerHTML = `${money(data.wallet.vault)} <small>USDC</small>`;
  $('#yield-earned').textContent = data.wallet.yieldEarned === null ? 'Unavailable' : money(data.wallet.yieldEarned);
  $('#yield-source').textContent = data.mode === 'live' ? '· live' : '· simulated';
  $('#milestone-list').innerHTML = data.milestones.length ? data.milestones.slice(0, 4).map(m => milestoneHtml(m)).join('') : '<div class="empty">No milestones yet. Create one to get started.</div>';
  const filtered = data.milestones.filter(m => filter === 'all' || filter === 'active' && !['paid', 'blocked'].includes(m.status) || filter === 'complete' && ['paid', 'blocked'].includes(m.status));
  $('#all-milestones').innerHTML = filtered.length ? filtered.map(m => milestoneHtml(m, true)).join('') : '<div class="empty">No milestones in this view.</div>';
  $('#activity-preview-list').innerHTML = data.audit.length ? data.audit.slice(0, 3).map(a => activityHtml(a)).join('') : '<div class="empty">Your first verified milestone starts the trail.<br><small>Every risk decision and payment receipt will appear here.</small></div>';
  $('#all-activity').innerHTML = data.audit.length ? data.audit.map(a => activityHtml(a, true)).join('') : '<div class="empty">No activity yet.</div>';
  const labels = { overview: ['Overview', 'Good work. Paid with confidence.', 'Your contractor budget, from first deposit to final delivery.'], milestones: ['Milestones', 'Make progress. Release payment.', 'Define the deliverable, verify the work, and track every release.'], activity: ['Audit trail', 'Every payment has a story.', 'Follow the evidence, signed risk checks, and settlement receipts.'] };
  const [label, title, subtitle] = labels[view];
  $('#breadcrumb').textContent = label;
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  for (const name of Object.keys(labels)) $(`#${name}-view`).classList.toggle('hidden', name !== view);
  document.querySelectorAll('[data-view].nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === view));
}
function setView(next) { view = next; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

document.addEventListener('click', async event => {
  const copyTarget = event.target.closest('[data-copy]');
  if (copyTarget) {
    const text = copyTarget.dataset.copy;
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        toast(`Copied ${text.length > 20 ? text.slice(0, 10) + '…' : text} to clipboard!`);
      } catch {
        toast('Could not copy to clipboard', true);
      }
      return;
    }
  }

  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) return setView(button.dataset.view);
  if (button.dataset.close !== undefined) return button.closest('dialog').close();
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
    return render();
  }
  if (button.dataset.proofId) {
    const entry = data.audit.find(item => item.id === button.dataset.proofId);
    if (!entry?.risk?.signedProof) return;
    $('#proof-content').textContent = JSON.stringify({ decisionId: entry.risk.decisionId, verdict: entry.risk.verdict, checkedAt: entry.risk.checkedAt, attestation: entry.risk.signedProof }, null, 2);
    return $('#proof-dialog').showModal();
  }
  if (!button.dataset.action) return;
  const m = data.milestones.find(item => item.id === button.dataset.id);
  if (!m) return;
  if (button.dataset.action === 'reconcile') {
    const txHash = window.prompt('Enter the Arc USDC payment transaction hash. The receipt must match this milestone.');
    if (!txHash) return;
    try {
      data = await request(`/api/milestones/${m.id}/reconcile`, { method: 'POST', body: JSON.stringify({ txHash }) });
      render();
      toast('Matching Arc payment receipt recorded.');
    } catch (error) { toast(error.message, true); }
  } else if (button.dataset.action === 'verify') {
    verifyingId = m.id;
    $('#verify-description').textContent = data.mode === 'live' ? `Confirm that “${m.title}” was delivered. This can send ${money(m.amount)} USDC to ${m.address} after a LOW CompliR check.` : `Confirm that “${m.title}” was delivered by ${m.contractor}. Your evidence will be recorded in the audit trail.`;
    $('#verify-dialog').showModal();
  } else if (button.dataset.action === 'release') {
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      data = await request(endpoint(`/api/milestones/${m.id}/release`), { method: 'POST', body: '{}' });
      render();
      const updated = data.milestones.find(item => item.id === m.id);
      toast(updated.status === 'paid' ? `${data.mode === 'live' ? 'Arc' : 'Demo'} payment released after a LOW risk check.` : updated.status === 'review' ? 'MEDIUM risk: payment sent for review.' : updated.status === 'blocked' ? 'HIGH risk: payment blocked.' : updated.status === 'needs_reconciliation' ? 'Payment needs manual reconciliation. Do not retry.' : 'Release could not complete.');
    } catch (error) { toast(error.message, true); await refresh(); }
  }
});
$('#create-button').addEventListener('click', () => {
  if (data?.mode === 'live' && !ownerToken) return $('#auth-dialog').showModal();
  $('#create-dialog').showModal();
});
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.style.transform = 'rotate(360deg)';
  btn.style.transition = 'transform 0.4s ease';
  try {
    await refresh();
    toast('Dashboard refreshed.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    setTimeout(() => {
      btn.style.transform = '';
      btn.style.transition = '';
    }, 450);
  }
});
$('#park-button').addEventListener('click', async () => {
  if (data?.mode !== 'live') return toast('Earn vault deposits require live mode.', true);
  if (!ownerToken) return $('#auth-dialog').showModal();
  const amount = window.prompt('How much USDC should iPay park in the Earn Kit vault?');
  if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) return;
  const button = $('#park-button');
  button.disabled = true;
  button.textContent = 'Depositing…';
  try {
    data = await request(endpoint('/api/earn/deposit'), { method: 'POST', body: JSON.stringify({ amount }) });
    await refresh();
    toast(`${amount} USDC parked in Earn Kit.`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Park USDC'; }
});
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  try {
    data = await request(endpoint('/api/milestones'), { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    $('#create-dialog').close();
    setView('milestones');
    toast('Milestone created.');
  } catch (error) { toast(error.message, true); }
});
$('#verify-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    data = await request(endpoint(`/api/milestones/${verifyingId}/verify`), { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    $('#verify-dialog').close();
    render();
    const updated = data.milestones.find(item => item.id === verifyingId);
    toast(updated.status === 'paid' ? 'Verified and released after a LOW risk check.' : updated.status === 'review' ? 'Verified. MEDIUM risk requires review.' : updated.status === 'blocked' ? 'Verified. HIGH risk blocked payment.' : updated.status === 'needs_reconciliation' ? 'Payment needs manual reconciliation. Do not retry.' : updated.risk?.verdict === 'UNAVAILABLE' ? 'Verified. Risk check failed; no payment was released.' : 'Verified, but payment needs available funds.');
  } catch (error) { toast(error.message, true); }
});
async function boot() {
  const config = await request('/api/config');
  if (config.mode === 'live') {
    $('#mode-pill').textContent = '● Live testnet';
    $('#network-type').textContent = 'Arc Testnet';
    $('#demo-notice-text').innerHTML = '<strong>Live Arc Testnet treasury</strong> — balances, milestones, and audit records are live. Owner authorization is required only for payment actions.';
    ownerToken = sessionStorage.getItem(workspaceSlug ? `ipay-owner-token:${workspaceSlug}` : 'ipay-owner-token') || '';
  }
  if (workspaceSlug && !ownerToken) {
    $('#auth-dialog').showModal();
    return;
  }
  await refresh();
}
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const token = new FormData(event.currentTarget).get('ownerToken')?.trim();
  if (!token) return;
  ownerToken = token;
  try {
    await refresh();
    sessionStorage.setItem(workspaceSlug ? `ipay-owner-token:${workspaceSlug}` : 'ipay-owner-token', ownerToken);
    $('#auth-dialog').close();
    toast('Treasury unlocked. Live Arc Testnet data loaded.');
  } catch (error) {
    ownerToken = '';
    toast(error.message, true);
  }
});
boot().catch(error => toast(error.message, true));
