# iPay

**A payments agent for contractor work, built on Arc.** Contractors submit their work through a private link. iPay's agent checks it against what was agreed, screens the contractor's wallet with CompliR, and pays in USDC on Arc only when both hold up. Every decision comes with a reason you can read.

Built for the Tameion Agents Hackathon (Canteen, Circle and Arc).

| | Website | API |
| --- | --- | --- |
| **Mainnet** | [ipayonarc.vercel.app](https://ipayonarc.vercel.app) | [ipay-mainnet-production.up.railway.app](https://ipay-mainnet-production.up.railway.app/api/config) |
| **Testnet** | [ipayonarctestnet.vercel.app](https://ipayonarctestnet.vercel.app) | [ipay-api-production.up.railway.app](https://ipay-api-production.up.railway.app/api/config) |

## Who it's for

Studios, agencies and small teams that pay freelancers per milestone. Today they either pay before anyone has checked the work, or pay a wallet nobody has checked at all. iPay holds the budget, checks both, and pays.

## How it works

1. **Sign up with a business name.** No email, no card. iPay creates a Circle developer-controlled wallet on Arc that belongs to that business alone, and gives the owner a workspace handle and a key. The same screen signs returning users in.
2. **Add money.** Send USDC to the workspace wallet. On testnet the setup screen walks you through the Circle faucet and detects the deposit. On Arc, USDC also pays for gas, so it is the only token a business needs.
3. **Create a milestone.** Amount, contractor wallet, and what counts as done. The amount is set aside, and the milestone gets a private contractor link.
4. **The contractor delivers.** They open the link, describe the work and add a link to it. No account needed.
5. **The agent decides.** It compares the delivery with the agreed scope and the contractor's history, then pays, holds it for the owner, or asks for changes, with a plain-language reason.
6. **CompliR screens the wallet.** iPay fetches CompliR's attestation for the recipient and verifies its EIP-712 signature against CompliR's published attester. Only a signed `LOW` verdict can pay. `MEDIUM` is held for review, `HIGH` is blocked, and nothing moves.
7. **USDC settles on Arc.** iPay confirms the transfer in the Arc receipt and stores the milestone, delivery, agent reasoning, signed verdict and transaction together in the workspace history, exportable as CSV.

Idle budget can sit in a Circle Earn USDC vault. iPay withdraws exactly what a payment needs.

## Guardrails the agent cannot talk past

The model decides; the server enforces.

- **Auto-pay limit** set by the owner (default $250). Anything above it is held for approval.
- **Per-payment and daily limits** per workspace (default $5,000 and $25,000).
- **CompliR signature check** on every payment, against a pinned attester address.
- **Contractor text is untrusted.** Instructions inside a delivery note are ignored and treated as a reason to hold.
- **Arc receipt check** before a payment is recorded as paid. Payments whose confirmation times out are confirmed automatically from their transaction hash.

## Stack

| Layer | Used for |
| --- | --- |
| **Arc** (testnet and mainnet) | USDC settlement and gas |
| **Circle Developer-Controlled Wallets** | One wallet per business, created at signup |
| **Circle App Kit** | Sending USDC to contractors |
| **Circle Earn** | Interest on idle budget, withdrawn on demand |
| **CompliR** | Signed counterparty risk verdicts before every payment |
| **OpenAI** (`gpt-5.4-mini`) or **Claude** | The agent's decisions; a built-in rules engine is the fallback |
| **Railway** | API servers and storage (PostgreSQL on testnet, volume on mainnet) |
| **Vercel** | The website for each network |

## Run locally

Requires Node.js 22 or newer.

```bash
git clone https://github.com/Datwebguy/iPayworld.git
cd iPayworld
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`. The default `.env` runs in demo mode: payments and screening are simulated and nothing touches a chain. For live Arc Testnet operation, fill in the live section of `.env` (see below) and set `IPAY_MODE=live`.

```bash
npm test                       # CompliR verification tests
npm run earn -- vaults         # list Circle Earn USDC vaults
npm run create-wallet          # create a testnet operator wallet
node create-mainnet-wallet.js  # create a mainnet operator wallet (live Circle key)
```

The wallet and Earn scripts perform real network operations. Check `EARN_CHAIN` before running them.

## Configuration

| Variable | Purpose |
| --- | --- |
| `IPAY_MODE` | `demo` (simulated) or `live` |
| `COMPLIR_MODE` | `live` is required when `IPAY_MODE=live` |
| `EARN_CHAIN` | `Arc_Testnet` or `Arc` |
| `IPAY_ALLOW_MAINNET` | Must be `YES` to run with `EARN_CHAIN=Arc` |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle developer-controlled wallets (test or live key) |
| `CIRCLE_WALLET_ADDRESS` | Operator wallet required at startup; business wallets are created per workspace |
| `EARN_VAULT_ADDRESS` | Circle Earn USDC vault |
| `IPAY_OWNER_TOKEN` | Admin key for the operator view (`/app?operator`), 32+ characters |
| `OPENAI_API_KEY`, `IPAY_OPENAI_MODEL` | Agent decisions with OpenAI |
| `ANTHROPIC_API_KEY`, `IPAY_AGENT_MODEL` | Agent decisions with Claude (takes priority when set) |
| `DATABASE_URL` | PostgreSQL; without it, data is stored as files in `IPAY_DATA_DIR` |
| `IPAY_SIGNUPS_PER_HOUR`, `IPAY_SIGNUPS_PER_DAY` | Public signup limits (default 5 and 500) |
| `IPAY_GAS_RESERVE_USDC` | USDC kept back for gas, default `0.10` |
| `ARC_TESTNET_RPC_URL`, `ARC_MAINNET_RPC_URL`, `ARC_EXPLORER_URL` | Network overrides |

## API

Workspace endpoints take a Bearer key: the owner key from signup, or a finance or reviewer key issued by the owner.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/signup` | Create a workspace and its Circle wallet (public, rate limited) |
| `GET /api/workspaces/:slug/state` | Balances, milestones, history, agent status |
| `POST /api/workspaces/:slug/milestones` | Create a milestone and its contractor link |
| `GET`, `POST /api/deliver` | Contractor delivery page data and submission (authorized by the link token) |
| `POST /api/workspaces/:slug/milestones/:id/verify` | Owner approves and pays |
| `POST /api/workspaces/:slug/milestones/:id/release` | Pay an approved milestone |
| `PUT /api/workspaces/:slug/agent` | Turn the agent on or off, set the auto-pay limit |
| `POST /api/workspaces/:slug/agent/run` | Run the agent now |
| `POST /api/workspaces/:slug/earn/deposit` | Move USDC to the Earn vault |
| `POST /api/workspaces/:slug/members` | Issue a finance or reviewer key |
| `GET /api/workspaces/:slug/audit.csv` | Export the history |

## Security notes

Circle credentials and model keys stay on the server. Workspace and member keys are stored only as SHA-256 hashes; the browser keeps the key for the current tab only. iPay holds no customer funds of its own: each business's money sits in its own wallet.

iPay is an early product. Before handling significant customer funds it needs a security review, account-based authentication with key rotation, monitoring, and legal and compliance review for its markets.
