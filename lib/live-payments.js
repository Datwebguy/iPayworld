import { createPublicClient, decodeEventLog, formatUnits, http, parseUnits } from 'viem';
import { AppKit } from '@circle-fin/app-kit';
import { EarnKit } from '@circle-fin/earn-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';

const USDC = '0x3600000000000000000000000000000000000000';
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const transferEvent = [{ type: 'event', name: 'Transfer', inputs: [
  { name: 'from', type: 'address', indexed: true },
  { name: 'to', type: 'address', indexed: true },
  { name: 'value', type: 'uint256', indexed: false },
] }];

export function liveConfig(env = process.env) {
  const chain = env.EARN_CHAIN || 'Arc_Testnet';
  if (!['Arc_Testnet', 'Arc'].includes(chain)) throw new Error('EARN_CHAIN must be Arc_Testnet or Arc');
  if (chain === 'Arc' && env.IPAY_ALLOW_MAINNET !== 'YES') throw new Error('Set IPAY_ALLOW_MAINNET=YES to enable live mainnet payments');
  for (const name of ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'CIRCLE_WALLET_ADDRESS', 'EARN_VAULT_ADDRESS']) {
    if (!env[name]) throw new Error(`${name} is required for live payments`);
  }
  if (!addressPattern.test(env.CIRCLE_WALLET_ADDRESS) || !addressPattern.test(env.EARN_VAULT_ADDRESS)) throw new Error('Invalid Circle wallet or Earn vault address');
  const rpcUrl = chain === 'Arc' ? env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io' : env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io';
  const id = chain === 'Arc' ? 5042 : 5042002;
  const gasReserveUsdc = env.IPAY_GAS_RESERVE_USDC || '0.10';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(gasReserveUsdc)) throw new Error('IPAY_GAS_RESERVE_USDC must be a nonnegative USDC amount');
  return { chain, id, rpcUrl, walletAddress: env.CIRCLE_WALLET_ADDRESS, vaultAddress: env.EARN_VAULT_ADDRESS, gasReserveUsdc };
}

export function liveClients(env = process.env) {
  const config = liveConfig(env);
  const adapter = createCircleWalletsAdapter({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
  const from = { adapter, chain: config.chain, address: config.walletAddress };
  const publicClient = createPublicClient({ chain: { id: config.id, name: config.chain, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } }, transport: http(config.rpcUrl, { timeout: 15_000 }) });
  return { config, from, publicClient, earn: new EarnKit(), app: new AppKit() };
}

export async function liveBalances(clients) {
  const positionPromise = clients.earn.getPosition({ from: clients.from, vaultAddress: clients.config.vaultAddress })
    .catch(error => {
      if (/not registered|no position/i.test(error?.message || '')) {
        return { currentBalance: '0', pnl: { status: 'unavailable' } };
      }
      throw error;
    });
  const [chainId, liquid, position] = await Promise.all([
    clients.publicClient.getChainId(),
    clients.publicClient.readContract({ address: USDC, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [clients.config.walletAddress] }),
    positionPromise,
  ]);
  if (chainId !== clients.config.id) throw new Error(`Arc RPC is on chain ${chainId}, expected ${clients.config.id}`);
  const vault = parseUnits(position.currentBalance, 6);
  return { liquid, vault, liquidUsdc: formatUnits(liquid, 6), vaultUsdc: position.currentBalance, yieldEarned: position.pnl?.status === 'available' ? position.pnl.totalYieldEarned : null };
}

export async function assertUsdcVault(clients) {
  const result = await clients.earn.getVaults({ vaults: [{ chain: clients.config.chain, vaultAddress: clients.config.vaultAddress }] });
  const vault = result.vaults.find(item => item.vaultAddress.toLowerCase() === clients.config.vaultAddress.toLowerCase());
  if (!vault || vault.asset !== 'USDC' || vault.status !== 'active') throw new Error('Configured Earn vault must be an active USDC vault');
  return vault;
}

export async function depositToVault(clients, amount) {
  const result = await clients.earn.deposit({ from: clients.from, vaultAddress: clients.config.vaultAddress, amount });
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.txHash || '')) throw new Error('Earn deposit returned no transaction hash');
  return { txHash: result.txHash, amount: result.amount };
}

export async function withdrawForRelease(clients, amount) {
  const result = await clients.earn.withdraw({ from: clients.from, vaultAddress: clients.config.vaultAddress, amount });
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.txHash || '')) throw new Error('Earn withdrawal returned no valid transaction hash');
  return { txHash: result.txHash, amount: result.amount };
}

export async function sendPayment(clients, recipient, amount) {
  const result = await clients.app.send({ from: clients.from, to: recipient, amount, token: 'USDC' });
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.txHash || '')) throw new Error('Circle send returned no transaction hash');
  return { txHash: result.txHash, state: result.state, explorerUrl: result.explorerUrl };
}

export async function verifyPaymentReceipt(clients, txHash, recipient, amount) {
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
  if (receipt.status !== 'success') throw new Error('Arc payment transaction reverted');
  const expected = parseUnits(amount, 6);
  const matched = receipt.logs.some(log => {
    if (log.address.toLowerCase() !== USDC) return false;
    try {
      const event = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics });
      return event.eventName === 'Transfer' && event.args.from.toLowerCase() === clients.config.walletAddress.toLowerCase() && event.args.to.toLowerCase() === recipient.toLowerCase() && event.args.value === expected;
    } catch { return false; }
  });
  if (!matched) throw new Error('Arc receipt has no matching USDC transfer');
  const block = await clients.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return { blockNumber: receipt.blockNumber.toString(), transactionHash: receipt.transactionHash, blockTimestamp: Number(block.timestamp) };
}
