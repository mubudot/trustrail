# Checkpoint 1 — what to paste on the Encode dashboard (due Sun 22 Nov 23:59 UTC = Mon 23 Nov 07:59 Taipei)

Dashboard → Concordium Trusted Agents Hackathon → **Create Project** (fields: Project Name,
Description (optional), Project Image (optional)). Solo team = just you. Also connect Discord in the
dashboard's "Discord Integration" section to get the programme channels.

**Project name:** TrustRail — no verified human, no payment

**Description (≈100 words):**
TrustRail lets an AI agent pay other agents and APIs with x402 on Concordium without handing it the
owner's wallet. An on-chain guard contract enforces caps, an allowlist of badge-verified payees and an
approval threshold. Above the threshold the payment needs a Concordium Verify-and-Access
zero-knowledge proof that the identity-verified owner approved that exact payment; the agent's 2-of-2
wallet is co-signed only after that proof re-verifies against the chain. Both agents carry Verified
by Concordium badges (CIS-8004), settlement is sponsored x402, and approval records plus the agent's
audit log are anchored on chain. Already live on testnet: guard <13037,0>.

Supporting evidence: [the offline attack suite](ATTACKS.md), runnable from the repository root
with `bash scripts/attacks.sh`. **156 tests pass** — contract 34 (9 unit + 25 integration), agent
31, live 91. The Node runner demonstrates 32 blocked attacks and 4 passing legitimate controls;
the Rust attack tests exercise the real contract Wasm.
