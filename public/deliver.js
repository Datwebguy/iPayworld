const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const query = { workspace: params.get('workspace') || '', milestone: params.get('milestone') || '', token: params.get('token') || '' };
const dollars = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let polling;

async function call(options) {
  const url = options ? '/api/deliver' : `/api/deliver?${new URLSearchParams(query)}`;
  const response = await fetch(url, options && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...query, ...options }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || 'Something went wrong'); error.status = response.status; throw error; }
  return payload;
}

function showResult(view) {
  const badge = $('#result-badge');
  const text = $('#result-text');
  const decision = view.agentDecision;
  let tone = '';
  let label = '';
  let message = '';
  switch (view.status) {
    case 'delivered':
    case 'verified':
    case 'checking':
    case 'withdrawing':
    case 'sending':
    case 'confirming':
      tone = 'busy'; label = view.status === 'delivered' ? 'Agent reviewing' : 'Approved, paying now';
      message = view.status === 'delivered' ? 'Your delivery is in. The payments agent is reviewing it now. This page updates by itself.' : decision?.reason || 'Your work was approved and the payment is being sent.';
      break;
    case 'paid':
      tone = 'ok'; label = 'Paid';
      message = `${dollars(view.amount)} was sent to your wallet.${decision?.reason ? ` ${decision.reason}` : ''}${view.txHash ? ` <a href="https://explorer.testnet.arc.io/tx/${view.txHash}" target="_blank" rel="noopener">View receipt ↗</a>` : ''}`;
      break;
    case 'awaiting_verification':
      tone = 'warn'; label = 'With the business for approval';
      message = decision?.reason || 'The business will review your delivery.';
      break;
    case 'in_progress':
      tone = 'warn'; label = 'Changes requested';
      message = `${decision?.reason || 'The business asked for changes.'} Update your work and submit again below.`;
      break;
    case 'review':
    case 'blocked':
      tone = 'warn'; label = 'Payment on hold';
      message = 'The payment is on hold after a routine compliance check. The business will be in touch.';
      break;
    default:
      label = 'Submitted'; message = 'Your delivery was received.';
  }
  badge.className = `result-badge ${tone}`;
  badge.textContent = label;
  text.innerHTML = message;
  $('#result').hidden = false;
  // Contractors can resubmit after a change request; otherwise the form is done.
  $('#deliver-form').hidden = view.status !== 'in_progress' && view.status !== 'awaiting_verification' || (view.status === 'awaiting_verification' && Boolean(view.delivery));
  const settled = ['paid', 'awaiting_verification', 'in_progress', 'review', 'blocked'].includes(view.status);
  if (!settled && !polling) polling = setInterval(refresh, 3000);
  if (settled && polling) { clearInterval(polling); polling = null; }
}

async function refresh() {
  try { showResult(await call()); } catch {}
}

async function load() {
  try {
    const view = await call();
    $('#from').textContent = `Milestone for ${view.business}`;
    $('#title').textContent = view.title;
    $('#contractor').textContent = view.contractor;
    $('#amount').textContent = dollars(view.amount);
    $('#due').textContent = view.dueDate ? `Due ${new Date(`${view.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'No due date';
    if (view.scope) { $('#scope').hidden = false; $('#scope span').textContent = view.scope; }
    $('#loading').hidden = true;
    $('#content').hidden = false;
    if (view.delivery || view.status !== 'in_progress') showResult(view);
  } catch {
    $('#loading').hidden = true;
    $('#invalid').hidden = false;
  }
}

$('#deliver-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('[data-error]', form) || form.querySelector('[data-error]');
  error.hidden = true;
  const note = form.note.value.trim();
  if (note.length < 10) { error.textContent = 'Describe what you delivered in a sentence or two.'; error.hidden = false; return; }
  const button = form.querySelector('button');
  button.disabled = true;
  button.textContent = 'Submitting…';
  try {
    showResult(await call({ note, link: form.link.value.trim() }));
    form.reset();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Submit for payment';
  }
});

load();
