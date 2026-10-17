const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USDC = '0x3600000000000000000000000000000000000000';
const DEFAULT_RPC = 'https://rpc.testnet.arc.io';
const TESTNET_CHAIN_ID = '0x4cef52';

async function rpc(url, method, params, fetcher) {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Arc RPC returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`Arc RPC error: ${result.error.message || 'unknown'}`);
  if (typeof result.result !== 'string') throw new Error('Arc RPC response is missing a result');
  return result.result;
}

export async function readArcWallet({ address = process.env.ARC_WALLET_ADDRESS, rpcUrl = process.env.ARC_TESTNET_RPC_URL || DEFAULT_RPC, fetcher = fetch } = {}) {
  if (!address) return { configured: false, network: 'Arc Testnet' };
  if (!ADDRESS.test(address)) throw new Error('ARC_WALLET_ADDRESS must be a 20-byte hex address');
  const chainId = await rpc(rpcUrl, 'eth_chainId', [], fetcher);
  if (chainId.toLowerCase() !== TESTNET_CHAIN_ID) throw new Error(`Expected Arc Testnet chain 5042002, got ${chainId}`);
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const balanceHex = await rpc(rpcUrl, 'eth_call', [{ to: USDC, data }, 'latest'], fetcher);
  if (!/^0x[0-9a-fA-F]+$/.test(balanceHex)) throw new Error('Arc RPC returned an invalid USDC balance');
  const micros = BigInt(balanceHex);
  return { configured: true, network: 'Arc Testnet', address, balanceUsdc: `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`, observedAt: new Date().toISOString() };
}
