# Deployment

## Prerequisites

- Node.js 22+
- Circle developer-controlled wallet on Arc Testnet or Arc mainnet, funded with USDC
- Circle Console API key and entity secret for that wallet
- An active Earn Kit USDC vault with enough withdrawal liquidity
- Network access to the CompliR API and the Arc RPC

The Circle CLI Agent Wallet session does not supply the credentials for Earn Kit's developer-controlled Circle Wallets adapter. Use the same developer-controlled wallet for Earn and contractor payments.

## Run the demo

```bash
npm install
npm start
```

Open http://127.0.0.1:3000. Demo milestones, balances, vault yield, and transfers are simulated. Data is stored in `.data/state.json`. `COMPLIR_MODE=live` can run real signed screening while payments remain simulated.

## Configure live payments

Set these variables in your local environment. A local `.env` is ignored by Git; start with `node --env-file=.env server.js` if using that file.

```text
IPAY_MODE=live
COMPLIR_MODE=live
IPAY_OWNER_TOKEN=<random secret of at least 32 characters>
EARN_CHAIN=Arc_Testnet
CIRCLE_API_KEY=<Circle Console API key>
CIRCLE_ENTITY_SECRET=<Circle entity secret>
CIRCLE_WALLET_ADDRESS=0x...
EARN_VAULT_ADDRESS=0x...
```

The server binds to `127.0.0.1`. The browser asks for the owner token and keeps it in memory for that tab. API reads and writes in live mode require it. Do not expose the local server directly to the internet. Live records are separate from demo data in `.data/live-state.json`; that file contains payment evidence and signed verdicts and needs durable, access-controlled storage for deployment.

Use `EARN_CHAIN=Arc` and `IPAY_ALLOW_MAINNET=YES` only when the wallet, vault, Circle credentials, and RPC are for Arc mainnet. The mainnet switch is explicit because live mode can send real USDC. Optional RPC overrides: `ARC_TESTNET_RPC_URL` and `ARC_MAINNET_RPC_URL`.

## Operate the Earn vault

Discover an active USDC vault and review its liquidity and fees. Set `EARN_VAULT_ADDRESS` to the selected vault.

```bash
npm run earn -- vaults
npm run earn -- position
npm run earn -- deposit 10.00 --execute
npm run earn -- withdraw 10.00 --execute
```

The separate Earn command submits real transactions and records them in `.data/earn-audit.jsonl`. To load variables from `.env`, use `node --env-file=.env earn.js` followed by the command and arguments.

## Live release flow

1. Create a milestone with a recipient address and USDC amount.
2. The owner records verification evidence. Submitting **Verify & release real USDC** starts the release.
3. iPay obtains and verifies a signed CompliR attestation. Only LOW may proceed.
4. If liquid wallet USDC is short, iPay withdraws the shortfall plus a small USDC gas reserve from the configured Earn vault, records the withdrawal hash, and obtains another fresh CompliR verdict. `IPAY_GAS_RESERVE_USDC` defaults to `0.10` and can be adjusted.
5. iPay sends USDC with Circle App Kit and checks the Arc receipt for a matching USDC transfer from the configured wallet to the contractor.
6. The milestone and audit store the signed verdict, payment hash, withdrawal hash when applicable, and yield snapshot.

MEDIUM goes to review; HIGH is blocked. Failed screening leaves the milestone verified without payment. Any uncertain withdrawal or payment enters `needs_reconciliation` and cannot be retried through the release button. Check the Circle transaction history and Arc explorer first. If a payment occurred, use **Reconcile tx** with its Arc hash; iPay marks it paid only when the receipt contains the matching USDC transfer. If only a withdrawal occurred, resolve the state manually before attempting another release.

The current owner token is a single shared secret, and the state is a local JSON file. A hosted multi-user deployment needs individual owner authentication, durable transactional storage, backups, and an operational reconciliation process.
