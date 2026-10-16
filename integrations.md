# Integrations

| Component | Role in iPay | Docs / Link |
|-----------|--------------|-------------|
| Circle developer-controlled wallet | Signs Earn vault operations | https://docs.arc.io/app-kit/tutorials/adapter-setups |
| Circle Agent Wallets | Intended contractor budget wallet; read-only testnet balance available now | https://developers.circle.com/agent-stack/agent-wallets |
| Earn Kit USDC vault | Idle funds earn until release | https://docs.arc.io/app-kit/earn |
| CompliR | Pre-payment risk check (signed verdict) | https://trycomplir.xyz |
| Arc | Settlement (USDC gas, <500ms) | https://docs.arc.io |
| Nanopayments / Gateway | Optional payment rail | https://developers.circle.com/agent-stack |
| Contracts | Optional milestone escrow rules | https://github.com/circlefin/arc-escrow |

Implementation note: Earn Kit's USDC vault is the working yield path. The CLI can deposit, read positions, and withdraw through a Circle developer-controlled wallet. Live dashboard mode uses that wallet for milestone releases and Arc USDC payments. Demo mode remains simulated. USYC Teller is reserved for a possible future eligible-business integration.

## Minimal integration order

1. Provision and fund a Circle developer-controlled wallet on Arc
2. Earn Kit USDC vault → park idle USDC from that wallet
3. CompliR call before any outbound transfer
4. Connect the same wallet to the release loop and transfer USDC after an acceptable verdict
5. Log signed verdict + tx hash
