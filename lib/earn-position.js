const addressPattern = /^0x[a-fA-F0-9]{40}$/;

export async function readEarnPosition() {
  const { EARN_CHAIN, EARN_VAULT_ADDRESS, CIRCLE_WALLET_ADDRESS, CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET } = process.env;
  if (!EARN_VAULT_ADDRESS || !CIRCLE_WALLET_ADDRESS || !CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) return { configured: false };
  const chain = EARN_CHAIN || 'Arc_Testnet';
  if (!['Arc_Testnet', 'Arc'].includes(chain)) throw new Error('EARN_CHAIN must be Arc_Testnet or Arc');
  if (!addressPattern.test(EARN_VAULT_ADDRESS) || !addressPattern.test(CIRCLE_WALLET_ADDRESS)) throw new Error('Invalid Earn vault or wallet address');
  const [{ EarnKit }, { createCircleWalletsAdapter }] = await Promise.all([
    import('@circle-fin/earn-kit'),
    import('@circle-fin/adapter-circle-wallets'),
  ]);
  const adapter = createCircleWalletsAdapter({ apiKey: CIRCLE_API_KEY, entitySecret: CIRCLE_ENTITY_SECRET });
  const position = await new EarnKit().getPosition({
    from: { adapter, chain, address: CIRCLE_WALLET_ADDRESS },
    vaultAddress: EARN_VAULT_ADDRESS,
  }).catch(error => {
    if (/not registered|no position/i.test(error?.message || '')) {
      return { currentBalance: '0', pnl: { status: 'unavailable' } };
    }
    throw error;
  });
  return {
    configured: true,
    chain,
    walletAddress: CIRCLE_WALLET_ADDRESS,
    vaultAddress: EARN_VAULT_ADDRESS,
    currentBalance: position.currentBalance,
    yieldEarned: position.pnl?.status === 'available' ? position.pnl.totalYieldEarned : null,
  };
}
