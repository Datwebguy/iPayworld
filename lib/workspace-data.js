import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const validSlug = value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function createWorkspaceDataStore(dataDir) {
  const directory = join(dataDir, 'workspaces');
  const fileFor = slug => {
    if (!validSlug(slug)) throw new Error('Invalid workspace');
    return join(directory, `${slug}.json`);
  };

  return {
    async read(workspace) {
      const file = fileFor(workspace.slug);
      try {
        const state = JSON.parse(await readFile(file, 'utf8'));
        state.wallet = { ...(state.wallet || {}), address: workspace.walletAddress, vaultAddress: workspace.vaultAddress };
        return state;
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const state = {
          version: 1,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          wallet: { address: workspace.walletAddress, vaultAddress: workspace.vaultAddress },
          milestones: [],
          audit: [],
          createdAt: new Date().toISOString(),
        };
        await this.write(workspace, state);
        return state;
      }
    },
    async write(workspace, state) {
      const file = fileFor(workspace.slug);
      await mkdir(directory, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2));
      await rename(temp, file);
    },
  };
}
