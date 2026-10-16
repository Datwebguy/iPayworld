# iPay: first live Arc Testnet payment

This walkthrough uses **testnet USDC**. The Circle CLI Agent Wallet is separate from the developer-controlled Circle wallet that iPay's Earn Kit adapter uses.

## 1. Install the local tools

Install [Node.js 22.18 or newer](https://nodejs.org/en/download). In PowerShell, from this iPay folder:

```powershell
node --version
npm install
```

The iPay server reads `.env` with Node's `--env-file` option. `npm start` alone does not load that file.

## 2. Set up Circle

1. Sign in to [Circle Console](https://console.circle.com/) and create a **test** server-side API key. See [Circle API keys](https://developers.circle.com/api-reference/keys).
2. Generate and register your entity secret in Circle Console. Download the recovery file and keep it separately from the secret. See [Circle's entity secret guide](https://developers.circle.com/wallets/dev-controlled/register-entity-secret).
3. Follow [Create a dev-controlled wallet](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet): create a wallet set, then an `EOA` wallet on `ARC-TESTNET`. Record its public `0x...` address. This is the budget wallet used for both Earn and payments.
4. Have a **second Arc Testnet address you control** for the contractor recipient. The Circle wallet quickstart also explains how to add another wallet to a wallet set.

Keep the API key, entity secret, and recovery file private. The public wallet addresses can be shared.

## 3. Get testnet USDC

Open the [Circle faucet](https://faucet.circle.com/), choose **USDC** and **Arc Testnet**, paste the budget wallet address, and request funds. The public faucet currently offers 20 testnet USDC per address every two hours. Confirm the balance in Circle Console or the [Arc Testnet explorer](https://explorer.testnet.arc.io/).

## 4. Configure this repo

In PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

Open `.env` in an editor. Replace the existing `IPAY_MODE=demo` line with `IPAY_MODE=live`. Make sure each setting below appears **once**, without a leading `#`, with your own values:

```text
IPAY_MODE=live
COMPLIR_MODE=live
EARN_CHAIN=Arc_Testnet
CIRCLE_API_KEY=YOUR_TEST_API_KEY
CIRCLE_ENTITY_SECRET=YOUR_REGISTERED_ENTITY_SECRET
CIRCLE_WALLET_ADDRESS=0xYOUR_BUDGET_WALLET
IPAY_OWNER_TOKEN=YOUR_RANDOM_OWNER_TOKEN
```

Generate an owner token locally with this PowerShell command, then paste its output into `.env`:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

The owner token is different from the Circle entity secret. Leave `IPAY_ALLOW_MAINNET` commented out. `.env` is in `.gitignore`.

## 5. Choose a USDC Earn vault

```powershell
node --env-file=.env earn.js vaults
```

Choose a vault whose `asset` is `USDC`, `status` is `active`, and `liquidity` is comfortably above the intended withdrawal. Review its fees and protocol details. [Earn Kit's vault discovery guide](https://docs.arc.io/app-kit/quickstarts/earn-deposit) explains these fields; discovery is not a curated allowlist.

Add its address to `.env`:

```text
EARN_VAULT_ADDRESS=0xYOUR_SELECTED_VAULT
```

Read the initial position:

```powershell
node --env-file=.env earn.js position
```

## 6. Deposit and inspect

With 20 testnet USDC from the faucet, this example deposits 15, leaving some liquid USDC for gas and part of the payment:

```powershell
node --env-file=.env earn.js deposit 15.00 --execute
node --env-file=.env earn.js position
```

The first deposit may require an approval transaction. Save the returned transaction hash and inspect it in the [Arc Testnet explorer](https://explorer.testnet.arc.io/). The [Circle Earn deposit guide](https://docs.arc.io/app-kit/quickstarts/earn-deposit) covers the SDK flow. Testnet yield may be small or unavailable over a short demo window.

## 7. Release one milestone

Start the live server:

```powershell
node --env-file=.env server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000), enter your owner token, and create a small milestone such as **6.00 USDC** to the second Arc Testnet address you control. Record real verification evidence and select **Verify & release real USDC**.

If CompliR returns a signed `LOW` verdict, iPay withdraws the wallet's USDC shortfall from the vault, runs a fresh risk check, and pays the recipient. `MEDIUM` requires review; `HIGH` blocks payment. The example amount is intended to make a withdrawal necessary after a 15 USDC deposit, though the exact balance depends on transaction fees.

Check the milestone and audit trail for the signed verdict, vault withdrawal hash, payment hash, and yield snapshot. Check the payment hash in the [Arc Testnet explorer](https://explorer.testnet.arc.io/). If the milestone says `needs_reconciliation`, inspect Circle's transaction history and the explorer before doing anything else. Use **Reconcile tx** only when an Arc payment occurred; it checks the recipient, amount, sender, and signed verdict validity. Do not start a second payment for the same milestone.

## What to share back here

Send me the **public budget wallet address**, **public vault address**, and what happened at the last step you reached. You may include an Arc transaction hash or an error message after removing any secret values. Do **not** send the API key, entity secret, recovery file, or owner token in chat.

## Local Circle testnet configuration

This workspace is configured for a Circle developer-controlled EOA on Arc Testnet.

- Wallet address is saved in `.env` as `CIRCLE_WALLET_ADDRESS`.
- The active Earn Kit USDC vault is saved in `.env` as `EARN_VAULT_ADDRESS`.
- Wallet metadata is stored locally in `.data/circle-wallet.json`.

### Fund the wallet

Circle's faucet API can require additional account access. Open the [Circle Faucet](https://faucet.circle.com/), select **Arc Testnet**, and request both test USDC and native gas for the `CIRCLE_WALLET_ADDRESS` value in `.env`.

Then check the Earn position:

```bash
npm run earn -- position
```

Deposit a small test amount only after the position shows funded:

```bash
npm run earn -- deposit 1 --execute
```
