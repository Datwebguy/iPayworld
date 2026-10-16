# iPay — Tameion Agents Hackathon Submission

> Draft: an integrated live release path is implemented but has not been exercised with funded Circle credentials. Do not claim a live payment until an Arc transaction is completed and recorded.

## One-liner
Agent that manages contractor budgets on Arc, earns on idle USDC in an Earn Kit vault, runs a signed CompliR risk check before every release, and pays only when the milestone is verified.

## RFB alignment
- **RFB 03** (Contractor & Vendor Network Manager) — primary
- **RFB 05** (Compliance Intelligence Agent) — CompliR graded signed verdict
- **RFB 01** (Intelligent Business Treasury) — Earn Kit USDC vault for idle funds
- **RFB 04** (Autonomous Business Operator) — agent applies release policy and can submit Arc USDC payments

## What was built during Tameion
- Read-only Arc Testnet balance display for a configured Agent Wallet
- Developer-controlled Circle wallet path for live Earn vault withdrawals and Arc USDC contractor payments
- Standalone Earn Kit vault discovery, position, deposit, and withdrawal commands
- Live signed CompliR check before a release
- Milestone create → owner verify → check → vault withdrawal if needed → Arc payment loop
- Audit trail that stores the signed CompliR verdict

## Demo
- Video (< 3 min): [PLACEHOLDER]
- Live link: [PLACEHOLDER]
- Repo: [PLACEHOLDER]

## Traction (fill in)
- Businesses onboarded:
- Value moved (USDC):
- Problems solved:
