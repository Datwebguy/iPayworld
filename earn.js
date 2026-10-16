import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EarnKit } from '@circle-fin/earn-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';

const [, , command, ...args] = process.argv;
const usage = `Usage:
  npm run earn -- vaults
  npm run earn -- position
  npm run earn -- deposit <USDC amount> --execute
  npm run earn -- withdraw <USDC amount> --execute

Set EARN_CHAIN=Arc_Testnet or Arc, EARN_VAULT_ADDRESS, CIRCLE_WALLET_ADDRESS,
CIRCLE_API_KEY, and CIRCLE_ENTITY_SECRET in your environment. Vault discovery
only needs EARN_CHAIN. Deposit and withdrawal send real transactions.`;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const amountPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function context() {
  const address = required('CIRCLE_WALLET_ADDRESS');
  if (!addressPattern.test(address)) throw new Error('CIRCLE_WALLET_ADDRESS must be an EVM address');
  return {
    adapter: createCircleWalletsAdapter({
      apiKey: required('CIRCLE_API_KEY'),
      entitySecret: required('CIRCLE_ENTITY_SECRET'),
    }),
    chain,
    address,
  };
}

async function main() {
  if (!['vaults', 'position', 'deposit', 'withdraw'].includes(command)) throw new Error(usage);
  const kit = new EarnKit();
  if (command === 'vaults') {
    const { vaults, pagination } = await kit.exploreVaults({ chain, asset: 'USDC', pageSize: 100 });
    console.log(JSON.stringify({ chain, vaults, pagination }, null, 2));
    return;
  }
  const vaultAddress = required('EARN_VAULT_ADDRESS');
  if (!addressPattern.test(vaultAddress)) throw new Error('EARN_VAULT_ADDRESS must be an EVM address');
  const from = context();
  if (command === 'position') {
    console.log(JSON.stringify(await kit.getPosition({ from, vaultAddress }), null, 2));
    return;
  }
  const [amount, flag] = args;
  if (!amountPattern.test(amount || '') || Number(amount) <= 0) throw new Error('Amount must be positive USDC with at most six decimals');
  if (flag !== '--execute' || args.length !== 2) throw new Error('Add --execute to submit a real transaction');
  const { vaults } = await kit.getVaults({ vaults: [{ chain, vaultAddress }] });
  const vault = vaults.find(item => item.vaultAddress.toLowerCase() === vaultAddress.toLowerCase());
  if (!vault || vault.asset !== 'USDC' || vault.status !== 'active') throw new Error('Selected vault must be an active USDC vault');
  const result = await kit[command]({ from, vaultAddress, amount });
  const record = {
    at: new Date().toISOString(),
    action: command,
    chain,
    walletAddress: from.address,
    vaultAddress,
    requestedAmount: amount,
    txHash: result.txHash,
    resultAmount: result.amount,
  };
  console.log(JSON.stringify(record, null, 2));
  await mkdir('.data', { recursive: true });
  await appendFile(join('.data', 'earn-audit.jsonl'), `${JSON.stringify(record)}\n`);
}

const chain = process.env.EARN_CHAIN || 'Arc_Testnet';
if (!['Arc_Testnet', 'Arc'].includes(chain)) {
  console.error('EARN_CHAIN must be Arc_Testnet or Arc');
  process.exitCode = 1;
} else {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

