# Resources

## Event
- Tameion page: https://tameion.thecanteenapp.com/
- Luma: https://luma.com/ivroypr5 (passphrase: DIRECTx42490)
- Submission form: https://forms.gle/BBWrdfuircrKiG2i6
- Deadline: October 17, 11:59 PM ET

## Discord
- Canteen: https://discord.gg/bDaEfsSqc8
- Arc builders: https://discord.com/invite/buildonarc (mention Canteen + Tameion)

## CLI
### ARC CLI (Canteen)
```bash
uv tool install git+https://github.com/the-canteen-dev/ARC-cli
arc-canteen login
arc-canteen rpc-url
arc-canteen context sync
```

### Documentation and repository
- Docs: https://arc-node.thecanteenapp.com/
- Repo: https://github.com/the-canteen-dev/ARC-cli

## Circle CLI
```bash
npm install -g @circle-fin/cli
circle --version
circle wallet list --type agent --chain ARC
circle wallet fund --address <ADDRESS> --chain ARC --amount 10 --method crypto
```

For Arc Testnet, Circle documents faucet funding with `circle wallet fund --address 0xYOUR_WALLET_ADDRESS --chain ARC-TESTNET` (without `--amount` or `--method`).

## Documentation

- Circle CLI: https://developers.circle.com/agent-stack/circle-cli
- Circle Agent Stack: https://developers.circle.com/agent-stack
- Arc docs: https://docs.arc.io
- Agents and Ledgers: https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html

## Sample apps (Circle)

- arc-escrow: https://github.com/circlefin/arc-escrow
- arc-fintech: https://github.com/circlefin/arc-fintech
- arc-x402-circle-wallets: https://github.com/circlefin/arc-x402-circle-wallets
- arc-nanopayments: https://github.com/circlefin/arc-nanopayments
- Context bundle: https://github.com/the-canteen-dev/context-arc

## CompliR

- Site: https://trycomplir.xyz
- Agent prompt: https://trycomplir.xyz/docs/agent-prompt
- Endpoint: `GET https://trycomplir.xyz/api/v1/attestation/<address>`
- Attestation format and verification: https://trycomplir.xyz/docs/attestations

## Yield references

- Earn Kit overview: https://docs.arc.io/app-kit/earn
- Earn deposit guide: https://docs.arc.io/app-kit/quickstarts/earn-deposit
- Earn withdrawal guide: https://docs.arc.io/app-kit/quickstarts/earn-withdraw
- Circle Wallet adapter setup: https://docs.arc.io/app-kit/tutorials/adapter-setups
- USYC Teller (future eligible-business reserve): https://usyc.docs.hashnote.com/overview/smart-contracts
