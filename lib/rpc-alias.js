// Circle's SDKs (App Kit, Earn Kit, Wallets adapter 1.x) hardcode rpc.testnet.arc.network,
// which no longer resolves. Their deposits and confirmation waits fail through it, so
// requests to that host are redirected to the working Arc RPC. Remove once Circle ships a fix.
const target = new URL(process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io');
const DEAD_HOSTS = new Set(['rpc.testnet.arc.network']);

const originalFetch = globalThis.fetch;
globalThis.fetch = function fetchWithArcAlias(input, init) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (raw) {
      const url = new URL(raw);
      if (DEAD_HOSTS.has(url.host)) {
        url.protocol = target.protocol;
        url.host = target.host;
        url.pathname = target.pathname === '/' ? url.pathname : target.pathname;
        return originalFetch(input instanceof Request ? new Request(url, input) : url.href, init);
      }
    }
  } catch {}
  return originalFetch(input, init);
};
