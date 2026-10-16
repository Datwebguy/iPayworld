# iPay

**Proof-gated contractor payments for teams.** iPay creates a dedicated Circle treasury for each business, keeps approved idle USDC in an Earn Kit vault, obtains a signed CompliR risk attestation before every release, and settles verified contractor milestones on Arc.

> **Network status:** live application on **Arc Testnet**. It creates real Circle developer-controlled testnet wallets, requests test USDC, calls CompliR, and sends testnet USDC. Mainnet remains deliberately disabled until production Circle credentials, an approved vault, and funded mainnet wallets are configured.

## Links

- **Application:** [ipay-five.vercel.app](https://ipay-five.vercel.app)
- **Create a business workspace:** [ipay-five.vercel.app/onboard.html](https://ipay-five.vercel.app/onboard.html)
- **API:** [ipay-api-production.up.railway.app/api/config](https://ipay-api-production.up.railway.app/api/config)
- **Arc documentation:** [docs.arc.io](https://docs.arc.io)
- **Circle Agent Stack:** [developers.circle.com/agent-stack](https://developers.circle.com/agent-stack)
- **CompliR:** [trycomplir.xyz](https://trycomplir.xyz)

## What iPay does

1. A platform administrator creates a business workspace.
2. The workspace owner provisions a dedicated Circle developer-controlled wallet on Arc.
3. The owner funds it with Arc Testnet USDC and can deposit idle USDC into a configured Earn Kit vault.
4. A finance member creates a contractor milestone.
5. An owner or reviewer attaches verification evidence.
6. iPay retrieves and verifies a signed CompliR attestation for the contractor wallet.
7. `LOW` releases the verified amount; `MEDIUM` enters review; `HIGH` is blocked.
8. When liquid USDC is short, iPay withdraws only the required amount plus a gas reserve from Earn Kit.
9. iPay validates the Arc receipt, then stores the milestone, evidence, signed risk verdict, transaction hashes, and yield snapshot in the audit record.

## Platform capabilities

| Capability | Implementation |
| --- | --- |
| Business isolation | Each workspace has its own Circle wallet, milestones, role tokens, limits, and audit data. |
| Roles | Owner, finance, and reviewer access tokens. |
| Treasury | Circle developer-controlled wallets on `ARC-TESTNET`. |
| Yield | Earn Kit USDC vault deposits and withdrawals. |
| Risk gate | Signed CompliR attestation is mandatory before sending USDC. |
| Release controls | Per-transaction and daily USDC limits; default $5,000 / $25,000. |
| Recovery | Uncertain sends enter `needs_reconciliation`; a receipt must validate before marking them paid. |
| Audit | PostgreSQL-backed workspace records with CSV export. |

## Arc Testnet deployment

The deployed API currently reports:

```json
{ "mode": "live", "chain": "Arc_Testnet" }
```

| Setting | Value |
| --- | --- |
| Network | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Asset | Test USDC |
| Wallet type | Circle developer-controlled EOA |
| Frontend | Vercel |
| API and database | Railway + PostgreSQL |

### Try the hosted Testnet product

1. Open [workspace onboarding](https://ipay-five.vercel.app/onboard.html).
2. Create a workspace with the platform owner token.
3. Save the displayed workspace owner token. It is shown only once.
4. Select **Provision treasury** to create that business's Circle testnet wallet.
5. Select **Request test funds**. Circle credits test USDC and native gas asynchronously.
6. Open the workspace dashboard, create a small milestone to a testnet recipient address, then verify it with evidence.
7. iPay runs CompliR and releases only on a signed `LOW` result.

Use testnet addresses and test USDC only. Do not enter a production private key, Circle API key, entity secret, owner token, or recovery file in a browser form or GitHub issue.

## Run locally

### Prerequisites

- [Node.js 22 or newer](https://nodejs.org/en/download)
- A Circle developer-controlled wallet project for live Testnet operations
- Circle API key and entity secret
- A reachable Earn Kit USDC vault on the selected network

```bash
git clone https://github.com/Datwebguy/iPayworld.git
cd iPayworld
npm install
Copy-Item .env.example .env
npm start
```

Open `http://127.0.0.1:3000`. With the default `.env`, iPay runs entirely in demo mode and never creates a chain transaction.

### Local Testnet configuration

Set the following values in `.env`. `.env` is ignored by Git.

```dotenv
IPAY_MODE=live
COMPLIR_MODE=live
EARN_CHAIN=Arc_Testnet
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network

CIRCLE_API_KEY=YOUR_CIRCLE_TEST_API_KEY
CIRCLE_ENTITY_SECRET=YOUR_REGISTERED_ENTITY_SECRET
CIRCLE_WALLET_ADDRESS=0xYOUR_CIRCLE_TESTNET_WALLET
EARN_VAULT_ADDRESS=0xYOUR_EARN_TESTNET_VAULT

IPAY_OWNER_TOKEN=GENERATE_A_RANDOM_32_CHARACTER_OR_LONGER_SECRET
IPAY_GAS_RESERVE_USDC=0.10
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
```

Generate a local owner token in PowerShell:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

The wallet address is public. API keys, entity secrets, owner tokens, member access tokens, database URLs, and recovery files are secrets.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `IPAY_MODE` | Yes | `demo` for simulation, `live` for Testnet/mainnet operations. |
| `COMPLIR_MODE` | Live only | Must be `live` when `IPAY_MODE=live`. |
| `EARN_CHAIN` | Live only | `Arc_Testnet` today; `Arc` after mainnet approval. |
| `CIRCLE_API_KEY` | Live only | Circle developer-controlled wallet API key. |
| `CIRCLE_ENTITY_SECRET` | Live only | Entity secret registered with Circle. |
| `CIRCLE_WALLET_ADDRESS` | Global live treasury | Circle wallet used by the global dashboard. Tenant wallets are provisioned per workspace. |
| `EARN_VAULT_ADDRESS` | Live only | Earn Kit USDC vault address. |
| `IPAY_OWNER_TOKEN` | Live only | Platform administrator credential. |
| `DATABASE_URL` | Hosted multi-tenant | Railway PostgreSQL connection string. |
| `IPAY_GAS_RESERVE_USDC` | Optional | USDC retained for settlement, default `0.10`. |
| `IPAY_ALLOW_MAINNET` | Mainnet only | Must equal `YES` before mainnet operations can start. |

## API overview

All workspace endpoints require a Bearer token. Workspace owner tokens are created during onboarding; finance and reviewer tokens are issued by the owner.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/workspaces` | Create a workspace (platform owner). |
| `POST /api/workspaces/:slug/provision-treasury` | Create a dedicated Circle wallet. |
| `POST /api/workspaces/:slug/fund-testnet` | Request Circle test USDC and gas. |
| `POST /api/workspaces/:slug/members` | Issue a finance or reviewer access token. |
| `POST /api/workspaces/:slug/milestones` | Create a payment milestone. |
| `POST /api/workspaces/:slug/milestones/:id/verify` | Store evidence and begin the compliance-gated release. |
| `POST /api/workspaces/:slug/milestones/:id/reconcile` | Confirm an uncertain payment from its Arc receipt. |
| `POST /api/workspaces/:slug/earn/deposit` | Deposit idle USDC into Earn Kit. |
| `PUT /api/workspaces/:slug/policy` | Update owner-controlled daily and per-payment limits. |
| `GET /api/workspaces/:slug/audit.csv` | Export the workspace audit trail. |

## Mainnet cutover

Do this only after completing a small Testnet end-to-end payment and operational review.

1. Create or select a **production** Circle developer-controlled wallet project and register a production entity secret.
2. Select an Arc mainnet Earn Kit USDC vault; review liquidity, fees, terms, and withdrawal behavior.
3. Create and fund dedicated business wallets with mainnet USDC and native gas.
4. Configure Railway with production-only values: `EARN_CHAIN=Arc`, production Circle credentials, the mainnet vault, `ARC_MAINNET_RPC_URL`, and `IPAY_ALLOW_MAINNET=YES`.
5. Keep `IPAY_MODE=live` and `COMPLIR_MODE=live`; do not bypass the signed CompliR check.
6. Verify the production vault and recipient flow with a minimal, approved payment.
7. Update this README's network status and deployment details only after the transaction is confirmed.

## Architecture and supporting docs

- [Architecture](architecture.md)
- [Product specification](product.md)
- [Integration map](integrations.md)
- [Testnet setup guide](setup-guide.md)
- [Deployment guide](deployment.md)
- [Operational resources](resources.md)
- [Hackathon submission](submission.md)

## Security model

iPay never places Circle credentials in client code. Secrets stay in server environment variables. Workspace and member tokens are stored only as SHA-256 hashes. The UI keeps a token in `sessionStorage` for the active browser session. Payment proof is independently checked against the Arc receipt before a release is recorded as paid.

This is an early-stage Testnet product. Before handling production customer funds, complete a security review, introduce account-based authentication and token rotation, configure backups and monitoring, establish an incident and reconciliation runbook, and obtain legal/compliance review for the intended markets.

## Development

```bash
npm test
npm run earn -- vaults
npm run create-wallet
npm run fund-testnet
```

`npm run earn` and the wallet scripts execute real configured network operations. Review your `.env` network setting before running them.
