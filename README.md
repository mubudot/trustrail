# TrustRail — accountable spending for AI agents on Concordium

Give an AI agent a wallet without giving it your wallet. A verified human owner sets a spending
policy on chain; the agent pays other agents and APIs with **x402** on Concordium, but every payment
must first get an on-chain authorisation from the **agent_spend_guard** contract, and the agent's
paying account is **2-of-2**: the agent holds one key, a small deterministic co-signer holds the
other and signs only transfers that exactly match an approved authorisation. Payees must present a
**Verified by Concordium** badge that is bound to the account being paid. Every step leaves an
on-chain event and a hash-chained audit entry.

Status: early build for the Concordium Trusted Agents Hackathon (Encode Club). Contract and offline
client are working and tested; **testnet deployment is not done yet** (see [STATUS.md](STATUS.md)).

```
owner (Concordium account, identity-backed)          payee agent / API (x402 seller)
  | registerAgent(badge, policy, allowlist)              ^  402 PaymentRequirements (+ badge)
  | approve / reject / pause / withdraw                  |  200 + PAYMENT-RESPONSE
  v                                                      |
agent_spend_guard ──balanceOf──> CIS-8004 Agent Registry |  (owner must hold the agent NFT)
  ^ authorize / recordSettlement                         |
  |                                                      |
AI agent ── preflight ── badge check ── sponsored V1 transfer, signed by
            (same rules)  (payTo bound   key 0 (agent) + key 1 (co-signer, only if it
                          to the badge)  matches an Approved, unexpired authorisation)
                                         ──> facilitator sponsors fees + settles
```

## What stops what

| The agent (or whoever hijacked it) tries to … | Stopped by |
| --- | --- |
| pay an address it was talked into | payee badge check (`payee_not_bound_to_badge`), contract allowlist (`NotAllowlisted`) |
| drain the budget in one or many payments | per-tx and UTC-daily caps on chain; pending requests reserve budget |
| make a large payment without a human | approval threshold → `Pending` until the owner approves |
| pay without asking the contract, or pay more than authorised | 2-of-2 account: the co-signer signs only the exact authorised payee/amount/asset/purpose, once, before expiry |
| keep going after misbehaving | owner pause (global/per agent); the agent can pause itself; losing the badge auto-pauses (`recheckBadge`) |
| hide what it did | contract events + authorisation records with the x402 settlement tx hash; hash-chained off-chain log |

## Layout

```
contract/            Rust smart contract (concordium-std 11)
  src/policy.rs      pure deterministic policy (unit-tested natively)
  src/spend.rs       authorize / approve / reject / cancel / recordSettlement
  src/admin.rs       init, agent registry, policy, pause, funds, badge re-check
  src/badge.rs       CIS-8004 (CIS-2 balanceOf) badge ownership check
  src/views.rs       views + on-chain preflight
  src/{types,error,events}.rs
  tests/guard.rs     end-to-end tests of the Wasm in an in-memory chain
agent/               Node client (no dependencies)
  src/agent.mjs      TrustedAgent: badge → preflight → authorize → co-signed x402 → settle
  src/policy/        JS mirror of the policy + error codes
  src/payments/      x402 client + sponsored-transfer payload
  src/cosigner/      the deterministic co-signer
  src/identity/      payee badge check (fixture or hosted Agent Registry REST)
  src/audit/         hash-chained audit log
  src/chain/         guard adapter (mock now; testnet adapter next)
  src/mock/          offline world: ledger, facilitator (9 x402 rules), sellers
spec/policy_vectors.json  shared vectors run by BOTH the Rust and the JS tests
```

## Run it (offline, no keys)

```bash
# client: tests + demo (Node 20+)
cd agent && npm test && npm run demo:mock

# contract: needs Rust (rust-toolchain.toml pins 1.99.1 + wasm32v1-none)
./scripts/build-wasm.sh            # builds build/agent_spend_guard.wasm (+ test-only registry)
cd contract && cargo test          # unit tests + shared vectors + Wasm integration tests
```

`build-wasm.sh` uses `cargo concordium build --schema-embed` when cargo-concordium is installed and
always also builds the raw module for the tests.

## Concordium components used

- **Agent Registry / Verified by Concordium badge** (CIS-8004, testnet `<12802,0>`): the guard binds
  each agent to a badge held by the owner; the client checks payee badges.
- **x402 on Concordium** (exact scheme, sponsored V1 transfer — the agent needs no CCD for fees).
- **Sponsored transactions** via the x402 facilitator.
- **Concordium ID**: every account is identity-backed; the owner is the accountable human.

## AI assistance

Built with AI coding assistants (design, code and review), with all code run and tested locally.

## License

MIT
