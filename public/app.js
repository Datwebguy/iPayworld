const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const params = new URLSearchParams(location.search);
const workspaceSlug = params.get('workspace');
// The server's own single treasury, for the operator only. Every user works inside a workspace.
const operatorMode = !workspaceSlug && params.has('operator');
const TOKEN_KEY = workspaceSlug ? `ipay-owner-token:${workspaceSlug}` : 'ipay-owner-token';
const LAST_KEY = 'ipay-last-workspace';
// Network details come from /api/config at boot; these are the testnet defaults.
let ARC_RPC = 'https://rpc.testnet.arc.io';
let EXPLORER = 'https://explorer.testnet.arc.io';
let TESTNET = true;
const VIEWS = { overview: 'Overview', milestones: 'Milestones', activity: 'Audit trail' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Earlier builds cached locally invented milestones and payments here. Drop them.
try { localStorage.removeItem('ipay_enclave_state'); } catch {}

const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = value => usd.format(Number(value) || 0);
const dollars = value => `$${money(value)}`;
const round2 = value => Math.round(value * 100) / 100;
const short = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '–';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};
const isClosed = m => ['paid', 'blocked'].includes(m.status);
const needsYou = m => ['awaiting_verification', 'verified', 'review', 'needs_reconciliation'].includes(m.status);

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
  } finally {
    setSpinning(false);
  }
  render();
}

/* ---------- Rendering ---------- */
const STATUS = {
  in_progress: ['Waiting on delivery', ''],
  delivered: ['Agent reviewing', 'busy'],
  awaiting_verification: ['Needs your approval', 'warn'],
  verified: ['Approved, not paid yet', 'warn'],
  checking: ['Checking contractor', 'busy'],
  withdrawing: ['Moving from savings', 'busy'],
  sending: ['Paying', 'busy'],
  confirming: ['Confirming payment', 'busy'],
  needs_reconciliation: ['Payment unconfirmed', 'warn'],
  review: ['Held for review', 'warn'],
  blocked: ['Blocked', 'bad'],
  paid: ['Paid', 'ok']
};
const STAGES = ['Delivered', 'Approved', 'Checked', 'Paid'];
const RISK = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk', UNAVAILABLE: 'Check unavailable' };
function stages(m) {
  switch (m.status) {
    case 'in_progress': return [m.changeRequests ? 'warn' : '', '', '', ''];
    case 'delivered': return ['done', 'now', '', ''];
    case 'awaiting_verification': return [m.delivery ? 'done' : '', 'warn', '', ''];
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
  if (m.risk) out.push(`<button class="mini" data-proof="m:${esc(m.id)}">Risk check</button>`);
  if (m.deliveryToken && workspaceSlug && ['in_progress', 'awaiting_verification'].includes(m.status)) out.push(`<button class="mini" data-copy="${esc(deliveryLink(m))}" data-copy-msg="Link copied. Send it to ${esc(m.contractor)} so they can submit their work.">Contractor link</button>`);
  if (['in_progress', 'awaiting_verification', 'delivered'].includes(m.status)) out.push(`<button class="btn btn-ink btn-sm" data-action="verify" data-id="${esc(m.id)}">${m.status === 'awaiting_verification' ? 'Approve and pay' : 'Approve work'}</button>`);
  if (m.status === 'verified') out.push(`<button class="btn btn-accent btn-sm" data-action="release" data-id="${esc(m.id)}">Pay now</button>`);
  if (m.status === 'needs_reconciliation' && serverMode === 'live') out.push(`<button class="btn btn-sm" data-action="reconcile" data-id="${esc(m.id)}">Confirm payment</button>`);
  if (m.status === 'paid' && m.txHash && serverMode === 'live' && EXPLORER) out.push(`<a class="mini" href="${EXPLORER}/tx/${esc(m.txHash)}" target="_blank" rel="noopener">Receipt ↗</a>`);
  return out.join('');
}

function deliveryLink(m) {
  return `${location.origin}/deliver?${new URLSearchParams({ workspace: workspaceSlug, milestone: m.id, token: m.deliveryToken })}`;
}

const AGENT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
function agentNote(m) {
  const d = m.agentDecision;
  if (!d) return '';
  const label = { pay: 'Agent approved', hold: 'Agent wants you to look', request_changes: 'Agent asked for changes' }[d.action] || 'Agent';
  return `<p class="m-agent ${d.action === 'pay' ? '' : 'warn'}">${AGENT_ICON}<span><b>${label}.</b>${esc(d.reason)}</span></p>`;
}

function noteFor(m, detailed) {
  const parts = [];
  if (detailed && m.delivery) parts.push(`<b>Delivered</b>${esc(m.delivery.note)}${m.delivery.link ? ` <a href="${esc(m.delivery.link)}" target="_blank" rel="noopener nofollow">Open ↗</a>` : ''}`);
  if (detailed && m.dueDate) parts.push(`<b>Due</b>${esc(new Date(`${m.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}`);
  if (m.status === 'review' || m.status === 'blocked') parts.push(`<b>${RISK[m.risk?.verdict] || 'Risk check'}</b>${esc(m.risk?.rationale || m.risk?.reason || '')}`);
  else if (m.risk?.verdict === 'UNAVAILABLE') parts.push(`<b>Risk check failed</b>The checking service did not answer. Try paying again in a minute.`);
  if (m.releaseError) parts.push(`<b>Payment stopped</b>${esc(m.releaseError)}`);
  if (detailed && m.description) parts.push(`<b>Done means</b>${esc(m.description)}`);
  if (detailed && m.evidence) parts.push(`<b>Approved because</b>${esc(m.evidence)}`);
  return parts.length ? `<p class="m-note">${parts.join('<br>')}</p>` : '';
}

function milestoneHtml(m, i, detailed = false) {
  const [label, tone] = m.status === 'in_progress' && m.changeRequests ? ['Changes requested', 'warn'] : STATUS[m.status] || [m.status, ''];
  const track = stages(m).map((cls, n) => `<span class="pip ${cls}">${STAGES[n]}</span>`).join('');
  return `<article class="m-row" style="--i:${i}">
    <div>
      <p class="m-title">${esc(m.title)}</p>
      <p class="m-sub"><span>${esc(m.contractor)}</span>${m.createdAt ? `<span>· ${esc(when(m.createdAt))}</span>` : ''}<button class="addr-btn" data-copy="${esc(m.address)}">copy address</button></p>
    </div>
    <p class="m-amt mono">${dollars(m.amount)}</p>
    ${agentNote(m)}
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
  up: '<path d="M12 20V8M7 13l5-5 5 5"/>',
  agent: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/>'
};
function activityLook(a) {
  const verdict = a.risk?.verdict;
  switch (a.type) {
    case 'payment':
    case 'payment_reconciled': return ['arrow', 'ok'];
    case 'risk_check': return ['shield', verdict === 'LOW' ? 'ok' : verdict === 'MEDIUM' ? 'warn' : 'bad'];
    case 'milestone_verified': return ['check', ''];
    case 'milestone_created': return ['plus', ''];
    case 'agent_decision': return ['agent', a.action === 'pay' ? 'agent' : 'warn'];
    case 'agent_settings': return ['agent', ''];
    case 'delivery_submitted': return ['down', ''];
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
  if (simulated) return 'Simulated';
  return EXPLORER ? `<a href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener">View receipt ↗</a>` : `<span class="mono">${esc(short(hash))}</span>`;
}

// Plain-language title and detail, built from our own records rather than the server's internal strings.
function describe(a) {
  const m = data?.milestones.find(item => item.id === a.milestoneId);
  const who = m?.contractor || '';
  const what = m?.title || '';
  const amt = m ? dollars(m.amount) : '';
  const verdict = a.risk?.verdict;
  const deposited = a.detail?.match(/[\d.]+/)?.[0];
  switch (a.type) {
    case 'milestone_created': return ['Milestone created', [what, amt].filter(Boolean).join(' · ')];
    case 'delivery_submitted': return ['Work delivered', [who, what].filter(Boolean).join(' · ')];
    case 'agent_decision': return [a.title, a.detail];
    case 'agent_settings': return ['Agent settings changed', a.detail];
    case 'milestone_verified': return ['Work approved', [what, who].filter(Boolean).join(' · ')];
    case 'risk_check': return [`Contractor check: ${(RISK[verdict] || 'done').toLowerCase()}`, verdict === 'LOW' ? `${who || 'Contractor'} cleared for payment` : verdict === 'MEDIUM' ? `Payment to ${who || 'the contractor'} held for your review` : `Payment to ${who || 'the contractor'} blocked`];
    case 'risk_unavailable': return ['Contractor check unavailable', 'Try paying again in a minute'];
    case 'payment': return ['Payment sent', [amt, who && `to ${who}`].filter(Boolean).join(' ')];
    case 'payment_reconciled': return ['Payment confirmed', [amt, who && `to ${who}`].filter(Boolean).join(' ')];
    case 'vault_deposit': return [a.engine ? 'Agent moved money to savings' : 'Moved to savings', [deposited ? dollars(deposited) : '', a.detail?.split(' · ')[1]].filter(Boolean).join(' · ')];
    case 'vault_withdrawal': return [a.engine ? 'Agent moved money from savings' : 'Moved from savings', what ? `For ${what}` : (a.detail?.split(' · ')[1] || '')];
    case 'release_failed': return ['Payment not sent', 'Not enough money in the account'];
    case 'release_uncertain': return ['Payment unconfirmed', 'Confirm it from the milestone'];
    default: return [a.title, ''];
  }
}
function activityHtml(a, i, detailed = false) {
  const [icon, tone] = activityLook(a);
  const [title, detail] = describe(a);
  let extra = '';
  if (detailed) {
    const rows = [];
    if (a.txHash) rows.push(['Payment', txLink(a.txHash, a.simulated)]);
    if (a.withdrawTxHash) rows.push(['From savings', txLink(a.withdrawTxHash, a.simulated)]);
    if (a.risk) rows.push(['Risk check', `${esc(RISK[a.risk.verdict] || a.risk.verdict)} <button class="mini" data-proof="a:${esc(a.id)}">Details</button>`]);
    if (a.evidence) rows.push(['Approval notes', esc(a.evidence)]);
    if (a.yieldSnapshot) rows.push(['Interest earned by then', dollars(a.yieldSnapshot)]);
    if (a.redeemed) rows.push(['Taken from savings', dollars(a.redeemed)]);
    if (rows.length) extra = `<dl class="act-extra">${rows.map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }
  return `<div class="act" style="--i:${i}">
    <span class="act-ico ${tone}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg></span>
    <div><p class="act-title">${esc(title)}</p>${detail ? `<p class="act-detail">${esc(detail)}</p>` : ''}${extra}</div>
    <span class="act-time">${esc(when(a.at))}</span>
  </div>`;
}

function emptyHtml(kind) {
  if (kind === 'milestones') return `<div class="empty"><span class="empty-art"></span><h3>Nothing waiting on you</h3><p>Add a milestone for the next piece of work. The money is set aside and only paid once you approve the result.</p><button class="btn btn-ink btn-sm" data-new>New milestone</button></div>`;
  if (kind === 'filtered') return `<div class="empty compact"><p>No milestones match this filter.</p></div>`;
  if (kind === 'offline') return `<div class="empty compact"><p>Milestones will show here once iPay reconnects.</p></div>`;
  return `<div class="empty compact"><p>Nothing yet. Approvals, checks and payments appear here as they happen.</p></div>`;
}

function animateNumber(el, to) {
  const from = shownTotal;
  shownTotal = to;
  el.classList.remove('skeleton');
  if (reduceMotion || Math.abs(to - from) < 0.005) { el.textContent = dollars(to); return; }
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / 700);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = dollars(from + (to - from) * eased);
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
    html = `<div><strong>iPay can't connect right now.</strong> Your money is safe. Actions are paused until the connection is back.</div><button class="btn btn-sm" data-refresh>Try again</button>`;
  } else if (serverMode === 'demo') {
    html = '<div><strong>Practice mode.</strong> Checks and payments here are simulated. No money moves.</div>';
  } else if (workspaceSlug && data?.wallet?.address && data.wallet.liquid + data.wallet.vault === 0) {
    html = TESTNET
      ? `<div><strong>Your account is empty.</strong> Get 20 free test USDC: copy your address, open the Circle faucet, choose USDC and Arc Testnet, and paste it.</div><button class="btn btn-sm" data-copy-wallet>Copy address</button><a class="btn btn-sm" href="https://faucet.circle.com/" target="_blank" rel="noopener">Open faucet ↗</a>`
      : `<div><strong>Your account is empty.</strong> Send USDC on Arc to your account address to start paying contractors.</div><button class="btn btn-sm" data-copy-wallet>Copy address</button>`;
  } else if (workspaceSlug && data && !data.wallet?.address) {
    html = `<div><strong>Your payments account isn't set up yet.</strong> Finish setup to create it.</div><a class="btn btn-sm" href="/onboard">Finish setup</a>`;
  }
  banner.className = `banner ${cls}`;
  banner.innerHTML = html;
  banner.hidden = !html;
}

function renderAgent() {
  const panel = $('#agent-panel');
  const agent = data?.agent;
  panel.hidden = !agent || !workspaceSlug;
  if (panel.hidden) return;
  const { settings, lastRun, engine } = agent;
  const reviewing = (data.milestones || []).some(m => m.status === 'delivered');
  $('#agent-enabled').checked = settings.enabled;
  $('#agent-dot').className = `agent-dot ${reviewing ? 'busy' : settings.enabled ? 'on' : ''}`;
  if (document.activeElement !== $('#agent-limit')) $('#agent-limit').value = settings.autoPayLimit;
  const ENGINE = { claude: 'Claude', openai: 'OpenAI' };
  const brain = ENGINE[engine] ? `Decisions by ${ENGINE[engine]}` : 'Decisions by built-in rules';
  $('#agent-last').innerHTML = reviewing
    ? `<strong>Reviewing a delivery now…</strong><small>${brain}</small>`
    : lastRun
      ? `<strong>${esc(lastRun.summary)}</strong>${lastRun.treasury && lastRun.treasury.action !== 'none' ? `<span>${esc(lastRun.treasury.reason)}</span>` : ''}<small>${esc(when(lastRun.at))} · ${ENGINE[lastRun.engine] ? `Decided by ${ENGINE[lastRun.engine]}` : 'Decided by built-in rules'}${lastRun.note ? ` · ${esc(lastRun.note)}` : ''}</small>`
      : `<strong>${settings.enabled ? 'Waiting for the first delivery.' : 'Paused. Turn it on to let it review and pay.'}</strong><small>${brain}</small>`;
}

function render() {
  renderBanner();
  renderAgent();
  const modeText = offline ? 'Offline' : serverMode === 'live' ? 'Connected' : serverMode === 'demo' ? 'Practice mode' : 'Connecting';
  $('#ws-mode').textContent = modeText;
  $$('[data-mode-text]').forEach(el => el.textContent = modeText);
  $('#synced').textContent = lastSync && !offline ? `Synced ${lastSync.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';

  if (data) {
    const { liquid, vault } = data.wallet;
    const total = liquid + vault;
    animateNumber($('#total'), total);
    $('#total-sub').textContent = data.committed > 0 ? `${dollars(data.available)} not yet assigned. ${dollars(data.committed)} is set aside for open milestones.` : 'Nothing is set aside yet. Add a milestone to reserve money for a piece of work.';
    $('#liquid').textContent = dollars(liquid);
    $('#vault').textContent = dollars(vault);
    $('#yield').textContent = data.wallet.yieldEarned ? `${dollars(data.wallet.yieldEarned)} interest earned` : '';
    $('#committed').textContent = dollars(data.committed);
    $('#available').textContent = dollars(data.available);
    setBar('#bar-where', [liquid, vault], `Ready to pay ${dollars(liquid)}, in savings ${dollars(vault)}`);
    setBar('#bar-for', [Math.min(data.committed, total), Math.max(0, total - data.committed)], `Set aside ${dollars(data.committed)}, not yet assigned ${dollars(data.available)}`);

    const walletAddr = data.wallet.address;
    $('#acct-wallet-bal').textContent = dollars(liquid);
    const link = $('#acct-wallet-link');
    link.hidden = !walletAddr || !EXPLORER;
    if (walletAddr) link.href = `${EXPLORER}/address/${walletAddr}`;
    $('[data-copy-wallet]').hidden = !walletAddr;
    $('#acct-vault-bal').textContent = dollars(vault);
    $('#acct-vault-note').textContent = data.wallet.yieldEarned ? `${dollars(data.wallet.yieldEarned)} interest earned so far.` : '';
  }

  const milestones = data?.milestones || [];
  const audit = data?.audit || [];
  const openCount = milestones.filter(m => !isClosed(m)).length;
  $$('[data-count]').forEach(el => { el.textContent = openCount; if (el.classList.contains('badge')) el.hidden = !openCount; });

  const queue = milestones.filter(m => !isClosed(m)).slice(0, 5);
  $('#queue-list').innerHTML = queue.length ? queue.map((m, i) => milestoneHtml(m, i)).join('')
    : offline && !milestones.length ? emptyHtml('offline')
    : milestones.length ? `<div class="empty compact"><p>You're all caught up. Every milestone is paid or closed.</p><button class="btn btn-sm" data-new>New milestone</button></div>`
    : emptyHtml('milestones');

  const filtered = milestones.filter(m => filter === 'all' || (filter === 'open' && !isClosed(m)) || (filter === 'closed' && isClosed(m)) || (filter === 'attention' && needsYou(m)));
  $('#milestone-list').innerHTML = filtered.length ? filtered.map((m, i) => milestoneHtml(m, i, true)).join('')
    : milestones.length ? emptyHtml('filtered') : offline ? emptyHtml('offline') : emptyHtml('milestones');

  $('#recent-list').innerHTML = audit.length ? audit.slice(0, 5).map((a, i) => activityHtml(a, i)).join('') : emptyHtml('audit');
  $('#audit-list').innerHTML = audit.length ? audit.map((a, i) => activityHtml(a, i, true)).join('') : emptyHtml('audit');
  $('#export-csv').hidden = !workspaceSlug || !audit.length;

  const sum = list => list.reduce((total, m) => total + Number(m.amount || 0), 0);
  const count = n => n === 1 ? '1 milestone' : `${n} milestones`;
  const groups = {
    paid: milestones.filter(m => m.status === 'paid'),
    waiting: milestones.filter(m => ['in_progress', 'awaiting_verification', 'verified', 'needs_reconciliation'].includes(m.status)),
    held: milestones.filter(m => m.status === 'review'),
    blocked: milestones.filter(m => m.status === 'blocked')
  };
  for (const [key, list] of Object.entries(groups)) {
    $(`#stat-${key}`).textContent = dollars(sum(list));
    $(`#stat-${key}-n`).textContent = count(list.length);
  }
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
      await refresh();
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
  $('#verify-summary').innerHTML = `<strong>${esc(m.title)}</strong><span class="s-amt">${dollars(m.amount)}</span><small>${esc(m.contractor)}</small>`;
  formError($('#verify-form'), '');
  $('#verify-dialog').showModal();
}

function outcomeMessage(m) {
  switch (m?.status) {
    case 'paid': return ['Contractor checked and paid.', false];
    case 'review': return ['Medium risk. The payment is held until you review it.', true];
    case 'blocked': return ['High risk. The payment was blocked.', true];
    case 'needs_reconciliation': return ['The payment was sent but not confirmed. Reconcile it from the milestone.', true];
    case 'verified': return [m.risk?.verdict === 'UNAVAILABLE' ? 'Approved, but the contractor check was unavailable. Try paying again in a minute.' : 'Approved, but the payment did not go through. See the history for why.', true];
    case 'checking':
    case 'withdrawing':
    case 'sending':
    case 'confirming': return ['Approved. Checking the contractor and paying now; this updates by itself.', false];
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
    ? 'This payment was sent but iPay could not confirm it arrived. Paste the receipt ID and iPay will check it.'
    : 'iPay will look up the payment it sent and mark the milestone paid once it is confirmed.';
  $('#reconcile-dialog').showModal();
}

function findRisk(ref) {
  const [kind, id] = ref.split(':');
  return kind === 'm' ? data?.milestones.find(m => m.id === id)?.risk : data?.audit.find(a => a.id === id)?.risk;
}
function openProof(risk) {
  if (!risk) return;
  const msg = risk.signedProof?.typedData?.message;
  const tone = risk.verdict === 'LOW' ? '--accent' : risk.verdict === 'MEDIUM' ? '--amber' : '--red';
  const meaning = { LOW: 'Cleared. iPay pays automatically.', MEDIUM: 'Held. You decide whether to pay.', HIGH: 'Blocked. iPay will not pay this address.' }[risk.verdict] || 'The check could not be completed.';
  const rows = [
    ['Result', `<strong style="color:var(${tone})">${esc(RISK[risk.verdict] || risk.verdict)}</strong>`],
    ['What it means', meaning],
    ['Reason', esc(risk.rationale || risk.reason || '–')],
    ['Checked', esc(when(risk.checkedAt)) || '–'],
    ['Authentic', risk.signatureVerified ? 'Yes, signed by the checking service and verified by iPay' : risk.source === 'simulated' ? 'Practice mode, not a real check' : 'Not verified']
  ];
  if (msg?.validUntil) rows.push(['Valid until', esc(when(Number(msg.validUntil) * 1000))]);
  if (risk.decisionId) rows.push(['Reference', `<span class="mono">${esc(risk.decisionId)}</span>`]);
  $('#proof-content').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const copy = $('#proof-copy');
  copy.hidden = !risk.signedProof;
  copy.onclick = () => copyText(JSON.stringify(risk.signedProof, null, 2), 'Full record copied.');
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
  if (target.closest('[data-copy-wallet]')) return data?.wallet?.address && copyText(data.wallet.address, 'Address copied. Send USDC to it to add funds.');
  if (target.closest('[data-deposit]')) return guarded(() => {
    if (serverMode !== 'live') return toast('Savings are not available in practice mode.', true);
    const max = Math.max(0, (data?.wallet?.liquid || 0) - 0.1);
    $('#deposit-hint').textContent = `Up to ${dollars(max)} can move. A little stays behind for fees.`;
    formError($('#deposit-form'), '');
    $('#deposit-dialog').showModal();
  });
  const copy = target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy, copy.dataset.copyMsg || 'Address copied.');
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
  if (data && Number(payload.amount) > data.available) {
    return formError(form, `That's more than the ${dollars(data.available)} you have unassigned.`);
  }
  const done = busy($('button[type=submit]', form), 'Creating…');
  try {
    data = normalise(await request(endpoint('/api/milestones'), { method: 'POST', body: JSON.stringify(payload) }));
    form.reset();
    $('#create-dialog').close();
    render();
    const created = data.milestones[0];
    if (workspaceSlug && created?.deliveryToken) {
      navigator.clipboard.writeText(deliveryLink(created))
        .then(() => toast(`Milestone created. The contractor link is copied: send it to ${created.contractor}.`))
        .catch(() => toast('Milestone created. Use "Contractor link" on it to copy the link for your contractor.'));
    }
    else toast('Milestone created.');
  } catch (error) {
    if (handleAuthError(error)) $('#create-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

$('#verify-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const done = busy($('button[type=submit]', form), 'Checking and paying…');
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
    toast(`${dollars(amount)} moved to savings.`);
  } catch (error) {
    if (handleAuthError(error)) $('#deposit-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

$('#reconcile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const done = busy($('button[type=submit]', form), 'Confirming…');
  try {
    data = normalise(await request(endpoint(`/api/milestones/${activeId}/reconcile`), { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }));
    form.reset();
    $('#reconcile-dialog').close();
    render();
    toast('Payment confirmed.');
  } catch (error) {
    if (handleAuthError(error)) $('#reconcile-dialog').close();
    else formError(form, error.message);
  } finally { done(); }
});

/* ---------- Agent controls ---------- */
async function saveAgent(changes, message) {
  try {
    data = normalise(await request(`/api/workspaces/${encodeURIComponent(workspaceSlug)}/agent`, { method: 'PUT', body: JSON.stringify(changes) }));
    render();
    toast(message);
  } catch (error) {
    if (!handleAuthError(error)) toast(error.message, true);
    render();
  }
}
$('#agent-enabled').addEventListener('change', event => {
  const on = event.currentTarget.checked;
  guarded(() => saveAgent({ enabled: on }, on ? 'Agent is on. It will review deliveries as they arrive.' : 'Agent paused. Deliveries will wait for you.'));
});
$('#agent-limit-form').addEventListener('submit', event => {
  event.preventDefault();
  const limit = Number($('#agent-limit').value);
  if (!Number.isFinite(limit) || limit < 0) return toast('Enter a dollar amount.', true);
  guarded(() => saveAgent({ autoPayLimit: limit }, `The agent can now pay up to ${dollars(limit)} on its own.`));
});
$('#agent-run').addEventListener('click', event => guarded(async () => {
  const done = busy(event.currentTarget, 'Agent working…');
  try {
    data = normalise(await request(`/api/workspaces/${encodeURIComponent(workspaceSlug)}/agent/run`, { method: 'POST', body: '{}' }));
    render();
    toast(data.agent?.lastRun?.summary || 'Agent run finished.');
  } catch (error) {
    if (!handleAuthError(error)) toast(error.message, true);
  } finally { done(); }
}));

/* ---------- Network status ---------- */
async function pollNetwork() {
  try {
    await rpc('eth_blockNumber');
    $$('[data-net-dot]').forEach(d => d.className = 'dot live');
    $$('[data-net-text]').forEach(t => t.textContent = 'Payments network online');
  } catch {
    $$('[data-net-dot]').forEach(d => d.className = 'dot bad');
    $$('[data-net-text]').forEach(t => t.textContent = 'Payments network unreachable');
  }
}

/* ---------- Boot ---------- */
/* ---------- Workspace sign-in (shown when no workspace is in the URL) ---------- */
function showGate() {
  document.body.classList.add('gated');
  $('#gate').hidden = false;
  const form = $('#gate-form');
  let last = '';
  try { last = localStorage.getItem(LAST_KEY) || ''; } catch {}
  if (last) form.slug.value = last;
  (last ? form.token : form.slug).focus();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const slug = form.slug.value.trim().toLowerCase();
    const key = form.token.value.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return formError(form, 'Enter the workspace handle you chose at setup, like acme-studio.');
    if (!key) return formError(form, 'Paste your access key.');
    const done = busy($('button[type=submit]', form), 'Opening…');
    try {
      token = key;
      await request(`/api/workspaces/${encodeURIComponent(slug)}/state`);
      try { sessionStorage.setItem(`ipay-owner-token:${slug}`, key); localStorage.setItem(LAST_KEY, slug); } catch {}
      location.href = `/app?workspace=${encodeURIComponent(slug)}`;
    } catch (error) {
      token = '';
      formError(form, error.status === 401 || error.status === 403 ? "That handle and key don't match a workspace." : error.message);
      done();
    }
  });
}

async function boot() {
  if (!workspaceSlug && !operatorMode) {
    // Returning in the same tab: go straight back to the workspace already unlocked.
    try {
      const last = localStorage.getItem(LAST_KEY);
      if (last && sessionStorage.getItem(`ipay-owner-token:${last}`) && !params.has('switch')) {
        location.replace(`/app?workspace=${encodeURIComponent(last)}`);
        return;
      }
    } catch {}
    return showGate();
  }
  if (workspaceSlug) {
    try { localStorage.setItem(LAST_KEY, workspaceSlug); } catch {}
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
    if (config.network) { ARC_RPC = config.network.rpcUrl; EXPLORER = config.network.explorerUrl; TESTNET = config.network.testnet; }
  } catch (error) {
    offline = true;
    offlineReason = error.message;
  }

  if ((workspaceSlug || serverMode === 'live') && !token) {
    render();
    return openAuth();
  }
  try { await refresh(); }
  catch (error) { if (!handleAuthError(error)) toast(error.message, true); render(); }

  // Keep balances current while the tab is visible and nothing is being edited.
  setInterval(() => {
    if (document.hidden || $('dialog[open]')) return;
    const working = data?.milestones?.some(m => ['delivered', 'checking', 'withdrawing', 'sending', 'confirming'].includes(m.status));
    if (working || Date.now() - (lastSync?.getTime() || 0) > 30_000) refresh().catch(() => {});
  }, 5_000);
}

if (operatorMode) {
  $('#ws-name').textContent = 'Operator treasury';
  $('#ws-avatar').textContent = 'O';
  $('#crumb-ws').textContent = 'Operator';
  $('#auth-intro').textContent = 'This is the server owner\'s own treasury. Paste the admin key to open it.';
}

window.addEventListener('hashchange', () => setView(location.hash.slice(1) || 'overview', false));
boot();
