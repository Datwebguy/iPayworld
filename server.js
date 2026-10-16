import http from 'node:http';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createWorkspaceRegistry } from './lib/workspace-registry.js';
import { createWorkspaceDataStore } from './lib/workspace-data.js';
import { createPostgresWorkspaceStores } from './lib/postgres-workspaces.js';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { fetchVerdict } from './lib/complir.js';
import { readArcWallet } from './lib/arc-wallet.js';
import { readEarnPosition } from './lib/earn-position.js';
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
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function initialState() {
  const now = new Date().toISOString();
  if (mode === 'live') return { chain: clients.config.chain, vaultAddress: clients.config.vaultAddress, wallet: { address: clients.config.walletAddress, liquid: 0, vault: 0, yieldEarned: 0, startingBudget: 0 }, milestones: [], audit: [] };
  return {
    wallet: { address: null, liquid: 8400, vault: 4100, yieldEarned: 35.65, startingBudget: 12500 },
    milestones: [
      { id: randomUUID(), title: 'Brand identity system', contractor: 'Studio North', address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', amount: 2400, status: 'awaiting_verification', description: 'Logo system, colors and brand guidelines', createdAt: now, evidence: null },
      { id: randomUUID(), title: 'Landing page development', contractor: 'Marcus Chen', address: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', amount: 1850, status: 'in_progress', description: 'Responsive marketing website', createdAt: now, evidence: null },
      { id: randomUUID(), title: 'Product copy and content', contractor: 'Ava Morgan', address: '0x4E83362442B8d1beC281594cEa3050c8EB01311C', amount: 950, status: 'in_progress', description: 'Homepage and onboarding copy', createdAt: now, evidence: null }
    ],
    audit: [{ id: randomUUID(), type: 'budget_funded', title: 'Project budget funded', detail: 'Demo wallet allocated 12,500 USDC', at: now, simulated: true }]
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
  return { mode, screeningMode, wallet: state.wallet, committed, available: Math.max(0, Math.round((state.wallet.liquid + state.wallet.vault - committed - reserve) * 100) / 100), milestones: state.milestones, audit: state.audit };
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

async function api(req, res, path) {
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
        const tenantClients = liveClients({ ...process.env, CIRCLE_WALLET_ADDRESS: workspace.walletAddress, EARN_VAULT_ADDRESS: workspace.vaultAddress });
        const balances = await liveBalances(tenantClients);
        tenantState.wallet = {
          address: workspace.walletAddress,
          vaultAddress: workspace.vaultAddress,
          liquid: Number(balances.liquidUsdc),
          vault: Number(balances.vaultUsdc),
          yieldEarned: balances.yieldEarned === null ? null : Number(balances.yieldEarned),
        };
      }
      return respond(res, 200, { ...tenantState, mode, screeningMode });
    }
    if (req.method === 'POST' && resource === 'milestones') {
      const input = await body(req);
      const title = String(input.title || '').trim();
      const contractor = String(input.contractor || '').trim();
      const address = String(input.address || '').trim();
      const description = String(input.description || '').trim();
      if (!title || title.length > 100 || !contractor || contractor.length > 100 || description.length > 500 || !addressPattern.test(address)) failure(400, 'Enter a title, contractor, and valid Arc address');
      const value = amount(input.amount);
      const milestone = { id: randomUUID(), title, contractor, address, description, amount: value, status: 'in_progress', createdAt: new Date().toISOString(), evidence: null };
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
      if (!['in_progress', 'awaiting_verification'].includes(milestoneRecord.status)) failure(409, 'This milestone cannot be verified now');
      const evidence = String(input.evidence || '').trim();
      if (evidence.length < 8 || evidence.length > 1000) failure(400, 'Add at least 8 characters of verification evidence');
      milestoneRecord.evidence = evidence;
      milestoneRecord.verifiedAt = new Date().toISOString();
      milestoneRecord.status = 'verified';
      tenantAudit(tenantState, 'milestone_verified', 'Milestone verified', `${milestoneRecord.title} · owner evidence recorded`, { milestoneId: milestoneRecord.id, evidence });
      await workspaceDataStore.write(workspace, tenantState);
    } else if (milestoneRecord.status !== 'verified') failure(409, 'Verify the milestone before release');
    assertWorkspacePaymentPolicy(workspace, tenantState, milestoneRecord);
    await processWorkspaceLiveRelease(workspace, tenantState, milestoneRecord);
    return respond(res, 200, tenantState);
  }
  const provisionMatch = path.match(/^\/api\/workspaces\/([a-z0-9-]+)\/provision-treasury$/);
  if (provisionMatch) {
    if (req.method !== 'POST') failure(405, 'Method not allowed');
    if (mode !== 'live') failure(409, 'Treasury provisioning is only available in live mode');
    const workspace = requireWorkspaceRole(req, provisionMatch[1], ['owner']);
    if (workspace.walletAddress) return respond(res, 200, { workspace, created: false });
    const circle = initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET });
    const walletSetResponse = await circle.createWalletSet({ name: `iPay · ${workspace.name}` });
    const walletSet = walletSetResponse.data?.walletSet;
    if (!walletSet?.id) throw new Error('Circle did not return a wallet set');
    const walletResponse = await circle.createWallets({ walletSetId: walletSet.id, blockchains: [clients.config.chain === 'Arc' ? 'ARC' : 'ARC-TESTNET'], count: 1, accountType: 'EOA' });
    const wallet = walletResponse.data?.wallets?.[0];
    if (!wallet?.id || !wallet?.address) throw new Error('Circle did not return a wallet address');
    const updated = await workspaceRegistry.setTreasury(workspace.slug, {
      status: 'wallet_ready',
      walletSetId: walletSet.id,
      walletId: wallet.id,
      walletAddress: wallet.address,
      vaultAddress: clients.config.vaultAddress,
      blockchain: wallet.blockchain || (clients.config.chain === 'Arc' ? 'ARC' : 'ARC-TESTNET'),
    });
    return respond(res, 201, { workspace: updated, created: true });
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
      return respond(res, 200, { workspace: workspaceRegistry.bySlug(slug), wallet });
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
  if (req.method === 'GET' && path === '/api/config') return respond(res, 200, { mode, chain: clients?.config.chain || null });
  if (req.method === 'GET' && path === '/api/state') {
    if (mode === 'live') await refreshLiveWallet();
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
  const target = path === '/' ? '/index.html' : path;
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

