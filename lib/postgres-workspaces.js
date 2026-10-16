import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const slugify = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const publicMember = ({ tokenHash: ignored, ...member }) => member;
const publicWorkspace = ({ ownerTokenHash, members, ...workspace }) => ({ ...workspace, members: (members || []).map(publicMember) });

export function createPostgresWorkspaceStores(connectionString) {
  const pool = new Pool({ connectionString });
  let workspaces = [];
  let initialized = false;

  async function init() {
    if (initialized) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ipay_workspaces (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        wallet_set_id TEXT,
        wallet_id TEXT,
        wallet_address TEXT,
        vault_address TEXT,
        blockchain TEXT,
        policy JSONB NOT NULL DEFAULT '{"maxPerTxUsdc":5000,"maxPerDayUsdc":25000}'::jsonb,
        members JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ
      );
      ALTER TABLE ipay_workspaces ADD COLUMN IF NOT EXISTS policy JSONB NOT NULL DEFAULT '{"maxPerTxUsdc":5000,"maxPerDayUsdc":25000}'::jsonb;
      CREATE TABLE IF NOT EXISTS ipay_workspace_state (
        workspace_id UUID PRIMARY KEY REFERENCES ipay_workspaces(id) ON DELETE CASCADE,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    initialized = true;
  }
  async function refresh() {
    await init();
    const result = await pool.query('SELECT * FROM ipay_workspaces ORDER BY created_at');
    workspaces = result.rows.map(row => ({
      id: row.id, name: row.name, slug: row.slug, ownerTokenHash: row.owner_token_hash, status: row.status,
      walletSetId: row.wallet_set_id, walletId: row.wallet_id, walletAddress: row.wallet_address,
      vaultAddress: row.vault_address, blockchain: row.blockchain, policy: row.policy || { maxPerTxUsdc: 5000, maxPerDayUsdc: 25000 }, members: row.members || [],
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at?.toISOString(),
    }));
  }
  const registry = {
    async load() { await refresh(); },
    async create({ name, slug }) {
      const safeName = String(name || '').trim();
      const safeSlug = slugify(slug || safeName);
      if (!safeName || safeName.length > 100 || !safeSlug || safeSlug.length > 64) throw new Error('Enter a workspace name and valid slug');
      if (workspaces.some(item => item.slug === safeSlug)) throw new Error('That workspace slug is already in use');
      const ownerToken = `ipay_ws_${randomBytes(32).toString('base64url')}`;
      const workspace = { id: randomUUID(), name: safeName, slug: safeSlug, ownerTokenHash: tokenHash(ownerToken), status: 'pending_wallet', walletAddress: null, vaultAddress: null, policy: { maxPerTxUsdc: 5000, maxPerDayUsdc: 25000 }, members: [], createdAt: new Date().toISOString() };
      await pool.query('INSERT INTO ipay_workspaces (id,name,slug,owner_token_hash,status,policy,members,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [workspace.id, workspace.name, workspace.slug, workspace.ownerTokenHash, workspace.status, JSON.stringify(workspace.policy), JSON.stringify([]), workspace.createdAt]);
      workspaces.push(workspace);
      return { workspace: publicWorkspace(workspace), ownerToken };
    },
    list() { return workspaces.map(publicWorkspace); },
    bySlug(slug) { return workspaces.find(item => item.slug === slug) || null; },
    byOwnerToken(token) { return workspaces.find(item => token && item.ownerTokenHash === tokenHash(token)) || null; },
    accessByToken(token) {
      for (const workspace of workspaces) {
        if (token && workspace.ownerTokenHash === tokenHash(token)) return { workspace, role: 'owner' };
        const member = workspace.members.find(item => token && item.tokenHash === tokenHash(token));
        if (member) return { workspace, role: member.role, member: publicMember(member) };
      }
      return null;
    },
    async addMember(slug, { name, role }) {
      const workspace = this.bySlug(slug);
      const safeName = String(name || '').trim();
      if (!workspace) throw new Error('Workspace not found');
      if (!safeName || safeName.length > 100 || !['finance', 'reviewer'].includes(role)) throw new Error('Enter a member name and valid role');
      const accessToken = `ipay_member_${randomBytes(32).toString('base64url')}`;
      const member = { id: randomUUID(), name: safeName, role, tokenHash: tokenHash(accessToken), createdAt: new Date().toISOString() };
      workspace.members.push(member);
      await pool.query('UPDATE ipay_workspaces SET members=$1::jsonb, updated_at=NOW() WHERE id=$2', [JSON.stringify(workspace.members), workspace.id]);
      return { member: publicMember(member), accessToken };
    },
    async setTreasury(slug, treasury) {
      const workspace = this.bySlug(slug);
      if (!workspace) throw new Error('Workspace not found');
      Object.assign(workspace, treasury, { updatedAt: new Date().toISOString() });
      await pool.query('UPDATE ipay_workspaces SET status=$1,wallet_set_id=$2,wallet_id=$3,wallet_address=$4,vault_address=$5,blockchain=$6,updated_at=NOW() WHERE id=$7', [workspace.status, workspace.walletSetId || null, workspace.walletId || null, workspace.walletAddress || null, workspace.vaultAddress || null, workspace.blockchain || null, workspace.id]);
      return publicWorkspace(workspace);
    },
    async setPolicy(slug, policy) {
      const workspace = this.bySlug(slug);
      if (!workspace) throw new Error('Workspace not found');
      workspace.policy = policy;
      workspace.updatedAt = new Date().toISOString();
      await pool.query('UPDATE ipay_workspaces SET policy=$1::jsonb, updated_at=NOW() WHERE id=$2', [JSON.stringify(policy), workspace.id]);
      return publicWorkspace(workspace);
    },
  };
  const dataStore = {
    async read(workspace) {
      await init();
      const row = await pool.query('SELECT state FROM ipay_workspace_state WHERE workspace_id=$1', [workspace.id]);
      if (!row.rowCount) {
        const state = { version: 1, workspaceId: workspace.id, workspaceSlug: workspace.slug, wallet: { address: workspace.walletAddress, vaultAddress: workspace.vaultAddress }, milestones: [], audit: [], createdAt: new Date().toISOString() };
        await this.write(workspace, state);
        return state;
      }
      const state = row.rows[0].state;
      state.wallet = { ...(state.wallet || {}), address: workspace.walletAddress, vaultAddress: workspace.vaultAddress };
      return state;
    },
    async write(workspace, state) {
      await init();
      await pool.query('INSERT INTO ipay_workspace_state (workspace_id,state,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (workspace_id) DO UPDATE SET state=EXCLUDED.state, updated_at=NOW()', [workspace.id, JSON.stringify(state)]);
    },
  };
  return { registry, dataStore, close: () => pool.end() };
}
