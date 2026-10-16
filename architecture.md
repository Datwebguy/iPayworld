# Architecture

## Components

- **Circle developer-controlled wallet** — holds live USDC budget and signs Earn and payment operations
- **Yield layer** — idle USDC ↔ Earn Kit USDC vault
- **Risk gate** — CompliR attestation call
- **Release logic** — convert + send USDC on Arc
- **Audit store** — milestone + signed verdict + tx + yield snapshot

## Data flow

Owner funds wallet  
→ idle USDC to Earn vault  
→ milestone created  
→ work verified  
→ CompliR(address) → signed verdict  
→ if LOW: withdraw vault USDC when needed → fresh CompliR check → transfer USDC  
→ verify Arc receipt → write audit record

## Policy

- Auto-pay only on LOW
- Escalate MEDIUM
- Block HIGH
- Every payment stores the signed CompliR verdict

Current implementation: a Circle developer-controlled wallet signs Earn vault operations and live Arc payments. The dashboard can run in demo or live mode; live mode requires an owner token, signed CompliR screening, and explicit Circle and Earn configuration. A local JSON file stores payment intents and outcomes, with uncertain transactions held for manual reconciliation.
