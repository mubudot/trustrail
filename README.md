# TrustRail — no verified human, no payment

**An AI agent pays other agents over x402 on Concordium from a 2-of-2 wallet whose second key
signs a large payment only after a zero-knowledge proof shows that the identity-verified owner
approved *that exact payment* — with the proof anchored on chain for audit.**

Live on Concordium **testnet**: guard contract [<13037,0>](https://ccdexplorer.io/testnet/instance/13037/0),
Verified-by-Concordium badges for both agents, real x402 settlements, ZK approval records and an
anchored audit log. Every link: [docs/TESTNET.md](docs/TESTNET.md). The agent's Art. 12-style audit
record, one CCDExplorer link per transaction: [docs/AUDIT_LOG.md](docs/AUDIT_LOG.md). Re-check it
yourself without any key: `cd live && npm ci && npm run verify`.

## Why this is different from "caps + an approve button"

Most agent wallets stop at a spend limit and a human-in-the-loop flag that any process holding
the owner key can flip. TrustRail makes the human part *cryptographic and specific*:

1. **The approval is a Concordium Verify-and-Access proof**, made from the owner account's
   identity credential (testnet IdP): "I am an adult with a valid Concordium identity, and I hold
   the credential of the account that owns this agent." No personal data is revealed.
2. **The proof is bound to one payment.** The verification request is anchored on chain and names
   the guard, the authorisation id, the payee, the amount and the purpose hash. A valid proof for
   one payment cannot approve another (we tried — [docs/TESTNET.md](docs/TESTNET.md), row 4).
3. **Nothing pays without it.** The agent's paying wallet is a native Concordium **2-of-2** account.
   The agent holds key 0; a small deterministic co-signer holds key 1 and signs only a transfer that
   matches an approved on-chain authorisation *and* whose human-approval record re-verifies against
   the chain. Owner key alone + made-up proof → no payment (row 3). (What the owner key *can* do is
   listed below.)
4. **Afterwards anyone can audit it.** The Verification Audit Record's hash sits in the guard's
   authorisation (`human_proof`) and in a RegisterData anchor; the agent's hash-chained audit log
   head is anchored with `anchorAudit`. That is an EU AI Act Art. 12-style record. On mainnet, with a
   real verified identity behind the owner account, it gives a lawful route back to an accountable
   person (Concordium identity disclosure only via Privacy Guardians and a court order); in this
   testnet demo the identity has the testnet IdP's dummy attributes and the proof is made by a
   script holding the owner's testnet seed, so it shows the mechanism, not a real person. The readable record, with block times, an on-chain anchor check and an
   Art. 12 mapping, is [docs/AUDIT_LOG.md](docs/AUDIT_LOG.md) (`npm run audit:doc` regenerates it).

## How a payment flows

```
seller (x402, badge #978)        buyer agent (badge #977, owned by the verified human)
  402 + PaymentRequirements  ->  1. payee badge check (hosted Agent Registry: Active, card hash, payTo bound)
                                 2. local preflight (same policy as the contract)
                                 3. guard.authorize  -> on chain: caps, allowlist, threshold
                                    > 2 CCD: Pending  -> 4. owner: ZK proof (Verify and Access) -> audit
                                                           record anchored -> guard.approve(id, anchorHash)
                                 5. agent signs key 0 of the 2-of-2 wallet
                                 6. co-signer: re-checks auth + tx + human proof, commitPayment (once) ,
                                    signs key 1
  <- PAYMENT-SIGNATURE ---------- 7. x402 retry; facilitator (@x402/concordium) sponsors + settles
                                 8. guard.recordSettlement(id, txHash); audit entry; anchorAudit(head)
```

## What stops what

Run every attack offline with `bash scripts/attacks.sh`. The [attack suite](docs/ATTACKS.md)
maps each attack to its production check, exact refusal and regression test, with legitimate
controls and optional read-only testnet checks.

| The agent's logic misbehaves (prompt injection, a bug, skipped client checks) and tries to … | Stopped by |
| --- | --- |
| pay an address it was talked into | payee badge must be bound to `payTo` (`payee_not_bound_to_badge`), re-checked by the co-signer right before it commits (so a badge revoked while the payment waited for approval also stops it); on-chain allowlist |
| pay more than the per-payment / daily cap, even skipping the client | guard contract rejects on chain (`PerTxCap`, `DailyCap`) |
| make a large payment without a human | Pending until approved; the co-signer needs a verifying ZK approval record |
| pay twice from one approval / change the transfer after approval | `commitPayment` stores the exact sign-hash once; co-signer signs only that; `verify` checks the settled transaction was signed over that hash |
| quietly rewrite history | guard events + authorisation records; ZK audit records anchored; audit-log head anchored |

| Someone holding **only the owner key** tries to … | What happens |
| --- | --- |
| approve a large payment with a fake or replayed proof | co-signer re-verifies proof, credential owner, resource id, payment details and anchor hash → refuses and cancels (rows 3–4 in [docs/TESTNET.md](docs/TESTNET.md)) |
| raise `approval_threshold` with `updatePolicy` so large payments skip `Pending` | **the contract accepts it** — the owner key alone can change the policy. The co-signer keeps its own pinned threshold (`humanProofAbove`, set from the registered policy) and still demands a verified-human proof above it, so such payments fail closed (`human_approval_missing_pinned_threshold`). `npm run verify` checks the on-chain threshold is not above the pinned one. |
| raise caps, add an allowlisted payee, pause/unpause, withdraw escrow | allowed: the owner key is the policy administrator. Large x402 payments still need the human proof (above). |

## Trust assumptions and known limitations

- **The owner key is trusted as policy administrator.** The contract cannot verify ZK proofs, so it
  cannot require one for `updatePolicy`; changing that would need a new two-step (owner proposes,
  co-signer confirms after checking a proof) and a redeploy of the testnet instance (the module has
  no upgrade entrypoint). The human gate for payments is enforced by the co-signer, which pins its
  own threshold. Keep the owner and co-signer keys with different operators.
- **In the demo the co-signer runs inside the agent's Node process.** `live/src/world.mjs` loads
  both wallet keys into one process for convenience, so the demo shows an agent whose *logic* is
  subverted (e.g. it skips its own preflight and calls the guard directly — row 6), not one whose
  host is fully compromised. Someone with code execution in that process could read key 1 and sign
  alone. In a real deployment the co-signer is a separate service (own host, own key store; the
  owner or a custodian) that the agent reaches over an API; `LiveCosigner.cosign()` is already that
  boundary (plain-JSON inputs, a signature or a refusal out).
- **The co-signer is trusted to follow the rules.** Its key is half of the 2-of-2 wallet; if it is
  stolen together with the agent key, the wallet can be drained. It is deterministic, small and
  open source so it can be audited and run by the owner or a custodian.
- **The contract does not check the settlement against the commitment.** `commitPayment` stores
  the sign-hash the co-signer signed, but `recordSettlement` accepts the transaction hash the agent
  or co-signer reports: a contract cannot read other transactions, and the high-level web-sdk
  client only returns transaction summaries. The check is done off chain instead: `npm run verify`
  fetches the finalized settlement through the raw gRPC `GetBlockItems` stream and requires both
  wallet signatures in it to be valid signatures on the committed digest
  (`live/src/settlement-check.mjs`). A wrong hash recorded on chain is therefore detectable by
  anyone, but not prevented at record time.
- **An audit anchor proves the log as of that anchor.** `verify` requires the anchor to cover
  every entry of the submitted log (a rewritten tail fails), and every transaction the log or
  `state/run.json` names, plus every on-chain settlement, to be finalized at or before the anchor.
  For payments it also reads from chain how many authorisations the guard holds (`next_auth_id`)
  and each one's current status, and requires the log to record that lifecycle (authorised;
  approved if a proof is set; co-signed if committed; settled with the exact on-chain settlement
  hash; refused if cancelled or rejected). Presenting an older anchor with a log truncated before a
  payment step therefore fails without trusting `state/run.json`, and a failed chain read fails the
  check. What it does not cover: administrative guard actions (`updatePolicy`, `setPaused`, agent
  registration) are not reconciled against the log, so a log truncated only after such an action
  can still match an older anchor; whoever holds an anchoring key (owner, agent or co-signer) could
  anchor a rewritten log as a new head; and entries that leave no on-chain trace (requests, quotes,
  local preflight refusals) are only as good as that anchor. On-chain guard events and
  authorisation records remain the independent trail.
- **Escrow mode is not proof-gated.** Escrow approvals pay from the contract directly, without the
  co-signer; the demo and the human-approval claim use x402 mode only.
- The approval proof is made by a script holding the owner's testnet seed. In production the owner's
  Concordium ID app answers the anchored request (same V1 format).

## Layout

```
contract/            Rust smart contract agent_spend_guard (concordium-std 11), 34 tests (9 unit + 25 integration)
  src/spend.rs       authorize / approve(id, human_proof) / reject / cancel / commitPayment / recordSettlement
  src/audit.rs       anchorAudit (audit-log head on chain)
  src/admin.rs, badge.rs (CIS-8004 balanceOf check), views.rs, policy.rs, types.rs, events.rs, error.rs
agent/               Offline reference client + mock chain (zero dependencies), 33 tests
live/                Testnet adapters (@concordium/web-sdk 12, @x402/* 2.29), 91 offline tests
  src/human-approval.mjs   Verify-and-Access V1: request -> ZK presentation -> audit record -> re-check
  src/cosigner-live.mjs    the co-signer (key 1 of the 2-of-2 wallet)
  src/live-agent.mjs       buyer pipeline;  src/x402-buyer.mjs / x402-seller.mjs  real x402
  src/guard-client.mjs     schema-typed guard calls;  src/registry-mcp.mjs  hosted Agent Registry MCP
  src/audit-anchor.mjs     anchor check;  src/audit-report.mjs  Art. 12-style audit record (docs/AUDIT_LOG.md)
  tools/                   identity, accounts, faucet, deploy, badges/cards, check-badge, verify-testnet, doc generators
  demo/testnet.mjs         the live scenarios;  state/  public deployment record + evidence
  deployed/                the exact module + schema deployed on testnet
docs/TESTNET.md      every address and transaction with CCDExplorer links
docs/AUDIT_LOG.md    the agent's audit log as an Art. 12-style record (CCDExplorer links, block times)
docs/RUNBOOK.md      testnet from scratch: identity, accounts, guard, CIS-8004 badges, x402 payments
docs/USER_STEPS.md   what only the entrant has to do (dashboard, publishing)
```

## Run it

One command for the offline contract + co-signer [attack demonstrations](docs/ATTACKS.md):
`bash scripts/attacks.sh` (existing dependencies installed and your Rust toolchain configured).

```bash
# offline (no keys, no network)
cd agent && npm test && npm run demo:mock
cd contract && cargo test            # after ./scripts/build-wasm.sh (Rust 1.99.1 + wasm32v1-none)
cd live && npm ci && npm test
cd live && npm run attacks          # Node attacks only; add -- --json for JSON output

# read-only checks of the live testnet deployment (no keys)
cd live && npm run verify       # 23 checks: badges, guard, ZK approval, settlements, audit anchor
npm run check-badge             # both badges through the hosted Agent Registry MCP (check_badge)
npm run audit:doc               # regenerate docs/AUDIT_LOG.md from live/state/audit.jsonl + chain
```

Reproducing the deployment from scratch (own throwaway testnet identity, accounts, faucet,
contract, badges, demo) is scripted in `live/tools/`, step by step in [docs/RUNBOOK.md](docs/RUNBOOK.md).
The suites contain **158 tests**: contract 34, agent 33, live 91. The offline Node attack runner
reports **32 attacks BLOCKED, 4 controls PASS, 0 unexpected**; the root command also runs 7 Rust
attack tests that print 27 contract refusals and 3 legitimate controls.

## Concordium components used

- **Concordium ID / Verify and Access** (Verifiable Presentation V1, account-credential ZK proof,
  Verification Audit Record + on-chain anchors) — approver = verified human bound to the owner account.
- **Agent Registry (CIS-8004) + Verified by Concordium badge** — both agents registered via the
  hosted MCP builders; Agent Cards with the badge extension; `check-badge` passes; the guard checks
  on chain that the owner holds the agent NFT.
- **x402 on Concordium** (`@x402/concordium` exact scheme) with **sponsored transactions** — the
  agent's wallet pays no fees.
- **Native multi-key accounts** — the 2-of-2 wallet is what makes the co-signer binding.

## Path to production

Same contract and flow on mainnet: the owner's identity from a real IdP (passport + liveness in the
Concordium wallet); the approval proof requested by the owner's wallet (Concordium ID app) instead of
a script; badges from the mainnet registry `<10082,0>`; the co-signer run by the owner or a custodian
(e.g. Dfns) with an HSM-held key; budgets in a PLT stablecoin (EURR/USDR) — the code path for PLT
transfers exists in the policy, not yet in the live buyer; a hosted facilitator for sponsorship.

## AI assistance

Built with AI coding assistants (design, code and review), with all code run and tested locally and
on testnet.

## License

MIT
