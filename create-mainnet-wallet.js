// Create the iPay operator wallet on Arc mainnet.
// Needs CIRCLE_LIVE_API_KEY and CIRCLE_LIVE_ENTITY_SECRET in the environment.
// Saves the result to .data/mainnet-wallet.json (ignored by git).
import { mkdirSync, writeFileSync } from 'node:fs';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const apiKey = process.env.CIRCLE_LIVE_API_KEY?.trim();
const entitySecret = process.env.CIRCLE_LIVE_ENTITY_SECRET?.trim();
if (!apiKey?.startsWith('LIVE_API_KEY:') || !entitySecret) throw new Error('Set CIRCLE_LIVE_API_KEY (LIVE_API_KEY:...) and CIRCLE_LIVE_ENTITY_SECRET first.');

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
try {
  const set = (await client.createWalletSet({ name: 'iPay Arc Mainnet operator' })).data?.walletSet;
  if (!set?.id) throw new Error('Circle did not return a wallet set');
  const wallet = (await client.createWallets({ walletSetId: set.id, blockchains: ['ARC'], count: 1, accountType: 'EOA' })).data?.wallets?.[0];
  if (!wallet?.address) throw new Error('Circle did not return a wallet');
  const record = { createdAt: new Date().toISOString(), walletSetId: set.id, walletId: wallet.id, address: wallet.address, blockchain: wallet.blockchain };
  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/mainnet-wallet.json', `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(`Created ${record.blockchain} wallet ${record.address}`);
  console.log('Saved to .data/mainnet-wallet.json. Use this address as CIRCLE_WALLET_ADDRESS on ipay-mainnet.');
} catch (error) {
  console.log(`Failed: ${error?.status || ''} ${error?.message}`);
  if (error?.status === 403) console.log('The key has no Wallets access on mainnet. Check production access, key permissions and IP allowlist in the Circle Console.');
}
