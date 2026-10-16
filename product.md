# iPay Product

## Business
Small teams and freelancers who pay contractors on milestones.

## Job
Hold the project budget, earn on the idle portion, check risk before release, and pay only when the work is verified.

## Core loop
1. Owner funds a Circle developer-controlled wallet with USDC
2. Idle USDC is deposited into an Earn Kit USDC vault
3. Owner creates a milestone (amount + description)
4. Work is marked complete / verified
5. Agent calls CompliR: `GET https://trycomplir.xyz/api/v1/attestation/<address>`
6. Verdict (LOW / MEDIUM / HIGH) + signed proof is returned
7. LOW → auto-release; MEDIUM → escalate; HIGH → block
8. Required USDC is withdrawn from the vault and sent on Arc
9. Full record is stored (milestone, CompliR verdict, tx, yield snapshot)

## What the owner sees
- Remaining budget and current yield
- Active / completed milestones
- Payments released or blocked (with CompliR reason)
- Audit trail of every decision and signed verdict

USYC through its Teller is a future reserve option for eligible businesses. The working yield path is an Earn Kit USDC vault.
