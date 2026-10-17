const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const workspaceSlug = new URLSearchParams(location.search).get('workspace');
const TOKEN_KEY = workspaceSlug ? `ipay-owner-token:${workspaceSlug}` : 'ipay-owner-token';
const ARC_RPC = 'https://rpc.testnet.arc.io';
const EXPLORER = 'https://testnet.arcscan.app';
const USDC = '0x3600000000000000000000000000000000000000';
const DEMO_WALLET = '0xb3ccbf94b1965844e062bd9ad22df72b9a45ba17';
const DEMO_VAULT = '0xaabbef1d3971c710276ed41ec791bbe14cdb8e88';
const VIEWS = { overview: 'Overview', milestones: 'Milestones', activity: 'Audit trail' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Earlier builds cached locally invented milestones and payments here. Drop them.
try { localStorage.removeItem('ipay_enclave_state'); } catch {}

const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = value => usd.format(Number(value) || 0);
const round2 = value => Math.round(value * 100) / 100;
const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '–';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};
const isClosed = m => ['paid', 'blocked'].includes(m.status);
const needsYou = m => ['in_progress', 'awaiting_verification', 'verified', 'review', 'needs_reconciliation'].includes(m.status);

let data = null;
let serverMode = null;
let offline = false;
let offlineReason = '';
let token = '';
try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch {}
let view = 'overview';
let filter = 'all';
let activeId = null;
let pendingAction = null;
let lastSync = null;
let shownTotal = 0;
let toastTimer;

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  } catch {
    throw new ApiError('Could not reach the iPay server', 0);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new ApiError(response.ok ? 'The server sent a response iPay could not read' : `Server error (${response.status})`, response.status); }
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status})`, response.status);
  return payload;
}

function endpoint(path) {
  if (!workspaceSlug) return path;
  const root = `/api/workspaces/${encodeURIComponent(workspaceSlug)}`;
  if (path === '/api/state') return `${root}/state`;
  if (path === '/api/milestones') return `${root}/milestones`;
  if (path === '/api/earn/deposit') return `${root}/earn/deposit`;
  const action = path.match(/^\/api\/milestones\/([a-f0-9-]+)\/(verify|release|reconcile)$/);
  return action ? `${root}/milestones/${action[1]}/${action[2]}` : path;
}

function normalise(state) {
  const wallet = state.wallet || {};
  const milestones = state.milestones || [];
  const liquid = Number(wallet.liquid) || 0;
  const vault = Number(wallet.vault) || 0;
  const committed = state.committed ?? milestones.filter(m => !isClosed(m)).reduce((sum, m) => sum + Number(m.amount || 0), 0);
  return {
    ...state,
    wallet: { ...wallet, liquid, vault },
    milestones,
    audit: state.audit || [],
    committed,
    available: state.available ?? Math.max(0, round2(liquid + vault - committed))
  };
}

async function rpc(method, params = []) {
  const response = await fetch(ARC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000)
  });
  const json = await response.json();
  if (json.error || typeof json.result !== 'string') throw new Error(json.error?.message || 'Bad RPC response');
  return json.result;
}

async function readUsdc(address) {
  try {
    const raw = await rpc('eth_call', [{ to: USDC, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']);
    return Number(BigInt(raw)) / 1e6;
  } catch { return null; }
}

/* ---------- Feedback ---------- */
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
function formError(form, message) {
  const el = $('[data-error]', form);
  el.textContent = message || '';
  el.hidden = !message;
}
function busy(button, label) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = false; button.innerHTML = original; };
}
function setSpinning(on) { $$('[data-refresh]').forEach(b => b.classList.toggle('spinning', on)); }

/* ---------- Data loading ---------- */
async function refresh() {
  setSpinning(true);
  try {
    const next = await request(endpoint('/api/state'));
    data = normalise(next);
    serverMode = next.mode || serverMode;
    offline = false;
    lastSync = new Date();
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    offline = true;
    offlineReason = error.message;
    if (!data && !workspaceSlug) {
      // Read-only fallback: the demo wallet's real balance, straight from Arc.
      const liquid = await readUsdc(DEMO_WALLET);
      data = normalise({ wallet: { address: DEMO_WALLET, vaultAddress: DEMO_VAULT, liquid: liquid ?? 0, vault: 0 }, milestones: [], audit: [] });
      data.chainOnly = true;
    }
  } finally {
    setSpinning(false);
  }
  render();
}

/* ---------- Rendering ---------- */
const STATUS = {
  in_progress: ['Waiting on delivery', ''],
  awaiting_verification: ['Waiting for approval', ''],
  verified: ['Approved, not sent', 'warn'],
  checking: ['Screening', 'busy'],
  withdrawing: ['Withdrawing from vault', 'busy'],
  sending: ['Sending', 'busy'],
  confirming: ['Confirming on Arc', 'busy'],
  needs_reconciliation: ['Needs reconciliation', 'warn'],
  review: ['Held for review', 'warn'],
  blocked: ['Blocked', 'bad'],
  paid: ['Paid', 'ok']
};
const STAGES = ['Created', 'Approved', 'Screened', 'Paid'];
function stages(m) {
  switch (m.status) {
    case 'in_progress':
    case 'awaiting_verification': return ['done', 'now', '', ''];
    case 'verified': return ['done', 'done', m.risk?.verdict === 'UNAVAILABLE' ? 'warn' : '', ''];
    case 'checking': return ['done', 'done', 'now', ''];
    case 'withdrawing':
    case 'sending':
    case 'confirming': return ['done', 'done', 'done', 'now'];
    case 'needs_reconciliation': return ['done', 'done', 'done', 'warn'];
    case 'review': return ['done', 'done', 'warn', ''];
    case 'blocked': return ['done', 'done', 'bad', ''];
    case 'paid': return ['done', 'done', 'done', 'done'];
    default: return ['done', '', '', ''];
  }
}

function actionsFor(m) {
  const out = [];
  if (m.risk) out.push(`<button class="mini" data-proof="m:${esc(m.id)}">Verdict</button>`);
  if (['in_progress', 'awaiting_verification'].includes(m.status)) out.push(`<button class="btn btn-ink btn-sm" data-action="verify" data-id="${esc(m.id)}">Approve</button>`);
  if (m.status === 'verified') out.push(`<button class="btn btn-accent btn-sm" data-action="release" data-id="${esc(m.id)}">Release</button>`);
  if (m.status === 'needs_reconciliation' && serverMode === 'live') out.push(`<button class="btn btn-sm" data-action="reconcile" data-id="${esc(m.id)}">Reconcile</button>`);
  if (m.status === 'paid' && m.txHash && serverMode === 'live') out.push(`<a class="mini" href="${EXPLORER}/tx/${esc(m.txHash)}" target="_blank" rel="noopener">View tx</a>`);
  return out.join('');
}

function noteFor(m, detailed) {
  const parts = [];
  if (m.status === 'review' || m.status === 'blocked') parts.push(`<b>CompliR</b>${esc(m.risk?.reason || m.risk?.verdict || '')}`);
  else if (m.risk?.verdict === 'UNAVAILABLE') parts.push(`<b>Screening failed</b>${esc(m.risk.reason)}`);
  if (m.releaseError) parts.push(`<b>Stopped</b>${esc(m.releaseError)}`);
  if (detailed && m.description) parts.push(`<b>Notes</b>${esc(m.description)}`);
  if (detailed && m.evidence) parts.push(`<b>Approved because</b>${esc(m.evidence)}`);
  return parts.length ? `<p class="m-note">${parts.join('<br>')}</p>` : '';
}

function milestoneHtml(m, i, detailed = false) {
  const [label, tone] = STATUS[m.status] || [m.status, ''];
  const track = stages(m).map((cls, n) => `<span class="pip ${cls}">${STAGES[n]}</span>`).join('');
  return `<article class="m-row" style="--i:${i}">
    <div>
      <p class="m-title">${esc(m.title)}</p>
      <p class="m-sub"><span>${esc(m.contractor)}</span><button class="addr-btn" data-copy="${esc(m.address)}" title="Copy address">${esc(short(m.address))}</button>${m.createdAt ? `<span>· ${esc(when(m.createdAt))}</span>` : ''}</p>
    </div>
    <p class="m-amt mono">${money(m.amount)}<span>USDC</span></p>
    ${noteFor(m, detailed)}
    <div class="m-bottom">
      <div class="track" aria-label="Progress: ${esc(label)}">${track}</div>
      <div class="m-actions"><span class="status ${tone}">${esc(label)}</span>${actionsFor(m)}</div>
    </div>
  </article>`;
}

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M7 17 17 7M9 7h8v8"/>',
  shield: '<path d="M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6C5 17.5 12 21 12 21z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  down: '<path d="M12 4v12M7 11l5 5 5-5"/>',
  up: '<path d="M12 20V8M7 13l5-5 5 5"/>'
};
function activityLook(a) {
  const verdict = a.risk?.verdict;
  switch (a.type) {
    case 'payment':
    case 'payment_reconciled': return ['arrow', 'ok'];
    case 'risk_check': return ['shield', verdict === 'LOW' ? 'ok' : verdict === 'MEDIUM' ? 'warn' : 'bad'];
    case 'milestone_verified': return ['check', ''];
    case 'milestone_created': return ['plus', ''];
    case 'vault_deposit': return ['down', ''];
    case 'vault_withdrawal': return ['up', ''];
    case 'release_failed':
    case 'release_uncertain':
    case 'risk_unavailable': return ['alert', 'warn'];
    default: return ['plus', ''];
  }
}
function txLink(hash, simulated) {
  if (!hash) return '';
  return simulated ? `${esc(short(hash))} (simulated)` : `<a href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>`;
}
function activityHtml(a, i, detailed = false) {
  const [icon, tone] = activityLook(a);
  let extra = '';
  if (detailed) {
    const rows = [];
    if (a.txHash) rows.push(['Transaction', txLink(a.txHash, a.simulated)]);
    if (a.withdrawTxHash) rows.push(['Vault withdrawal', txLink(a.withdrawTxHash, a.simulated)]);
    if (a.risk) rows.push(['Verdict', `${esc(a.risk.verdict)} · ${a.risk.signatureVerified ? 'signature checked' : a.risk.source === 'simulated' ? 'simulated' : 'unsigned'} <button class="mini" data-proof="a:${esc(a.id)}">Details</button>`]);
    if (a.evidence) rows.push(['Approval notes', esc(a.evidence)]);
    if (a.yieldSnapshot !== undefined) rows.push(['Yield at release', a.yieldSnapshot === null ? 'not reported' : `${money(a.yieldSnapshot)} USDC`]);
    if (a.redeemed) rows.push(['Drawn from vault', `${money(a.redeemed)} USDC`]);
    if (rows.length) extra = `<dl class="act-extra">${rows.map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }
  return `<div class="act" style="--i:${i}">
    <span class="act-ico ${tone}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg></span>
    <div><p class="act-title">${esc(a.title)}</p><p class="act-detail">${esc(a.detail)}</p>${extra}</div>
    <span class="act-time">${esc(when(a.at))}</span>
  </div>`;
}

function emptyHtml(kind) {
  if (kind === 'milestones') return `<div class="empty"><span class="empty-art"></span><h3>Nothing in the queue</h3><p>Create a milestone for the next piece of work. The amount is set aside until you approve it.</p><button class="btn btn-ink btn-sm" data-new>New milestone</button></div>`;
  if (kind === 'filtered') return `<div class="empty compact"><p>No milestones match this filter.</p></div>`;
  if (kind === 'offline') return `<div class="empty compact"><p>Milestones load from the iPay server, which isn't responding.</p></div>`;
  return `<div class="empty compact"><p>Nothing recorded yet. Approvals, screenings and payments show up here as they happen.</p></div>`;
}

function animateNumber(el, to) {
  const from = shownTotal;
  shownTotal = to;
  el.classList.remove('skeleton');
  if (reduceMotion || Math.abs(to - from) < 0.005) { el.textContent = money(to); return; }
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / 700);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = money(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setBar(id, parts, label) {
  const bar = $(id);
  const total = parts.reduce((s, p) => s + p, 0);
  [...bar.children].forEach((seg, i) => { seg.style.width = total > 0 ? `${(parts[i] / total) * 100}%` : '0%'; });
  bar.setAttribute('aria-label', label);
}

function renderBanner() {
  const banner = $('#banner');
  let html = '';
  let cls = '';
  if (offline) {
    cls = 'bad';
    html = `<div><strong>The iPay server isn't responding.</strong> ${esc(offlineReason)}.${data?.chainOnly ? ' The wallet balance below is read straight from Arc.' : ''} Actions are paused until it's back.</div><button class="btn btn-sm" data-refresh>Retry</button>`;
  } else if (serverMode === 'demo') {
    html = '<div><strong>Demo server.</strong> Screening and payments here are simulated. No USDC moves on Arc.</div>';
  } else if (workspaceSlug && data && !data.wallet?.address) {
    html = `<div><strong>This workspace has no wallet yet.</strong> Finish setup to create one.</div><a class="btn btn-sm" href="/onboard.html">Finish setup</a>`;
  }
  banner.className = `banner ${cls}`;
  banner.innerHTML = html;
  banner.hidden = !html;
}

function render() {
  renderBanner();
  const modeText = offline ? 'Offline' : serverMode === 'live' ? 'Live · Arc Testnet' : serverMode === 'demo' ? 'Demo server' : 'Connecting';
  $('#ws-mode').textContent = modeText;
  $$('[data-mode-text]').forEach(el => el.textContent = modeText);
  $('#synced').textContent = lastSync && !offline ? `Synced ${lastSync.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';

  if (data) {
    const { liquid, vault } = data.wallet;
    const total = liquid + vault;
    animateNumber($('#total'), total);
    $('#total-sub').textContent = data.chainOnly ? 'Wallet balance read from Arc. Vault and commitments unavailable.' : `${money(data.available)} USDC free after ${money(data.committed)} committed to open milestones.`;
    $('#liquid').textContent = money(liquid);
    $('#vault').textContent = data.chainOnly ? '–' : money(vault);
    $('#yield').textContent = data.wallet.yieldEarned ? `${money(data.wallet.yieldEarned)} earned` : '';
    $('#committed').textContent = data.chainOnly ? '–' : money(data.committed);
    $('#available').textContent = data.chainOnly ? '–' : money(data.available);
    setBar('#bar-where', [liquid, vault], `Liquid ${money(liquid)}, in vault ${money(vault)}`);
    setBar('#bar-for', [Math.min(data.committed, total), Math.max(0, total - data.committed)], `Committed ${money(data.committed)}, free ${money(data.available)}`);

    const walletAddr = data.wallet.address;
    const vaultAddr = data.wallet.vaultAddress || data.vaultAddress || (workspaceSlug ? null : DEMO_VAULT);
    $('#acct-wallet-bal').textContent = `${money(liquid)} USDC`;
    $('#acct-wallet-addr').textContent = walletAddr ? short(walletAddr) : 'No wallet yet';
    const link = $('#acct-wallet-link');
    link.hidden = !walletAddr;
    if (walletAddr) link.href = `${EXPLORER}/address/${walletAddr}`;
    $('[data-copy-wallet]').hidden = !walletAddr;
    $('#acct-vault-bal').textContent = data.chainOnly ? '–' : `${money(vault)} USDC`;
    $('#acct-vault-addr').textContent = vaultAddr ? short(vaultAddr) : 'No vault yet';
    $('#acct-vault-note').textContent = serverMode === 'live' ? (data.wallet.yieldEarned === null || data.wallet.yieldEarned === undefined ? 'Yield not reported by Earn Kit yet.' : `Yield earned so far: ${money(data.wallet.yieldEarned)} USDC.`) : '';
  }

  const milestones = data?.milestones || [];
  const audit = data?.audit || [];
  const openCount = milestones.filter(m => !isClosed(m)).length;
  $$('[data-count]').forEach(el => { el.textContent = openCount; if (el.classList.contains('badge')) el.hidden = !openCount; });

  const queue = milestones.filter(m => !isClosed(m)).slice(0, 5);
  $('#queue-list').innerHTML = queue.length ? queue.map((m, i) => milestoneHtml(m, i)).join('')
    : offline && !milestones.length ? emptyHtml('offline')
    : milestones.length ? '<div class="empty compact"><p>Everything is paid or closed. Nice.</p></div>'
    : emptyHtml('milestones');

  const filtered = milestones.filter(m => filter === 'all' || (filter === 'open' && !isClosed(m)) || (filter === 'closed' && isClosed(m)) || (filter === 'attention' && needsYou(m)));
  $('#milestone-list').innerHTML = filtered.length ? filtered.map((m, i) => milestoneHtml(m, i, true)).join('')
    : milestones.length ? emptyHtml('filtered') : offline ? emptyHtml('offline') : emptyHtml('milestones');

  $('#recent-list').innerHTML = audit.length ? audit.slice(0, 5).map((a, i) => activityHtml(a, i)).join('') : emptyHtml('audit');
  $('#audit-list').innerHTML = audit.length ? audit.map((a, i) => activityHtml(a, i, true)).join('') : emptyHtml('audit');
  $('#export-csv').hidden = !workspaceSlug || !audit.length;
}

function setView(next, push = true) {
  if (!VIEWS[next]) next = 'overview';
  view = next;
  for (const name of Object.keys(VIEWS)) $(`#view-${name}`).hidden = name !== view;
  $$('.side-nav [data-view], .tabbar [data-view]').forEach(el => {
    if (el.dataset.view === view) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  $('#page-title').textContent = VIEWS[view];
  $('#crumb-view').textContent = VIEWS[view];
  document.title = `iPay · ${VIEWS[view]}`;
  if (push) history.replaceState(null, '', `${location.pathname}${location.search}${view === 'overview' ? '' : `#${view}`}`);
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* ---------- Auth gate ---------- */
function needsKey() { return Boolean(workspaceSlug || serverMode === 'live') && !token; }
function openAuth(message) {
  const form = $('#auth-form');
  formError(form, message);
  $('#auth-dialog').showModal();
  $('input', form).focus();
}
function guarded(action) {
  if (offline) return toast('The server is offline. Try again once it reconnects.', true);
  if (needsKey()) { pendingAction = action; return openAuth(); }
  return action();
}
function handleAuthError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  if (error.status === 401) {
    token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    openAuth('Your key was not accepted. Paste it again.');
  } else toast('Your key does not have permission for that.', true);
  return true;
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = new FormData(form).get('token')?.trim();
  if (!value) return;
  const done = busy($('button[type=submit]', form), 'Checking…');
  token = value;
  try {
    if (workspaceSlug) {
      await refresh();
      if (offline) throw new ApiError(offlineReason, 0);
    } else {
      await request('/api/workspaces');
    }
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
    form.reset();
    formError(form, '');
    $('#auth-dialog').close();
    toast('Unlocked.');
    const next = pendingAction;
    pendingAction = null;
    if (next) next();
  } catch (error) {
    token = '';
    formError(form, error.status === 401 || error.status === 403 ? 'That key was not accepted.' : error.message);
  } finally { done(); }
});

/* ---------- Actions ---------- */
function openCreate() {
  formError($('#create-form'), '');
  $('#create-dialog').showModal();
}

function openVerify(m) {
  activeId = m.id;
  $('#verify-summary').innerHTML = `<strong>${esc(m.title)}</strong><span class="s-amt">${money(m.amount)}</span><small>${esc(m.contractor)} · ${esc(short(m.address))}</small>`;
  formError($('#verify-form'), '');
  $('#verify-dialog').showModal();
}

function outcomeMessage(m) {
  switch (m?.status) {
    case 'paid': return ['Screened low and paid on Arc.', false];
    case 'review': return ['CompliR returned medium. The payment is held for your review.', true];
    case 'blocked': return ['CompliR returned high. The payment was blocked.', true];
    case 'needs_reconciliation': return ['The payment was sent but not confirmed. Reconcile it from the milestone.', true];
    case 'verified': return [m.risk?.verdict === 'UNAVAILABLE' ? 'Approved, but screening was unavailable. Try releasing again.' : 'Approved, but the release did not go through. Check the audit trail.', true];
    default: return ['Approved.', false];
  }
}

async function release(m, button) {
  const done = busy(button, 'Releasing…');
  try {
    data = normalise(await request(endpoint(`/api/milestones/${m.id}/release`), { method: 'POST', body: '{}' }));
    render();
    const [message, warn] = outcomeMessage(data.milestones.find(x => x.id === m.id));
    toast(message, warn);
  } catch (error) {
    if (!handleAuthError(error)) toast(error.message, true);
    await refresh().catch(() => {});
  } finally { done(); }
}

function openReconcile(m) {
  activeId = m.id;
  const form = $('#reconcile-form');
  formError(form, '');
  // Workspace reconciliation uses the hash iPay already recorded; the main treasury asks for it.
  const askHash = !workspaceSlug;
  $('#reconcile-tx-field').hidden = !askHash;
  $('input[name=txHash]', form).required = askHash;
  $('#reconcile-intro').textContent = askHash
    ? 'The release stopped before iPay could confirm it. Paste the Arc transaction that paid this milestone and iPay will check it on chain.'
    : `iPay will look up ${m.txHash ? short(m.txHash) : 'the recorded transaction'} on Arc and mark the milestone paid if it matches.`;
  $('#reconcile-dialog').showModal();
}

function findRisk(ref) {
  const [kind, id] = ref.split(':');
  return kind === 'm' ? data?.milestones.find(m => m.id === id)?.risk : data?.audit.find(a => a.id === id)?.risk;
}
function openProof(risk) {
  if (!risk) return;
  const msg = risk.signedProof?.typedData?.message;
  const rows = [
    ['Verdict', `<strong style="color:var(${risk.verdict === 'LOW' ? '--accent' : risk.verdict === 'MEDIUM' ? '--amber' : '--red'})">${esc(risk.verdict)}</strong>`],
    ['Reason', esc(risk.rationale || risk.reason || '–')],
    ['Screened', esc(when(risk.checkedAt)) || '–'],
    ['Signature', risk.signatureVerified ? 'Checked against the CompliR attester' : risk.source === 'simulated' ? 'None (simulated on the demo server)' : 'Not verified'],
    ['Source', esc(risk.source || '–')]
  ];
  if (risk.decisionId) rows.push(['Decision ID', `<span class="mono">${esc(risk.decisionId)}</span>`]);
  if (risk.signedProof?.attester) rows.push(['Attester', `<span class="mono">${esc(risk.signedProof.attester)}</span>`]);
  if (msg?.score !== undefined) rows.push(['Score', esc(msg.score)]);
  if (msg?.validUntil) rows.push(['Valid until', esc(when(Number(msg.validUntil) * 1000))]);
  if (msg?.decisionHash) rows.push(['Decision hash', `<span class="mono">${esc(msg.decisionHash)}</span>`]);
  $('#proof-content').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const copy = $('#proof-copy');
  copy.hidden = !risk.signedProof;
  copy.onclick = () => copyText(JSON.stringify(risk.signedProof, null, 2), 'Signed proof copied.');
  $('#proof-dialog').showModal();
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast('Copy failed. Your browser blocked clipboard access.', true); }
}

async function exportCsv(button) {
  const done = busy(button, 'Exporting…');
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceSlug)}/audit.csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new ApiError((await response.json().catch(() => ({}))).error || 'Export failed', response.status);
    const url = URL.createObjectURL(await response.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `${workspaceSlug}-ipay-audit.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (!handleAuthError(error)) toast(error.message, true);
  } finally { done(); }
}

document.addEventListener('click', event => {
  const target = event.target;
  const viewBtn = target.closest('[data-view]');
  if (viewBtn) return setView(viewBtn.dataset.view);
  if (target.closest('[data-new]')) return guarded(openCreate);
  if (target.closest('[data-refresh]')) return refresh().then(() => !offline && toast('Up to date.')).catch(error => handleAuthError(error) || toast(error.message, true));
  if (target.closest('[data-close]')) return target.closest('dialog').close();
  if (target.closest('[data-copy-wallet]')) return data?.wallet?.address && copyText(data.wallet.address, 'Wallet address copied.');
  if (target.closest('[data-deposit]')) return guarded(() => {
    if (serverMode !== 'live') return toast('Vault deposits only work on a live server.', true);
    const max = Math.max(0, (data?.wallet?.liquid || 0) - 0.1);
    $('#deposit-hint').textContent = `About ${money(max)} USDC can move after the gas reserve.`;
    formError($('#deposit-form'), '');
    $('#deposit-dialog').showModal();
  });
  const copy = target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy, 'Address copied.');
  const proof = target.closest('[data-proof]');
  if (proof) return openProof(findRisk(proof.dataset.proof));
  const filterBtn = target.closest('[data-filter]');
  if (filterBtn) {
    filter = filterBtn.dataset.filter;
    $$('[data-filter]').forEach(b => b.setAttribute('aria-selected', String(b === filterBtn)));
    return render();
  }
  if (target.closest('#export-csv')) return exportCsv(target.closest('#export-csv'));
  const actionBtn = target.closest('[data-action]');
  if (actionBtn) {
    const m = data?.milestones.find(item => item.id === actionBtn.dataset.id);
    if (!m) return;
    const action = actionBtn.dataset.action;
    if (action === 'verify') return guarded(() => openVerify(m));
    if (action === 'release') return guarded(() => release(m, actionBtn));
    if (action === 'reconcile') return guarded(() => openReconcile(m));
  }
});

// Close a dialog by tapping its backdrop
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));

$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  if (data && !data.chainOnly && Number(payload.amount) > data.available) {
    return formError(form, `That's more than the ${money(data.available)} USDC free to allocate.`);
  }
  const done = busy($('button[type=submit]', form), 'Creating…');
  try {
    data = normalise(await request(endpoint('/api/milestones'), { method: 'POST', body: JSON.stringify(payload) }));
    form.reset();
    $('#create-dialog').close();
    render();
    toast('Milestone created.');
  } catch (error) {
    if (handleAuthError(error)) $('#create-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

$('#verify-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const done = busy($('button[type=submit]', form), 'Screening and sending…');
  try {
    data = normalise(await request(endpoint(`/api/milestones/${activeId}/verify`), { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }));
    form.reset();
    $('#verify-dialog').close();
    render();
    const [message, warn] = outcomeMessage(data.milestones.find(m => m.id === activeId));
    toast(message, warn);
  } catch (error) {
    if (handleAuthError(error)) $('#verify-dialog').close();
    else formError(form, error.message);
    refresh().catch(() => {});
  } finally { done(); }
});

$('#deposit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = new FormData(form).get('amount');
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) return formError(form, 'Enter an amount with at most two decimals.');
  const done = busy($('button[type=submit]', form), 'Depositing…');
  try {
    await request(endpoint('/api/earn/deposit'), { method: 'POST', body: JSON.stringify({ amount }) });
    form.reset();
    $('#deposit-dialog').close();
    await refresh();
    toast(`${amount} USDC moved into the Earn vault.`);
  } catch (error) {
    if (handleAuthError(error)) $('#deposit-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

$('#reconcile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const done = busy($('button[type=submit]', form), 'Checking on Arc…');
  try {
    data = normalise(await request(endpoint(`/api/milestones/${activeId}/reconcile`), { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }));
    form.reset();
    $('#reconcile-dialog').close();
    render();
    toast('Payment confirmed on Arc.');
  } catch (error) {
    if (handleAuthError(error)) $('#reconcile-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

/* ---------- Network status ---------- */
async function pollNetwork() {
  try {
    const block = Number(BigInt(await rpc('eth_blockNumber')));
    $$('[data-net-dot]').forEach(d => d.className = 'dot live');
    $$('[data-net-text]').forEach(t => t.textContent = `Arc Testnet · #${block.toLocaleString('en-US')}`);
  } catch {
    $$('[data-net-dot]').forEach(d => d.className = 'dot bad');
    $$('[data-net-text]').forEach(t => t.textContent = 'Arc unreachable');
  }
}

/* ---------- Boot ---------- */
async function boot() {
  if (workspaceSlug) {
    $('#ws-name').textContent = workspaceSlug;
    $('#ws-avatar').textContent = workspaceSlug[0].toUpperCase();
    $('#crumb-ws').textContent = workspaceSlug;
    $('#auth-intro').textContent = `Paste the owner or team key for "${workspaceSlug}". It stays in this browser tab and is cleared when you close it.`;
  }
  setView(location.hash.slice(1) || 'overview', false);
  pollNetwork();
  setInterval(() => { if (!document.hidden) pollNetwork(); }, 15_000);

  try {
    const config = await request('/api/config');
    serverMode = config.mode;
  } catch (error) {
    offline = true;
    offlineReason = error.message;
  }

  if (workspaceSlug && !token) {
    render();
    return openAuth();
  }
  try { await refresh(); }
  catch (error) { if (!handleAuthError(error)) toast(error.message, true); render(); }

  // Keep balances current while the tab is visible and nothing is being edited.
  setInterval(() => {
    if (document.hidden || $('dialog[open]')) return;
    refresh().catch(() => {});
  }, 30_000);
}

window.addEventListener('hashchange', () => setView(location.hash.slice(1) || 'overview', false));
boot();
