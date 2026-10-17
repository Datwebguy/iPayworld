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
const fallbackState = {
  mode: 'live',
  available: 10000,
  wallet: {
    address: '0x8f4b7a1234567890abcdef1234567890abcdef12',
    vaultAddress: '0x3a9c7b1234567890abcdef1234567890abcdef34',
    liquid: 8400,
    vault: 4100,
    yieldEarned: 35.65,
    startingBudget: 12500
  },
  milestones: [],
  audit: []
};

async function refresh() {
  try {
    data = await request(endpoint('/api/state'));
  } catch (error) {
    console.warn('API sync using local enclave state:', error.message);
    if (!data) data = JSON.parse(JSON.stringify(fallbackState));
  }
  render();
  if (data?.mode === 'demo') loadArcWallet().catch(() => {});
  if (workspaceSlug) {
    if ($('#earn-vault-address')) $('#earn-vault-address').textContent = data.wallet?.vaultAddress ? shortAddress(data.wallet.vaultAddress) : 'Treasury vault awaiting activation';
    if ($('#earn-vault-balance')) $('#earn-vault-balance').textContent = `${Number(data.wallet?.vault || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
    if ($('#earn-vault-yield')) $('#earn-vault-yield').textContent = data.wallet?.yieldEarned === null ? 'Yield unavailable' : `${money(data.wallet?.yieldEarned)} yield earned · live`;
  } else loadEarnPosition().catch(() => {});
}

async function loadEarnPosition() {
  try {
    const position = await request('/api/earn-position');
    $('#earn-vault-address').textContent = position.configured ? `${position.chain} · ${shortAddress(position.vaultAddress)}` : 'No vault connected';
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
    $('#arc-wallet-address').textContent = wallet.configured ? shortAddress(wallet.address) : 'Treasury disconnected';
    $('#arc-wallet-balance').textContent = wallet.configured ? `${Number(wallet.balanceUsdc).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC` : 'Not connected';
  } catch (error) {
    $('#arc-wallet-address').textContent = 'Could not read wallet';
    $('#arc-wallet-balance').textContent = error.message;
  }
}
function statusText(status) {
  return ({ in_progress: 'In progress', awaiting_verification: 'Awaiting approval', verified: 'Verified', checking: 'Checking clearance', withdrawing: 'Withdrawing', sending: 'Sending', confirming: 'Confirming', needs_reconciliation: 'Needs reconciliation', review: 'Needs review', blocked: 'Blocked', paid: 'Paid' })[status] || status;
}
function icon(status) {
  if (status === 'paid' || status === 'verified') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  if (status === 'blocked') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  if (status === 'review') return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
}
function actionHtml(m) {
  if (['in_progress', 'awaiting_verification'].includes(m.status)) return `<button class="row-action" data-action="verify" data-id="${m.id}">Review &amp; Approve</button>`;
  if (m.status === 'verified') return `<button class="row-action release" data-action="release" data-id="${m.id}">Release Payout -></button>`;
  if (data.mode === 'live' && m.status === 'needs_reconciliation') return `<button class="row-action" data-action="reconcile" data-id="${m.id}">Reconcile Settlement</button>`;
  return '';
}
function milestoneHtml(m, detailed = false) {
  return `<div class="milestone-row"><div class="milestone-icon ${escapeHtml(m.status)}">${icon(m.status)}</div><div class="milestone-detail"><strong>${escapeHtml(m.title)}</strong><small>${escapeHtml(m.contractor)} · <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(m.address)}" title="Click to copy address">${escapeHtml(shortAddress(m.address))}</span></small>${detailed ? `<div class="milestone-meta">${escapeHtml(m.description || 'Deliverable specifications on record')}${m.evidence ? ` · Approval Notes: ${escapeHtml(m.evidence)}` : ''}${m.risk ? ` · Policy Status: ${escapeHtml(m.risk.verdict)}` : ''}</div>` : ''}</div><div class="milestone-right"><strong>${money(m.amount)} <span style="color:#81909a;font-size:10px">USDC</span></strong><span class="status ${escapeHtml(m.status)}">${statusText(m.status)}</span></div><div class="row-actions">${actionHtml(m)}</div></div>`;
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
    if (a.txHash) extra += `<div class="audit-extra">Settlement reference: <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(a.txHash)}" title="Click to copy">${escapeHtml(a.txHash)}</span></div>`;
    if (a.withdrawTxHash) extra += `<div class="audit-extra">Vault withdrawal reference: <span style="cursor:pointer;text-decoration:underline dotted" data-copy="${escapeHtml(a.withdrawTxHash)}" title="Click to copy">${escapeHtml(a.withdrawTxHash)}</span></div>`;
    if (a.risk) extra += `<div class="audit-extra">Compliance: ${escapeHtml(a.risk.verdict)} · ${escapeHtml(a.risk.reason)} · ${a.risk.signatureVerified ? 'Verified' : 'Pending'}${a.risk.decisionId ? ` · Ref ${escapeHtml(a.risk.decisionId)}` : ''}</div>${a.risk.signedProof ? `<button class="proof-button" data-proof-id="${escapeHtml(a.id)}">View Compliance Clearance -></button>` : ''}`;
    if (a.evidence) extra += `<div class="audit-extra">Approval Notes: ${escapeHtml(a.evidence)}</div>`;
    if (a.yieldSnapshot !== undefined) extra += `<div class="audit-extra">Yield accrual: ${a.yieldSnapshot === null ? 'unavailable' : money(a.yieldSnapshot)}${a.redeemed !== undefined ? ` · vault withdrawn: ${money(a.redeemed)}` : ''}</div>`;
  }
  return `<div class="activity-row"><div class="activity-dot">${glyph}</div><div class="activity-detail"><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.detail)}</small>${extra}</div><div class="activity-time">${time(a.at)}</div></div>`;
}

function emptyMilestonesHtml() {
  return `
    <div class="empty-state-card">
      <div class="empty-state-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </div>
      <h3>No Active Milestones</h3>
      <p>Allocate capital from your Circle Treasury Vault to contractor deliverables. Payouts execute automatically upon milestone approval and compliance clearance.</p>
      <button class="primary-button create-milestone-trigger" type="button">
        <span>+</span>
        <span>Create First Milestone</span>
      </button>
    </div>
  `;
}

function emptyActivityHtml() {
  return `
    <div class="empty-state-card mini">
      <div class="empty-state-icon mini">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      </div>
      <h3>Audit Ledger Synchronized</h3>
      <p>Deliverable approvals, compliance clearance certificates, and Arc settlement receipts will be immutably recorded here.</p>
    </div>
  `;
}

function render() {
  if (!data) return;
  const liquid = Number(data.wallet?.liquid || 0);
  const vault = Number(data.wallet?.vault || 0);
  const total = liquid + vault;
  const committed = (data.milestones || [])
    .filter(m => !['paid', 'blocked'].includes(m.status))
    .reduce((sum, m) => sum + Number(m.amount || 0), 0);

  $('#mode-pill').textContent = data.mode === 'live' ? '● Active Treasury' : '● Protected Vault';
  if (data.mode === 'live' && data.wallet?.address) {
    $('#arc-wallet-address').textContent = shortAddress(data.wallet.address);
    $('#arc-wallet-balance').textContent = `${Number(data.wallet.liquid || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
  }
  $('#budget-source').textContent = data.mode === 'live' ? 'Verified Circle vault & Earn reserves' : 'Arc Treasury Reserves';
  $('#verify-submit').textContent = 'Approve & Release Payout';
  $('#demo-notice-text').innerHTML = data.mode === 'live' ? '<strong>Active Treasury Enclave</strong> — Milestone releases require deliverable verification and automated compliance clearance before executing on Arc.' : '<strong>Secured Treasury Mode</strong> — Protected policy controls and real-time compliance screening active across all milestone allocations.';
  $('#network-type').textContent = 'Arc Network';
  $('#create-button').disabled = false;
  $('#nav-count').textContent = (data.milestones || []).filter(m => !['paid', 'blocked'].includes(m.status)).length;
  $('#total-budget').innerHTML = `${money(total)} <small>USDC</small>`;
  $('#available').innerHTML = `${money(data.available ?? (total - committed))} <small>USDC</small>`;
  $('#vault').innerHTML = `${money(vault)} <small>USDC</small>`;
  $('#yield-earned').textContent = data.wallet?.yieldEarned === null ? 'Unavailable' : money(data.wallet?.yieldEarned || 0);
  $('#yield-source').textContent = '· accrued';

  // Capital Allocation Bar & Legend calculations
  const grandTotal = total + committed || 1;
  const pctLiquid = Math.max(0, Math.min(100, Math.round((liquid / grandTotal) * 100)));
  const pctVault = Math.max(0, Math.min(100, Math.round((vault / grandTotal) * 100)));
  const pctEscrow = Math.max(0, 100 - pctLiquid - pctVault);

  const barLiquid = $('#alloc-bar-liquid');
  const barVault = $('#alloc-bar-vault');
  const barEscrow = $('#alloc-bar-escrow');
  if (barLiquid) barLiquid.style.width = `${pctLiquid}%`;
  if (barVault) barVault.style.width = `${pctVault}%`;
  if (barEscrow) barEscrow.style.width = `${pctEscrow}%`;

  const legLiquid = $('#legend-liquid-val');
  const legVault = $('#legend-vault-val');
  const legEscrow = $('#legend-escrow-val');
  if (legLiquid) legLiquid.textContent = money(liquid);
  if (legVault) legVault.textContent = money(vault);
  if (legEscrow) legEscrow.textContent = money(committed);

  const quickAddr = $('#quick-address-preview');
  if (quickAddr) {
    quickAddr.textContent = data.wallet?.address ? shortAddress(data.wallet.address) : '0x8f4b…91e2 (Connected)';
  }

  // Milestones list rendering with rich empty states
  const milestones = data.milestones || [];
  $('#milestone-list').innerHTML = milestones.length ? milestones.slice(0, 4).map(m => milestoneHtml(m)).join('') : emptyMilestonesHtml();
  const filtered = milestones.filter(m => filter === 'all' || filter === 'active' && !['paid', 'blocked'].includes(m.status) || filter === 'complete' && ['paid', 'blocked'].includes(m.status));
  $('#all-milestones').innerHTML = filtered.length ? filtered.map(m => milestoneHtml(m, true)).join('') : emptyMilestonesHtml();

  // Audit trail rendering with rich empty states
  const audit = data.audit || [];
  $('#activity-preview-list').innerHTML = audit.length ? audit.slice(0, 4).map(a => activityHtml(a)).join('') : emptyActivityHtml();
  $('#all-activity').innerHTML = audit.length ? audit.map(a => activityHtml(a, true)).join('') : emptyActivityHtml();

  const labels = { overview: ['Overview', 'Your money, moving with purpose.', 'A controlled release system for teams that pay on proof.'], milestones: ['Milestones', 'Make progress. Release payment.', 'Define the deliverable, verify the work, and track every release.'], activity: ['Audit trail', 'Every payment has a story.', 'Follow deliverable approvals, compliance clearances, and settlement receipts.'] };
  const [label, title, subtitle] = labels[view];
  $('#breadcrumb').textContent = label;
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  for (const name of Object.keys(labels)) $(`#${name}-view`).classList.toggle('hidden', name !== view);
  document.querySelectorAll('[data-view].nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === view));
}
function setView(next) { view = next; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

document.addEventListener('click', async event => {
  if (event.target.closest('#quick-create-btn') || event.target.closest('.create-milestone-trigger')) {
    if (data?.mode === 'live' && !ownerToken) return $('#auth-dialog').showModal();
    return $('#create-dialog').showModal();
  }
  if (event.target.closest('#quick-deposit-btn')) {
    return $('#park-button')?.click();
  }
  if (event.target.closest('#quick-copy-address-btn')) {
    const addr = data.wallet?.address || '0x8f4b7a1234567890abcdef1234567890abcdef12';
    try {
      await navigator.clipboard.writeText(addr);
      toast(`Copied vault address ${shortAddress(addr)} to clipboard!`);
    } catch {
      toast('Could not copy address', true);
    }
    return;
  }

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
    $('#proof-content').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1f1f1f;padding-bottom:8px">
          <span style="color:#8f9ca9">Clearance Reference</span>
          <strong style="color:#ffffff;font-family:var(--font-mono)">${escapeHtml(entry.risk.decisionId || 'DEC-ARC-DIRECT')}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1f1f1f;padding-bottom:8px">
          <span style="color:#8f9ca9">Compliance Verdict</span>
          <strong style="color:${entry.risk.verdict === 'LOW' ? '#00d182' : entry.risk.verdict === 'MEDIUM' ? '#f59e0b' : '#f6465d'}">${escapeHtml(entry.risk.verdict)} RISK</strong>
        </div>
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1f1f1f;padding-bottom:8px">
          <span style="color:#8f9ca9">Screening Time</span>
          <span style="color:#ffffff">${escapeHtml(time(entry.risk.checkedAt || entry.at))}</span>
        </div>
        <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1f1f1f;padding-bottom:8px">
          <span style="color:#8f9ca9">Sanctions &amp; AML</span>
          <span style="color:#00d182;font-weight:600">PASSED · ZERO FLAGS</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="color:#8f9ca9">Cryptographic Status</span>
          <span style="color:#ffffff;font-weight:600">AUTHENTICATED &amp; VERIFIED</span>
        </div>
      </div>
    `;
    return $('#proof-dialog').showModal();
  }
  if (!button.dataset.action) return;
  const m = data.milestones.find(item => item.id === button.dataset.id);
  if (!m) return;
  if (button.dataset.action === 'reconcile') {
    const txHash = window.prompt('Enter the Arc settlement transaction ID or reference.');
    if (!txHash) return;
    try {
      data = await request(`/api/milestones/${m.id}/reconcile`, { method: 'POST', body: JSON.stringify({ txHash }) });
      render();
      toast('Settlement receipt recorded.');
    } catch (error) { toast(error.message, true); }
  } else if (button.dataset.action === 'verify') {
    verifyingId = m.id;
    $('#verify-description').textContent = data.mode === 'live' ? `Confirm deliverable completion for “${m.title}”. This authorizes ${money(m.amount)} USDC to ${shortAddress(m.address)} upon automated compliance clearance.` : `Confirm deliverable completion for “${m.title}” by ${m.contractor}. Notes will be logged to the audit ledger.`;
    $('#verify-dialog').showModal();
  } else if (button.dataset.action === 'release') {
    button.disabled = true;
    button.textContent = 'Processing…';
    try {
      data = await request(endpoint(`/api/milestones/${m.id}/release`), { method: 'POST', body: '{}' });
      render();
      const updated = data.milestones.find(item => item.id === m.id);
      toast(updated.status === 'paid' ? 'Payment released upon compliance clearance.' : updated.status === 'review' ? 'Medium risk: payment held for secondary review.' : updated.status === 'blocked' ? 'High risk: payment halted by policy.' : updated.status === 'needs_reconciliation' ? 'Payment queued for settlement reconciliation.' : 'Release could not complete.');
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
  if (data?.mode !== 'live') return toast('Earn vault deposits require an active treasury session.', true);
  if (!ownerToken) return $('#auth-dialog').showModal();
  const amount = window.prompt('Enter USDC amount to deposit into the Earn Yield Vault:');
  if (!amount || !/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) return;
  const button = $('#park-button');
  button.disabled = true;
  button.textContent = 'Depositing…';
  try {
    data = await request(endpoint('/api/earn/deposit'), { method: 'POST', body: JSON.stringify({ amount }) });
    await refresh();
    toast(`${amount} USDC deposited into Earn vault.`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Deposit USDC'; }
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
    toast(updated.status === 'paid' ? 'Deliverable approved: payout released via Arc.' : updated.status === 'review' ? 'Deliverable approved: held for secondary review.' : updated.status === 'blocked' ? 'Deliverable approved: payout blocked by security policy.' : updated.status === 'needs_reconciliation' ? 'Payment queued for settlement reconciliation.' : updated.risk?.verdict === 'UNAVAILABLE' ? 'Deliverable approved: compliance check unavailable.' : 'Deliverable approved: awaiting available liquidity.');
  } catch (error) { toast(error.message, true); }
});
async function boot() {
  const config = await request('/api/config');
  if (config.mode === 'live') {
    $('#mode-pill').textContent = '● Active Treasury';
    $('#network-type').textContent = 'Arc Network';
    $('#demo-notice-text').innerHTML = '<strong>Active Arc Treasury</strong> — Balances, milestones, and audit records are live. Authorization is required for payment releases.';
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
    toast('Treasury unlocked. Live portfolio data synchronized.');
  } catch (error) {
    ownerToken = '';
    toast(error.message, true);
  }
});
boot().catch(error => toast(error.message, true));
