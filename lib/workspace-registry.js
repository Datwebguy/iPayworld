import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const tokenHash = token => createHash('sha256').update(token).digest('hex');
const slugify = value => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function createWorkspaceRegistry(dataDir) {
  const file = join(dataDir, 'workspaces.json');
  let workspaces = [];

  async function save() {
    await mkdir(dataDir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(workspaces, null, 2));
    await rename(temp, file);
  }

  return {
    async load() {
      try { workspaces = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        workspaces = [];
        await save();
      }
    },
    async create({ name, slug }) {
      const safeName = String(name || '').trim();
      const safeSlug = slugify(slug || safeName);
      if (!safeName || safeName.length > 100 || !safeSlug || safeSlug.length > 64) throw new Error('Enter a workspace name and valid slug');
      if (workspaces.some(item => item.slug === safeSlug)) throw new Error('That workspace slug is already in use');
      const ownerToken = `ipay_ws_${randomBytes(32).toString('base64url')}`;
      const workspace = {
        id: randomUUID(),
        name: safeName,
        slug: safeSlug,
        ownerTokenHash: tokenHash(ownerToken),
        status: 'pending_wallet',
        members: [],
        walletAddress: null,
        vaultAddress: null,
        policy: { maxPerTxUsdc: 5000, maxPerDayUsdc: 25000 },
        createdAt: new Date().toISOString(),
      };
      workspaces.push(workspace);
      await save();
      return { workspace: publicWorkspace(workspace), ownerToken };
    },
    list() { return workspaces.map(publicWorkspace); },
    bySlug(slug) { return workspaces.find(item => item.slug === slug) || null; },
    byOwnerToken(token) { return workspaces.find(item => token && item.ownerTokenHash === tokenHash(token)) || null; },
    accessByToken(token) {
      for (const workspace of workspaces) {
        if (token && workspace.ownerTokenHash === tokenHash(token)) return { workspace, role: 'owner' };
        const member = workspace.members?.find(item => token && item.tokenHash === tokenHash(token));
        if (member) return { workspace, role: member.role, member: { id: member.id, name: member.name } };
      }
      return null;
    },
    async addMember(slug, { name, role }) {
      const workspace = workspaces.find(item => item.slug === slug);
      const safeName = String(name || '').trim();
      if (!workspace) throw new Error('Workspace not found');
      if (!safeName || safeName.length > 100 || !['finance', 'reviewer'].includes(role)) throw new Error('Enter a member name and valid role');
      const accessToken = `ipay_member_${randomBytes(32).toString('base64url')}`;
      const member = { id: randomUUID(), name: safeName, role, tokenHash: tokenHash(accessToken), createdAt: new Date().toISOString() };
      workspace.members = [...(workspace.members || []), member];
      await save();
      return { member: publicMember(member), accessToken };
    },
    async setTreasury(slug, treasury) {
      const workspace = workspaces.find(item => item.slug === slug);
      if (!workspace) throw new Error('Workspace not found');
      Object.assign(workspace, treasury, { updatedAt: new Date().toISOString() });
      await save();
      return publicWorkspace(workspace);
    },
    async setPolicy(slug, policy) {
      const workspace = workspaces.find(item => item.slug === slug);
      if (!workspace) throw new Error('Workspace not found');
      workspace.policy = policy;
      workspace.updatedAt = new Date().toISOString();
      await save();
      return publicWorkspace(workspace);
    },
  };
}

function publicMember({ tokenHash, ...member }) { return member; }
function publicWorkspace({ ownerTokenHash, members, ...workspace }) { return { ...workspace, members: (members || []).map(publicMember) }; }
