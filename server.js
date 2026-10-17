import './lib/rpc-alias.js';
import http from 'node:http';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createWorkspaceRegistry } from './lib/workspace-registry.js';
import { createWorkspaceDataStore } from './lib/workspace-data.js';
import { createPostgresWorkspaceStores } from './lib/postgres-workspaces.js';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { fetchVerdict } from './lib/complir.js';
import { readArcWallet } from './lib/arc-wallet.js';
import { readEarnPosition } from './lib/earn-position.js';
import { DEFAULT_AGENT, agentEngine, buildContext, decide } from './lib/agent.js';
import { liveClients, liveBalances, assertUsdcVault, depositToVault, withdrawForRelease, sendPayment, verifyPaymentReceipt } from './lib/live-payments.js';

const root = resolve(import.meta.dirname);
const publicDir = join(root, 'public');
const dataDir = resolve(process.env.IPAY_DATA_DIR || join(root, '.data'));
const port = Number(process.env.PORT || 3000);
const mode = process.env.IPAY_MODE || 'demo';
if (!['demo', 'live'].includes(mode)) throw new Error('IPAY_MODE must be demo or live');
const stateFile = join(dataDir, mode === 'live' ? 'live-state.json' : 'state.json');
const postgresStores = process.env.DATABASE_URL ? createPostgresWorkspaceStores(process.env.DATABASE_URL) : null;
const workspaceRegistry = postgresStores?.registry || createWorkspaceRegistry(dataDir);
const workspaceDataStore = postgresStores?.dataStore || createWorkspaceDataStore(dataDir);
const screeningMode = process.env.COMPLIR_MODE || 'demo';
if (!['demo', 'live'].includes(screeningMode)) throw new Error('COMPLIR_MODE must be demo or live');
if (mode === 'live' && screeningMode !== 'live') throw new Error('Live payments require COMPLIR_MODE=live');
if (mode === 'live' && (!process.env.IPAY_OWNER_TOKEN || process.env.IPAY_OWNER_TOKEN.length < 32)) throw new Error('Set a random IPAY_OWNER_TOKEN of at least 32 characters for live payments');
const clients = mode === 'live' ? liveClients() : null;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
// What the browser needs to know about the network this server pays on.
const network = (() => {
  const mainnet = clients?.config.chain === 'Arc';
  return {
    chain: clients?.config.chain || 'Arc_Testnet',
    testnet: !mainnet,
    rpcUrl: clients?.config.rpcUrl || 'https://rpc.testnet.arc.io',
    explorerUrl: process.env.ARC_EXPLORER_URL || (mainnet ? '' : 'https://explorer.testnet.arc.io')
  };
})();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

function initialState() {
  const defaultWallet = clients?.config?.walletAddress || '0xb3ccbf94b1965844e062bd9ad22df72b9a45ba17';
  const defaultVault = clients?.config?.vaultAddress || '0xaabbef1d3971c710276ed41ec791bbe14cdb8e88';
  return {
    chain: clients?.config?.chain || 'Arc_Testnet',
    vaultAddress: defaultVault,
    wallet: { address: defaultWallet, liquid: 0, vault: 0, yieldEarned: 0, startingBudget: 0 },
    milestones: [],
    audit: []
  };
}

let state;
async function saveState() {
  await mkdir(dataDir, { recursive: true });
  const temp = `${stateFile}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, stateFile);
}
async function loadState() {
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.wallet.usyc !== undefined && state.wallet.vault === undefined) {
      state.wallet.vault = state.wallet.usyc;
      delete state.wallet.usyc;
      await saveState();
    }
    if (mode === 'live') {
      if (state.chain !== clients.config.chain || state.vaultAddress?.toLowerCase() !== clients.config.vaultAddress.toLowerCase()) throw new Error('Live state belongs to a different Arc chain or Earn vault');
      if (state.wallet.address?.toLowerCase() !== clients.config.walletAddress.toLowerCase()) throw new Error('Live state belongs to a different Circle wallet');
      let changed = false;
      for (const m of state.milestones) {
        if (['checking', 'withdrawing', 'sending', 'confirming'].includes(m.status)) { m.status = 'needs_reconciliation'; changed = true; }
      }
      if (changed) await saveState();
    }
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = initialState();
    await saveState();
  }
}

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function failure(status, message) { const error = new Error(message); error.status = status; throw error; }
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) failure(413, 'Request is too large');
  }
  try { return JSON.parse(raw || '{}'); }
  catch { failure(400, 'Invalid JSON'); }
}
function audit(type, title, detail, extra = {}) {
  state.audit.unshift({ id: randomUUID(), type, title, detail, at: new Date().toISOString(), simulated: mode !== 'live', ...extra });
}
function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000 || Math.abs(Math.round(number * 100) - number * 100) > 1e-8) failure(400, 'Enter an amount greater than 0 with at most two decimals');
  return number;
}
function snapshot() {
  const committed = state.milestones.filter(m => !['paid', 'blocked'].includes(m.status)).reduce((sum, m) => sum + m.amount, 0);
  const reserve = mode === 'live' ? Number(clients.config.gasReserveUsdc) : 0;
  return { mode, screeningMode, wallet: { ...state.wallet, vaultAddress: state.vaultAddress }, committed, available: Math.max(0, Math.round((state.wallet.liquid + state.wallet.vault - committed - reserve) * 100) / 100), milestones: state.milestones, audit: state.audit };
}
function requireOwner(req) {
  if (mode !== 'live') return;
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const expected = process.env.IPAY_OWNER_TOKEN;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) failure(401, 'Owner token required');
}
function requireWorkspaceOwner(req, slug) {
  const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const workspace = workspaceRegistry.byOwnerToken(token);
  if (!workspace || workspace.slug !== slug) failure(401, 'Workspace owner authorization required');
  return workspace;
}
function requireWorkspaceRole(req, slug, allowedRoles) {
  const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const access = workspaceRegistry.accessByToken(token);
  if (!access || access.workspace.slug !== slug || !allowedRoles.includes(access.role)) failure(403, 'Workspace permission required');
  return access.workspace;
}
async function refreshLiveWallet() {
  const balances = await liveBalances(clients);
  state.wallet = { address: clients.config.walletAddress, liquid: Number(balances.liquidUsdc), vault: Number(balances.vaultUsdc), yieldEarned: balances.yieldEarned === null ? null : Number(balances.yieldEarned), startingBudget: Number(balances.liquidUsdc) + Number(balances.vaultUsdc) };
  return balances;
}
function milestone(id) { const found = state.milestones.find(m => m.id === id); if (!found) failure(404, 'Milestone not found'); return found; }
function riskCoversReceipt(risk, blockTimestamp) {
  const msg = risk?.signedProof?.typedData?.message;
  return risk?.verdict === 'LOW' && risk.signatureVerified === true && Number(msg?.issuedAt) <= blockTimestamp && blockTimestamp < Number(msg?.validUntil);
}
function tenantAudit(tenantState, type, title, detail, extra = {}) {
  tenantState.audit.unshift({ id: randomUUID(), type, title, detail, at: new Date().toISOString(), simulated: false, ...extra });
}
function assertWorkspacePaymentPolicy(workspace, tenantState, milestoneRecord) {
  const policy = workspace.policy || { maxPerTxUsdc: 5000, maxPerDayUsdc: 25000 };
  if (milestoneRecord.amount > Number(policy.maxPerTxUsdc)) failure(409, 'Payment exceeds the workspace per-transaction limit');
  const today = new Date().toISOString().slice(0, 10);
  const paidToday = tenantState.milestones.filter(item => item.status === 'paid' && item.paidAt?.slice(0, 10) === today).reduce((total, item) => total + Number(item.amount), 0);
  if (paidToday + milestoneRecord.amount > Number(policy.maxPerDayUsdc)) failure(409, 'Payment exceeds the workspace daily limit');
}
async function processWorkspaceLiveRelease(workspace, tenantState, milestoneRecord) {
  const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
  const persist = () => workspaceDataStore.write(workspace, tenantState);
  const amountText = milestoneRecord.amount.toFixed(2);
  await assertUsdcVault(tenantClients);
  milestoneRecord.status = 'checking';
  await persist();
  let risk;
  try { risk = await fetchVerdict(milestoneRecord.address); }
  catch (error) {
    milestoneRecord.status = 'verified';
    milestoneRecord.risk = { verdict: 'UNAVAILABLE', reason: error.message, source: 'complir', checkedAt: new Date().toISOString() };
    tenantAudit(tenantState, 'risk_unavailable', 'Risk check unavailable', `${milestoneRecord.contractor} · ${error.message}`, { milestoneId: milestoneRecord.id, risk: milestoneRecord.risk });
    await persist();
    return;
  }
  milestoneRecord.risk = risk;
  tenantAudit(tenantState, 'risk_check', `Risk check · ${risk.verdict}`, `${milestoneRecord.contractor} · ${risk.reason}`, { milestoneId: milestoneRecord.id, risk });
  if (risk.verdict === 'MEDIUM') { milestoneRecord.status = 'review'; await persist(); return; }
  if (risk.verdict === 'HIGH') { milestoneRecord.status = 'blocked'; await persist(); return; }
  try {
    const { formatUnits, parseUnits } = await import('viem');
    const target = parseUnits(amountText, 6);
    const requiredLiquid = target + parseUnits(tenantClients.config.gasReserveUsdc, 6);
    let balances = await liveBalances(tenantClients);
    if (balances.liquid + balances.vault < requiredLiquid) {
      milestoneRecord.status = 'verified';
      tenantAudit(tenantState, 'release_failed', 'Release needs funds', `${milestoneRecord.title} · insufficient live USDC`, { milestoneId: milestoneRecord.id });
      await persist();
      return;
    }
    milestoneRecord.yieldSnapshot = balances.yieldEarned;
    if (balances.liquid < requiredLiquid) {
      const needed = formatUnits(requiredLiquid - balances.liquid, 6);
      milestoneRecord.status = 'withdrawing';
      milestoneRecord.withdrawRequested = needed;
      await persist();
      const withdrawal = await withdrawForRelease(tenantClients, needed);
      milestoneRecord.withdrawTxHash = withdrawal.txHash;
      milestoneRecord.withdrawAmount = withdrawal.amount;
      tenantAudit(tenantState, 'vault_withdrawal', 'Vault USDC withdrawn', `${needed} USDC for ${milestoneRecord.title}`, { milestoneId: milestoneRecord.id, txHash: withdrawal.txHash });
      balances = await liveBalances(tenantClients);
      if (balances.liquid < requiredLiquid) throw new Error('Withdrawal completed but liquid USDC is insufficient');
      risk = await fetchVerdict(milestoneRecord.address);
      milestoneRecord.risk = risk;
      tenantAudit(tenantState, 'risk_check', `Pre-send risk check · ${risk.verdict}`, `${milestoneRecord.contractor} · ${risk.reason}`, { milestoneId: milestoneRecord.id, risk });
      if (risk.verdict === 'MEDIUM') { milestoneRecord.status = 'review'; await persist(); return; }
      if (risk.verdict === 'HIGH') { milestoneRecord.status = 'blocked'; await persist(); return; }
    }
    milestoneRecord.status = 'sending';
    await persist();
    const payment = await sendPayment(tenantClients, milestoneRecord.address, amountText);
    milestoneRecord.txHash = payment.txHash;
    milestoneRecord.status = 'confirming';
    await persist();
    const receipt = await verifyPaymentReceipt(tenantClients, payment.txHash, milestoneRecord.address, amountText);
    if (!riskCoversReceipt(risk, receipt.blockTimestamp)) throw new Error('Arc payment was outside CompliR attestation validity');
    milestoneRecord.status = 'paid';
    milestoneRecord.paidAt = new Date(receipt.blockTimestamp * 1000).toISOString();
    milestoneRecord.paymentBlockNumber = receipt.blockNumber;
    tenantAudit(tenantState, 'payment', 'Payment released on Arc', `${amountText} USDC to ${milestoneRecord.contractor}`, { milestoneId: milestoneRecord.id, risk, txHash: milestoneRecord.txHash, withdrawTxHash: milestoneRecord.withdrawTxHash, yieldSnapshot: milestoneRecord.yieldSnapshot });
  } catch (error) {
    milestoneRecord.status = 'needs_reconciliation';
    milestoneRecord.releaseError = error.message;
    tenantAudit(tenantState, 'release_uncertain', 'Release needs reconciliation', `${milestoneRecord.title} · ${error.message}`, { milestoneId: milestoneRecord.id, risk: milestoneRecord.risk, txHash: milestoneRecord.txHash, withdrawTxHash: milestoneRecord.withdrawTxHash });
  }
  await persist();
}
function demoVerdict(address) {
  const last = parseInt(address.slice(-1), 16);
  const verdict = last % 7 === 0 ? 'HIGH' : last % 5 === 0 ? 'MEDIUM' : 'LOW';
  return { verdict, reason: verdict === 'LOW' ? 'No demo risk indicators' : verdict === 'MEDIUM' ? 'Manual review required in demo policy' : 'Demo risk policy blocked release', signedProof: null, source: 'simulated', checkedAt: new Date().toISOString() };
}
async function processRelease(m) {
  if (m.status !== 'verified') failure(409, 'Verify the milestone before release');
  if (mode === 'live') return processLiveRelease(m);
  m.status = 'checking';
  await saveState();
  let risk;
  try { risk = screeningMode === 'live' ? await fetchVerdict(m.address) : demoVerdict(m.address); }
  catch (error) {
    m.status = 'verified';
    m.risk = { verdict: 'UNAVAILABLE', reason: error.message, source: 'complir', checkedAt: new Date().toISOString() };
    audit('risk_unavailable', 'Risk check unavailable', `${m.contractor} · ${error.message}`, { milestoneId: m.id, risk: m.risk, simulated: screeningMode !== 'live' });
    await saveState();
    return;
  }
  m.risk = risk;
  audit('risk_check', `Risk check · ${risk.verdict}`, `${m.contractor} · ${risk.reason}`, { milestoneId: m.id, risk, simulated: screeningMode !== 'live' });
  if (risk.verdict === 'MEDIUM') { m.status = 'review'; await saveState(); return; }
  if (risk.verdict === 'HIGH') { m.status = 'blocked'; await saveState(); return; }
  if (state.wallet.liquid + state.wallet.vault < m.amount) {
    m.status = 'verified';
    audit('release_failed', 'Release needs funds', `${m.title} · insufficient demo balance`, { milestoneId: m.id });
    await saveState();
    return;
  }
  const redeemed = Math.max(0, Math.round((m.amount - state.wallet.liquid) * 100) / 100);
  if (redeemed > 0) { state.wallet.vault = Math.round((state.wallet.vault - redeemed) * 100) / 100; state.wallet.liquid += redeemed; }
  state.wallet.liquid = Math.round((state.wallet.liquid - m.amount) * 100) / 100;
  m.status = 'paid';
  m.paidAt = new Date().toISOString();
  m.txHash = `0x${createHash('sha256').update(randomUUID()).digest('hex')}`;
  m.yieldSnapshot = state.wallet.yieldEarned;
  audit('payment', 'Payment released', `${m.amount.toLocaleString()} USDC to ${m.contractor}`, { milestoneId: m.id, risk, txHash: m.txHash, yieldSnapshot: m.yieldSnapshot, redeemed });
  await saveState();
}

async function processLiveRelease(m) {
  const amountText = m.amount.toFixed(2);
  await assertUsdcVault(clients);
  m.status = 'checking';
  await saveState();
  let risk;
  try { risk = await fetchVerdict(m.address); }
  catch (error) {
    m.status = 'verified';
    m.risk = { verdict: 'UNAVAILABLE', reason: error.message, source: 'complir', checkedAt: new Date().toISOString() };
    audit('risk_unavailable', 'Risk check unavailable', `${m.contractor} · ${error.message}`, { milestoneId: m.id, risk: m.risk, simulated: false });
    await saveState();
    return;
  }
  m.risk = risk;
  audit('risk_check', `Risk check · ${risk.verdict}`, `${m.contractor} · ${risk.reason}`, { milestoneId: m.id, risk, simulated: false });
  if (risk.verdict === 'MEDIUM') { m.status = 'review'; await saveState(); return; }
  if (risk.verdict === 'HIGH') { m.status = 'blocked'; await saveState(); return; }
  await saveState();

  try {
    const { formatUnits, parseUnits } = await import('viem');
    const target = parseUnits(amountText, 6);
    const requiredLiquid = target + parseUnits(clients.config.gasReserveUsdc, 6);
    let balances = await refreshLiveWallet();
    if (balances.liquid + balances.vault < requiredLiquid) {
      m.status = 'verified';
      audit('release_failed', 'Release needs funds', `${m.title} · insufficient live USDC`, { milestoneId: m.id, simulated: false });
      await saveState();
      return;
    }
    m.yieldSnapshot = balances.yieldEarned;
    if (balances.liquid < requiredLiquid) {
      const needed = formatUnits(requiredLiquid - balances.liquid, 6);
      m.status = 'withdrawing';
      m.withdrawRequested = needed;
      await saveState();
      const withdrawal = await withdrawForRelease(clients, needed);
      m.withdrawTxHash = withdrawal.txHash;
      m.withdrawAmount = withdrawal.amount;
      m.status = 'checking';
      audit('vault_withdrawal', 'Vault USDC withdrawn', `${needed} USDC for ${m.title}`, { milestoneId: m.id, txHash: withdrawal.txHash, simulated: false });
      await saveState();
      balances = await refreshLiveWallet();
      if (balances.liquid < requiredLiquid) throw new Error('Withdrawal completed but liquid USDC is insufficient');
      risk = await fetchVerdict(m.address);
      m.risk = risk;
      audit('risk_check', `Pre-send risk check · ${risk.verdict}`, `${m.contractor} · ${risk.reason}`, { milestoneId: m.id, risk, simulated: false });
      if (risk.verdict === 'MEDIUM') { m.status = 'review'; await saveState(); return; }
      if (risk.verdict === 'HIGH') { m.status = 'blocked'; await saveState(); return; }
      await saveState();
    }
    m.status = 'sending';
    await saveState();
    const payment = await sendPayment(clients, m.address, amountText);
    m.txHash = payment.txHash;
    m.status = 'confirming';
    await saveState();
    const receipt = await verifyPaymentReceipt(clients, payment.txHash, m.address, amountText);
    if (!riskCoversReceipt(risk, receipt.blockTimestamp)) throw new Error('Arc payment was outside CompliR attestation validity');
    m.status = 'paid';
    m.paidAt = new Date(receipt.blockTimestamp * 1000).toISOString();
    m.paymentBlockNumber = receipt.blockNumber;
    audit('payment', 'Payment released on Arc', `${amountText} USDC to ${m.contractor}`, { milestoneId: m.id, risk, txHash: m.txHash, withdrawTxHash: m.withdrawTxHash, yieldSnapshot: m.yieldSnapshot, simulated: false });
    await saveState();
    await refreshLiveWallet().catch(() => {});
  } catch (error) {
    m.status = 'needs_reconciliation';
    m.releaseError = error.message;
    audit('release_uncertain', 'Release needs reconciliation', `${m.title} · ${error.message}`, { milestoneId: m.id, risk: m.risk, txHash: m.txHash, withdrawTxHash: m.withdrawTxHash, simulated: false });
    await saveState();
  }
}

// Public signup guard: a few workspaces per visitor per hour and a daily ceiling for the server.
const signupLog = new Map();
let signupDay = { date: '', count: 0 };
const SIGNUP_PER_HOUR = Number(process.env.IPAY_SIGNUPS_PER_HOUR || 5);
const SIGNUP_PER_DAY = Number(process.env.IPAY_SIGNUPS_PER_DAY || 500);
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
function allowSignup(req) {
  const today = new Date().toISOString().slice(0, 10);
  if (signupDay.date !== today) signupDay = { date: today, count: 0 };
  if (signupDay.count >= SIGNUP_PER_DAY) failure(429, 'iPay has reached today\'s signup limit. Try again tomorrow.');
  const ip = clientIp(req);
  const hourAgo = Date.now() - 3_600_000;
  const recent = (signupLog.get(ip) || []).filter(at => at > hourAgo);
  if (recent.length >= SIGNUP_PER_HOUR) failure(429, 'Too many new workspaces from this connection. Try again in an hour.');
  recent.push(Date.now());
  signupLog.set(ip, recent);
  signupDay.count += 1;
}

async function provisionTreasury(workspace) {
  if (workspace.walletAddress) return workspaceRegistry.list().find(item => item.slug === workspace.slug);
  const circle = initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET });
  const walletSetResponse = await circle.createWalletSet({ name: `iPay · ${workspace.name}` });
  const walletSet = walletSetResponse.data?.walletSet;
  if (!walletSet?.id) throw new Error('Circle did not return a wallet set');
  const walletResponse = await circle.createWallets({ walletSetId: walletSet.id, blockchains: [clients.config.chain === 'Arc' ? 'ARC' : 'ARC-TESTNET'], count: 1, accountType: 'EOA' });
  const wallet = walletResponse.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) throw new Error('Circle did not return a wallet address');
  return workspaceRegistry.setTreasury(workspace.slug, {
    status: 'wallet_ready',
    walletSetId: walletSet.id,
    walletId: wallet.id,
    walletAddress: wallet.address,
    vaultAddress: clients.config.vaultAddress,
    blockchain: wallet.blockchain || (clients.config.chain === 'Arc' ? 'ARC' : 'ARC-TESTNET'),
  });
}

/* ---------- Payments agent ----------
   lib/agent.js decides; this runner enforces. A "pay" above the auto-pay limit or the
   workspace policy becomes a hold, and every payment still goes through CompliR. */
const agentRuns = new Set();
const round2 = value => Math.round(value * 100) / 100;

function agentSettings(tenantState) {
  return { ...DEFAULT_AGENT, ...(tenantState.agent?.settings || {}) };
}

async function runAgent(workspace, trigger) {
  if (agentRuns.has(workspace.slug)) return null;
  agentRuns.add(workspace.slug);
  let again = false;
  try {
    let tenantState = await workspaceDataStore.read(workspace);
    const settings = agentSettings(tenantState);
    if (!settings.enabled && trigger !== 'manual') return tenantState;
    const policy = workspace.policy || { maxPerTxUsdc: 5000, maxPerDayUsdc: 25000 };
    const live = mode === 'live' && workspace.walletAddress && workspace.vaultAddress;
    const tenantClients = live ? liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress }) : null;
    const reserve = live ? Number(tenantClients.config.gasReserveUsdc) : 0;
    let balances = { liquid: Number(tenantState.wallet?.liquid || 0), vault: Number(tenantState.wallet?.vault || 0), reserve };
    if (live) {
      const read = await liveBalances(tenantClients);
      balances = { liquid: Number(read.liquidUsdc), vault: Number(read.vaultUsdc), reserve };
    }
    const today = new Date().toISOString().slice(0, 10);
    const paidOn = state => state.milestones.filter(m => m.status === 'paid' && m.paidAt?.slice(0, 10) === today).reduce((s, m) => s + m.amount, 0);
    const context = buildContext({ workspaceName: workspace.name, state: tenantState, balances, agent: settings, policy, paidToday: paidOn(tenantState) });
    const decision = await decide(context);
    // Deciding can take a while; apply to fresh state so deliveries or edits made meanwhile are not overwritten.
    tenantState = await workspaceDataStore.read(workspace);
    let paidToday = paidOn(tenantState);
    const ceiling = Math.min(Number(settings.autoPayLimit), Number(policy.maxPerTxUsdc));
    const agentAudit = (title, detail, extra = {}) => tenantAudit(tenantState, 'agent_decision', title, detail, { engine: decision.engine, ...extra });

    for (const choice of decision.milestones) {
      const m = tenantState.milestones.find(item => item.id === choice.id && item.status === 'delivered');
      if (!m) continue;
      let action = choice.action;
      let reason = choice.reason;
      if (action === 'pay' && m.amount > ceiling) {
        action = 'hold';
        reason = `${reason} It is above the $${ceiling} I can pay on my own, so it needs your approval.`;
      }
      if (action === 'pay' && paidToday + m.amount > Number(policy.maxPerDayUsdc)) {
        action = 'hold';
        reason = `${reason} Paying it would pass today's spending limit, so it waits for you.`;
      }
      m.agentDecision = { action, reason, confidence: choice.confidence, engine: decision.engine, at: new Date().toISOString() };
      if (action === 'hold') {
        m.status = 'awaiting_verification';
        agentAudit('Agent held a payment', reason, { milestoneId: m.id, action });
      } else if (action === 'request_changes') {
        m.status = 'in_progress';
        m.changeRequests = (m.changeRequests || 0) + 1;
        agentAudit('Agent asked for changes', reason, { milestoneId: m.id, action });
      } else {
        m.evidence = `Approved by the payments agent: ${reason}`;
        m.verifiedAt = new Date().toISOString();
        m.status = 'verified';
        agentAudit('Agent approved a payment', reason, { milestoneId: m.id, action });
        if (live) {
          await workspaceDataStore.write(workspace, tenantState);
          await processWorkspaceLiveRelease(workspace, tenantState, m);
          if (m.status === 'paid') paidToday += m.amount;
        }
      }
    }

    // Treasury move, bounded by what open work actually needs.
    const t = decision.treasury;
    if (live && t.action !== 'none' && t.amount >= 5) {
      const fresh = await liveBalances(tenantClients);
      const liquid = Number(fresh.liquidUsdc);
      const vault = Number(fresh.vaultUsdc);
      const needed = tenantState.milestones.filter(m => !['paid', 'blocked'].includes(m.status)).reduce((s, m) => s + m.amount, 0);
      const amountUsd = t.action === 'move_to_savings'
        ? Math.floor(Math.min(t.amount, liquid - needed - reserve - 1))
        : Math.ceil(Math.min(t.amount, vault));
      if (amountUsd >= 5) {
        try {
          const result = t.action === 'move_to_savings'
            ? await depositToVault(tenantClients, amountUsd.toFixed(2))
            : await withdrawForRelease(tenantClients, amountUsd.toFixed(2));
          tenantAudit(tenantState, t.action === 'move_to_savings' ? 'vault_deposit' : 'vault_withdrawal', t.action === 'move_to_savings' ? 'Agent moved money to savings' : 'Agent moved money from savings', `${amountUsd.toFixed(2)} USDC · ${t.reason}`, { txHash: result.txHash, engine: decision.engine });
        } catch (error) {
          agentAudit('Agent could not move savings', `${t.reason} The move did not go through: ${error.message}`);
        }
      }
    }

    const latest = await workspaceDataStore.read(workspace);
    // Keep anything that changed during the payment steps, then layer this run's results on top.
    for (const m of tenantState.milestones) {
      const i = latest.milestones.findIndex(item => item.id === m.id);
      if (i >= 0 && m.agentDecision?.at && m.agentDecision.at !== latest.milestones[i].agentDecision?.at) latest.milestones[i] = m;
    }
    const known = new Set(latest.audit.map(a => a.id));
    latest.audit = [...tenantState.audit.filter(a => !known.has(a.id)), ...latest.audit].sort((a, b) => b.at.localeCompare(a.at));
    latest.agent = { settings: agentSettings(latest), lastRun: { at: new Date().toISOString(), trigger, engine: decision.engine, model: decision.model || null, summary: decision.summary, note: decision.note || null, treasury: decision.treasury } };
    await workspaceDataStore.write(workspace, latest);
    again = latest.milestones.some(m => m.status === 'delivered');
    return latest;
  } catch (error) {
    console.error(`Agent run failed for ${workspace.slug}:`, error);
    throw error;
  } finally {
    agentRuns.delete(workspace.slug);
    // A delivery that arrived mid-run gets its own run right away.
    if (again) setTimeout(() => runAgent(workspace, 'followup').catch(() => {}), 1000);
  }
}

// Confirm payments that were sent but not confirmed in time (slow network, App Kit timeout).
async function reconcilePending(workspace) {
  if (mode !== 'live' || !workspace.walletAddress) return;
  const tenantState = await workspaceDataStore.read(workspace);
  const pending = tenantState.milestones.filter(m => m.status === 'needs_reconciliation' && m.txHash && m.risk?.verdict === 'LOW' && m.risk?.signatureVerified);
  if (!pending.length) return;
  const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
  for (const m of pending) {
    try {
      const receipt = await verifyPaymentReceipt(tenantClients, m.txHash, m.address, m.amount.toFixed(2));
      if (!riskCoversReceipt(m.risk, receipt.blockTimestamp)) continue;
      m.status = 'paid';
      m.paidAt = new Date(receipt.blockTimestamp * 1000).toISOString();
      m.paymentBlockNumber = receipt.blockNumber;
      delete m.releaseError;
      tenantAudit(tenantState, 'payment_reconciled', 'Payment confirmed on Arc', `${m.amount.toFixed(2)} USDC to ${m.contractor}`, { milestoneId: m.id, risk: m.risk, txHash: m.txHash });
    } catch (error) { console.warn(`Reconcile pending for ${m.id}:`, error.message); }
  }
  await workspaceDataStore.write(workspace, tenantState);
}

function deliveryTarget(input) {
  const workspace = workspaceRegistry.bySlug(String(input.workspace || ''));
  if (!workspace) failure(404, 'This delivery link is not valid');
  return workspace;
}
function tokenMatches(expected, supplied) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(supplied || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function api(req, res, path) {
  // Contractor delivery: public, authorized by the milestone's private link token.
  if (path === '/api/deliver') {
    const input = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await body(req);
    const workspace = deliveryTarget(input);
    const tenantState = await workspaceDataStore.read(workspace);
    const m = tenantState.milestones.find(item => item.id === input.milestone);
    if (!m || !tokenMatches(m.deliveryToken, input.token)) failure(404, 'This delivery link is not valid');
    const view = () => ({ explorerUrl: network.explorerUrl, testnet: network.testnet, business: workspace.name, title: m.title, scope: m.description, amount: m.amount, contractor: m.contractor, dueDate: m.dueDate, status: m.status, delivery: m.delivery || null, agentDecision: m.agentDecision || null, paidAt: m.paidAt || null, txHash: m.status === 'paid' ? m.txHash : null });
    if (req.method === 'GET') return respond(res, 200, view());
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (!['in_progress', 'awaiting_verification'].includes(m.status)) failure(409, m.status === 'paid' ? 'This milestone is already paid' : 'This milestone is not open for delivery right now');
    const note = String(input.note || '').trim();
    const link = String(input.link || '').trim();
    if (note.length < 10 || note.length > 2000) failure(400, 'Describe what you delivered in at least 10 characters');
    if (link && (!/^https?:\/\/\S+$/i.test(link) || link.length > 500)) failure(400, 'Enter a full link starting with https://');
    m.delivery = { note, link: link || null, at: new Date().toISOString() };
    m.status = 'delivered';
    tenantAudit(tenantState, 'delivery_submitted', 'Work delivered', `${m.contractor} submitted ${m.title}`, { milestoneId: m.id });
    await workspaceDataStore.write(workspace, tenantState);
    runAgent(workspace, 'delivery').catch(() => {});
    return respond(res, 200, view());
  }
  const agentMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/agent(\/run)?$/);
  if (agentMatch) {
    const workspace = requireWorkspaceRole(req, agentMatch[1], ['owner', 'finance']);
    if (agentMatch[2]) {
      if (req.method !== 'POST') failure(405, 'Method not allowed');
      const result = await runAgent(workspace, 'manual');
      return respond(res, 200, result || await workspaceDataStore.read(workspace));
    }
    if (req.method !== 'PUT') failure(405, 'Method not allowed');
    const input = await body(req);
    const tenantState = await workspaceDataStore.read(workspace);
    const settings = agentSettings(tenantState);
    if (input.enabled !== undefined) settings.enabled = Boolean(input.enabled);
    if (input.autoPayLimit !== undefined) {
      const limit = Number(input.autoPayLimit);
      if (!Number.isFinite(limit) || limit < 0 || limit > 100000) failure(400, 'Enter an auto-pay limit between 0 and 100,000');
      settings.autoPayLimit = round2(limit);
    }
    tenantState.agent = { ...(tenantState.agent || {}), settings };
    tenantAudit(tenantState, 'agent_settings', 'Agent settings changed', settings.enabled ? `Auto-pay up to $${settings.autoPayLimit}` : 'Agent paused');
    await workspaceDataStore.write(workspace, tenantState);
    return respond(res, 200, tenantState);
  }
  if (path === '/api/signup') {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    const input = await body(req);
    allowSignup(req);
    // The handle is derived from the business name; a short suffix resolves collisions.
    const base = String(input.slug || input.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    let created;
    let lastError;
    for (let attempt = 0; attempt < 4 && !created; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      try { created = await workspaceRegistry.create({ name: input.name, slug }); }
      catch (error) { lastError = error; if (!/already in use/i.test(error.message)) break; }
    }
    if (!created) {
      // A rejected name should not use up the visitor's quota.
      signupLog.get(clientIp(req))?.pop();
      signupDay.count -= 1;
      failure(400, lastError?.message || 'Could not create the workspace');
    }
    // Create the workspace's own Circle wallet straight away; setup can retry if Circle is slow.
    if (mode === 'live') {
      try { created.workspace = await provisionTreasury(workspaceRegistry.bySlug(created.workspace.slug)); }
      catch (error) { console.warn('Signup provisioning deferred:', error.message); created.provisionError = error.message; }
    }
    return respond(res, 201, created);
  }
  if (path === '/api/workspaces') {
    requireOwner(req);
    if (req.method === 'GET') return respond(res, 200, { workspaces: workspaceRegistry.list() });
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    const input = await body(req);
    try {
      const created = await workspaceRegistry.create(input);
      return respond(res, 201, created);
    } catch (error) { failure(400, error.message); }
  }
  const memberMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/members$/);
  if (memberMatch) {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    const workspace = requireWorkspaceOwner(req, memberMatch[1]);
    const input = await body(req);
    try { return respond(res, 201, await workspaceRegistry.addMember(workspace.slug, input)); }
    catch (error) { failure(400, error.message); }
  }
  const policyMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/policy$/);
  if (policyMatch) {
    if (req.method !== 'PUT') failure(405, 'Method not allowed');
    const workspace = requireWorkspaceOwner(req, policyMatch[1]);
    const input = await body(req);
    const maxPerTxUsdc = Number(input.maxPerTxUsdc);
    const maxPerDayUsdc = Number(input.maxPerDayUsdc);
    if (!Number.isFinite(maxPerTxUsdc) || !Number.isFinite(maxPerDayUsdc) || maxPerTxUsdc <= 0 || maxPerDayUsdc <= 0 || maxPerTxUsdc > maxPerDayUsdc || maxPerDayUsdc > 100000000) failure(400, 'Enter valid payment limits');
    const policy = { maxPerTxUsdc: Math.round(maxPerTxUsdc * 100) / 100, maxPerDayUsdc: Math.round(maxPerDayUsdc * 100) / 100 };
    const updated = await workspaceRegistry.setPolicy(workspace.slug, policy);
    return respond(res, 200, { workspace: updated });
  }
  const auditExportMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/audit\.csv$/);
  if (auditExportMatch) {
    if (req.method !== 'GET') failure(405, 'Method not allowed');
    const workspace = requireWorkspaceRole(req, auditExportMatch[1], ['owner', 'finance', 'reviewer']);
    const tenantState = await workspaceDataStore.read(workspace);
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = ['timestamp,type,title,detail,milestone_id,tx_hash'];
    for (const entry of tenantState.audit) rows.push([entry.at, entry.type, entry.title, entry.detail, entry.milestoneId, entry.txHash].map(quote).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${workspace.slug}-ipay-audit.csv"`, 'Cache-Control': 'no-store' });
    return res.end(rows.join('\n'));
  }
  const workspaceMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/(state|milestones)$/);
  if (workspaceMatch) {
    const [, slug, resource] = workspaceMatch;
    const workspace = req.method === 'GET' && resource === 'state'
      ? requireWorkspaceRole(req, slug, ['owner', 'finance', 'reviewer'])
      : requireWorkspaceRole(req, slug, ['owner', 'finance']);
    const tenantState = await workspaceDataStore.read(workspace);
    if (req.method === 'GET' && resource === 'state') {
      if (mode === 'live' && workspace.walletAddress && workspace.vaultAddress) {
        try {
          const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
          const balances = await liveBalances(tenantClients);
          tenantState.wallet = {
            address: workspace.walletAddress,
            vaultAddress: workspace.vaultAddress,
            liquid: Number(balances.liquidUsdc),
            vault: Number(balances.vaultUsdc),
            yieldEarned: balances.yieldEarned === null ? null : Number(balances.yieldEarned),
          };
        } catch (err) {
          console.warn('Could not refresh tenant live balances:', err.message);
        }
      }
      return respond(res, 200, { ...tenantState, mode, screeningMode, agent: { settings: agentSettings(tenantState), lastRun: tenantState.agent?.lastRun || null, engine: agentEngine() } });
    }
    if (req.method === 'POST' && resource === 'milestones') {
      const input = await body(req);
      const title = String(input.title || '').trim();
      const contractor = String(input.contractor || '').trim();
      const address = String(input.address || '').trim();
      const description = String(input.description || '').trim();
      if (!title || title.length > 100 || !contractor || contractor.length > 100 || description.length > 500 || !addressPattern.test(address)) failure(400, 'Enter a title, contractor, and valid Arc address');
      if (workspace.walletAddress && address.toLowerCase() === workspace.walletAddress.toLowerCase()) failure(400, 'Contractor address must differ from the workspace wallet');
      const value = amount(input.amount);
      const dueDate = String(input.dueDate || '').trim();
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) failure(400, 'Enter the due date as a date');
      // The contractor submits delivery through a private link carrying this token.
      const milestone = { id: randomUUID(), title, contractor, address, description, amount: value, dueDate: dueDate || null, status: 'in_progress', createdAt: new Date().toISOString(), evidence: null, deliveryToken: randomBytes(18).toString('base64url') };
      tenantState.milestones.unshift(milestone);
      tenantState.audit.unshift({ id: randomUUID(), type: 'milestone_created', title: 'Milestone created', detail: `${title} · ${value.toLocaleString()} USDC`, at: new Date().toISOString() });
      await workspaceDataStore.write(workspace, tenantState);
      return respond(res, 201, tenantState);
    }
    failure(405, 'Method not allowed');
  }
  const workspaceMilestoneAction = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/milestones\/([a-f0-9-]+)\/(verify|release|reconcile)$/);
  if (workspaceMilestoneAction) {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (mode !== 'live') failure(409, 'Workspace releases are only available in live mode');
    const [, slug, milestoneId, action] = workspaceMilestoneAction;
    const workspace = requireWorkspaceRole(req, slug, action === 'verify' ? ['owner', 'reviewer'] : ['owner', 'finance']);
    if (!workspace.walletAddress || !workspace.vaultAddress) failure(409, 'Provision a workspace treasury before releasing payments');
    const tenantState = await workspaceDataStore.read(workspace);
    const milestoneRecord = tenantState.milestones.find(item => item.id === milestoneId);
    if (!milestoneRecord) failure(404, 'Milestone not found');
    const input = await body(req);
    if (action === 'reconcile') {
      if (milestoneRecord.status !== 'needs_reconciliation' || milestoneRecord.risk?.verdict !== 'LOW' || !milestoneRecord.risk?.signatureVerified || !milestoneRecord.txHash) failure(409, 'Milestone cannot be reconciled as paid');
      const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
      const receipt = await verifyPaymentReceipt(tenantClients, milestoneRecord.txHash, milestoneRecord.address, milestoneRecord.amount.toFixed(2));
      if (!riskCoversReceipt(milestoneRecord.risk, receipt.blockTimestamp)) failure(409, 'Payment was outside the CompliR attestation validity');
      milestoneRecord.status = 'paid';
      milestoneRecord.paidAt = new Date(receipt.blockTimestamp * 1000).toISOString();
      milestoneRecord.paymentBlockNumber = receipt.blockNumber;
      delete milestoneRecord.releaseError;
      tenantAudit(tenantState, 'payment_reconciled', 'Payment reconciled on Arc', `${milestoneRecord.amount.toFixed(2)} USDC to ${milestoneRecord.contractor}`, { milestoneId: milestoneRecord.id, risk: milestoneRecord.risk, txHash: milestoneRecord.txHash, withdrawTxHash: milestoneRecord.withdrawTxHash, yieldSnapshot: milestoneRecord.yieldSnapshot });
      await workspaceDataStore.write(workspace, tenantState);
      return respond(res, 200, tenantState);
    }
    if (action === 'verify') {
      if (!['in_progress', 'awaiting_verification', 'delivered'].includes(milestoneRecord.status)) failure(409, 'This milestone cannot be verified now');
      const evidence = String(input.evidence || '').trim();
      if (evidence.length < 8 || evidence.length > 1000) failure(400, 'Add at least 8 characters of verification evidence');
      milestoneRecord.evidence = evidence;
      milestoneRecord.verifiedAt = new Date().toISOString();
      milestoneRecord.status = 'verified';
      tenantAudit(tenantState, 'milestone_verified', 'Milestone verified', `${milestoneRecord.title} · owner evidence recorded`, { milestoneId: milestoneRecord.id, evidence });
      await workspaceDataStore.write(workspace, tenantState);
    } else if (milestoneRecord.status !== 'verified') failure(409, 'Verify the milestone before release');
    assertWorkspacePaymentPolicy(workspace, tenantState, milestoneRecord);
    // Screening and settlement can outlast the proxy timeout, so pay in the background
    // and let the dashboard follow the milestone status.
    milestoneRecord.status = 'checking';
    await workspaceDataStore.write(workspace, tenantState);
    processWorkspaceLiveRelease(workspace, tenantState, milestoneRecord).catch(async error => {
      console.error(`Release failed for ${milestoneRecord.id}:`, error);
      milestoneRecord.status = 'verified';
      milestoneRecord.releaseError = error.message;
      await workspaceDataStore.write(workspace, tenantState).catch(() => {});
    });
    return respond(res, 202, tenantState);
  }
  const provisionMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/provision-treasury$/);
  if (provisionMatch) {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (mode !== 'live') failure(409, 'Treasury provisioning is only available in live mode');
    const workspace = requireWorkspaceRole(req, provisionMatch[1], ['owner']);
    const created = !workspace.walletAddress;
    return respond(res, created ? 201 : 200, { workspace: await provisionTreasury(workspace), created });
  }
  const treasuryMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/(treasury|fund-testnet)$/);
  if (treasuryMatch) {
    const [, slug, action] = treasuryMatch;
    const workspace = action === 'treasury'
      ? requireWorkspaceRole(req, slug, ['owner', 'finance', 'reviewer'])
      : requireWorkspaceRole(req, slug, ['owner', 'finance']);
    if (!workspace.walletAddress) failure(409, 'Provision a Circle treasury before accessing it');
    if (action === 'treasury') {
      if (req.method !== 'GET') failure(405, 'Method not allowed');
      const wallet = await readArcWallet({ address: workspace.walletAddress, rpcUrl: clients.config.rpcUrl });
      return respond(res, 200, { workspace: workspaceRegistry.list().find(item => item.slug === slug), wallet });
    }
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (clients.config.chain !== 'Arc_Testnet') failure(409, 'Testnet funding is unavailable on Arc mainnet');
    const circle = initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET });
    await circle.requestTestnetTokens({ address: workspace.walletAddress, blockchain: 'ARC-TESTNET', native: true, usdc: true });
    const wallet = await readArcWallet({ address: workspace.walletAddress, rpcUrl: clients.config.rpcUrl });
    return respond(res, 202, { wallet, fundingRequested: true });
  }
  const workspaceEarnMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/earn\/deposit$/);
  if (workspaceEarnMatch) {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (mode !== 'live') failure(409, 'Earn deposits are only available in live mode');
    const workspace = requireWorkspaceRole(req, workspaceEarnMatch[1], ['owner', 'finance']);
    if (!workspace.walletAddress || !workspace.vaultAddress) failure(409, 'Provision a workspace treasury before depositing');
    const input = await body(req);
    const value = amount(input.amount);
    const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
    await assertUsdcVault(tenantClients);
    const before = await liveBalances(tenantClients);
    if (value > Number(before.liquidUsdc) - Number(tenantClients.config.gasReserveUsdc)) failure(409, 'Deposit exceeds available liquid USDC');
    const deposit = await depositToVault(tenantClients, value.toFixed(2));
    const after = await liveBalances(tenantClients);
    const tenantState = await workspaceDataStore.read(workspace);
    tenantState.audit.unshift({ id: randomUUID(), type: 'vault_deposit', title: 'USDC parked in Earn vault', detail: `${value.toFixed(2)} USDC deposited`, at: new Date().toISOString(), txHash: deposit.txHash, simulated: false });
    await workspaceDataStore.write(workspace, tenantState);
    return respond(res, 200, { deposit, wallet: { liquidUsdc: after.liquidUsdc, vaultUsdc: after.vaultUsdc, yieldEarned: after.yieldEarned } });
  }
  if (req.method === 'GET' && path === '/api/config') return respond(res, 200, { mode, chain: clients?.config.chain || null, network });
  // The server's own treasury belongs to the operator; users only ever see their workspace.
  if (req.method === 'GET' && ['/api/state', '/api/arc-wallet', '/api/earn-position'].includes(path)) requireOwner(req);
  if (req.method === 'GET' && path === '/api/state') {
    if (mode === 'live') {
      try {
        await refreshLiveWallet();
      } catch (err) {
        console.warn('Could not refresh live wallet:', err.message);
      }
    }
    return respond(res, 200, snapshot());
  }
  if (req.method === 'GET' && path === '/api/arc-wallet') return respond(res, 200, await readArcWallet());
  if (req.method === 'GET' && path === '/api/earn-position') return respond(res, 200, await readEarnPosition());
  requireOwner(req);
  if (req.method !== 'POST') failure(404, 'Endpoint not found');
  const input = await body(req);
  if (path === '/api/earn/deposit') {
    if (mode !== 'live') failure(409, 'Earn deposits are only available in live mode');
    const value = amount(input.amount);
    await assertUsdcVault(clients);
    const balances = await refreshLiveWallet();
    const reserve = Number(clients.config.gasReserveUsdc);
    if (value > Number(balances.liquidUsdc) - reserve) failure(409, 'Deposit exceeds available liquid USDC');
    const result = await depositToVault(clients, value.toFixed(2));
    audit('vault_deposit', 'USDC parked in Earn vault', value.toFixed(2) + ' USDC deposited', { txHash: result.txHash, simulated: false });
    await refreshLiveWallet();
    await saveState();
    return respond(res, 200, snapshot());
  }
  if (path === '/api/milestones') {
    const title = String(input.title || '').trim();
    const contractor = String(input.contractor || '').trim();
    const description = String(input.description || '').trim();
    const address = String(input.address || '').trim();
    if (!title || title.length > 100 || !contractor || contractor.length > 100 || description.length > 500 || !addressPattern.test(address)) failure(400, 'Enter a title, contractor, and valid Arc address');
    if (mode === 'live' && address.toLowerCase() === clients.config.walletAddress.toLowerCase()) failure(400, 'Contractor address must differ from the budget wallet');
    const value = amount(input.amount);
    const outstanding = state.milestones.filter(m => !['paid', 'blocked'].includes(m.status)).reduce((sum, m) => sum + m.amount, 0);
    if (mode === 'live') await refreshLiveWallet();
    if (outstanding + value > state.wallet.liquid + state.wallet.vault - (mode === 'live' ? Number(clients.config.gasReserveUsdc) : 0)) failure(409, 'Amount exceeds uncommitted budget');
    const m = { id: randomUUID(), title, contractor, description, address, amount: value, status: 'in_progress', createdAt: new Date().toISOString(), evidence: null };
    state.milestones.unshift(m);
    audit('milestone_created', 'Milestone created', `${title} · ${value.toLocaleString()} USDC`, { milestoneId: m.id });
    await saveState();
    return respond(res, 201, snapshot());
  }
  const match = path.match(/^\/api\/milestones\/([a-f0-9-]+)\/(verify|release|reconcile)$/);
  if (!match) failure(404, 'Endpoint not found');
  const m = milestone(match[1]);
  if (match[2] === 'reconcile') {
    if (mode !== 'live' || m.status !== 'needs_reconciliation' || m.risk?.verdict !== 'LOW' || !m.risk.signatureVerified) failure(409, 'Milestone cannot be reconciled as paid');
    const txHash = String(input.txHash || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) failure(400, 'Enter a valid Arc payment transaction hash');
    if (state.milestones.some(other => other.id !== m.id && other.txHash?.toLowerCase() === txHash.toLowerCase())) failure(409, 'Transaction hash already belongs to another milestone');
    const receipt = await verifyPaymentReceipt(clients, txHash, m.address, m.amount.toFixed(2));
    if (!riskCoversReceipt(m.risk, receipt.blockTimestamp)) failure(409, 'Payment occurred outside the signed CompliR verdict validity');
    m.txHash = txHash;
    m.paymentBlockNumber = receipt.blockNumber;
    m.paidAt = new Date(receipt.blockTimestamp * 1000).toISOString();
    m.status = 'paid';
    audit('payment_reconciled', 'Payment reconciled on Arc', `${m.amount.toFixed(2)} USDC to ${m.contractor}`, { milestoneId: m.id, risk: m.risk, txHash, withdrawTxHash: m.withdrawTxHash, yieldSnapshot: m.yieldSnapshot, simulated: false });
    await saveState();
    return respond(res, 200, snapshot());
  }
  if (match[2] === 'verify') {
    if (!['in_progress', 'awaiting_verification'].includes(m.status)) failure(409, 'This milestone cannot be verified now');
    const evidence = String(input.evidence || '').trim();
    if (evidence.length < 8 || evidence.length > 1000) failure(400, 'Add at least 8 characters of verification evidence');
    m.evidence = evidence;
    m.verifiedAt = new Date().toISOString();
    m.status = 'verified';
    audit('milestone_verified', 'Milestone verified', `${m.title} · owner evidence recorded`, { milestoneId: m.id, evidence });
    await saveState();
    await processRelease(m);
  } else await processRelease(m);
  respond(res, 200, snapshot());
}

async function staticFile(res, path) {
  // Mirror Vercel's cleanUrls so /app and /onboard work locally too.
  const target = path === '/' ? '/index.html' : extname(path) ? path : `${path.replace(/\/$/, '')}.html`;
  const file = resolve(publicDir, `.${target}`);
  if (!file.startsWith(publicDir + sep) && file !== publicDir) failure(403, 'Forbidden');
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  } catch (error) { if (error.code === 'ENOENT') failure(404, 'Page not found'); throw error; }
}

await workspaceRegistry.load();
await loadState();
http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) await api(req, res, path);
    else if (req.method === 'GET') await staticFile(res, path);
    else failure(405, 'Method not allowed');
  } catch (error) {
    console.error(error);
    respond(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
}).listen(port, '0.0.0.0', () => console.log(`iPay running on port ${port} (${mode} mode)`));

// Safety net for deliveries whose immediate agent run failed or overlapped another run.
setInterval(async () => {
  for (const item of workspaceRegistry.list()) {
    try {
      const workspace = workspaceRegistry.bySlug(item.slug);
      const tenantState = await workspaceDataStore.read(workspace);
      if (tenantState.milestones.some(m => m.status === 'delivered')) await runAgent(workspace, 'sweep');
      if (tenantState.milestones.some(m => m.status === 'needs_reconciliation' && m.txHash)) await reconcilePending(workspace);
    } catch (error) { console.warn(`Agent sweep skipped ${item.slug}:`, error.message); }
  }
}, Number(process.env.IPAY_AGENT_SWEEP_MS || 180_000)).unref();

