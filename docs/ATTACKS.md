# Attack suite — what stops what

From the repository root, after installing the existing live dependencies (`cd live && npm ci`)
and configuring **your Rust toolchain** as in the README:

```bash
bash scripts/attacks.sh
```

This builds the test Wasm with the existing build script, runs `cargo test --offline --test attacks
-- --nocapture --test-threads=1`, then runs the Node demonstrations. Build output is saved in
`.tmp/attacks-build.log` and shown on failure. Cargo networking is disabled. Dependencies must
already be cached; the tests and demonstrations need no network, deployment keys or transactions.

For just the Node suite:

```bash
cd live
npm run attacks
npm run --silent attacks -- --json
```

Each attack must return its **exact expected production refusal**; every legitimate control must
succeed. Unexpected acceptance, a different refusal, an exception or a failed control prints
`[UNEXPECTED]` and exits 1. JSON has `results` (id, label, layer, expected, actual, status) and
`summary` (blocked, passed, unexpected). Controls cover a real 4 CCD human approval, a 0.5 CCD
auto-approved payment, an active badge with its original card, and settlement/audit verification.
The Rust tests also demonstrate legitimate pre-expiry, unpause and new-generation operations.

Measured suites: **156 tests** — contract **9 unit + 25 integration = 34**, agent **31**, live
**91**. The Node runner prints **32 attacks BLOCKED, 4 controls PASS, 0 unexpected**. The 7 new
Rust tests print 27 contract refusals and 3 controls (additional to the Node summary).

The Node runner calls **LiveCosigner, checkApproval, HostedBadgeResolver/checkPayee,
checkAuditAnchor, settlementMatchesCommitment and MockGuardChain**. Its guard adapter only
translates schema shapes and dispatches to MockGuardChain; it contains no policy or lifecycle
decisions. Contract tests execute the guard Wasm in Concordium's in-memory chain, using the
test-only CIS-2 registry to answer `balanceOf`.

| Attack | Attacker action | Blocking layer | Exact refusal | Test / runner id |
| --- | --- | --- | --- | --- |
| Replay payment proof | Present the real auth-5 Verification Audit Record as another auth's approval | Co-signer → human approval | `approval_wrong_resource` | `attack suite 01` |
| Replay for changed payee / amount | Keep the original resource but change the payment context | Human approval | `approval_wrong_payment_details` | `attack suite 02`, `03` |
| Bit-flipped credential proof | Alter a byte of the real credential's ZK proof, keeping the chain hash | Human approval | `approval_hash_mismatch` | `attack suite 04` |
| Made-up anchor hash | Owner approves with a fabricated hash while supplying the real record | Co-signer → human approval | `approval_hash_mismatch` | `attack suite 05` |
| Missing record | Owner approves a fabricated hash without an audit record | Co-signer | `human_approval_record_unavailable` | `attack suite 06` |
| Forged proof with new hash | Alter the credential proof and recompute its anchor hash | Human approval / SDK ZK verifier | `approval_proof_invalid` | `attack suite 34` |
| Stolen badge | Claim the seller's badge but request payment to another address | Client badge check | `payee_not_bound_to_badge` | `attack suite 20` |
| Nonexistent badge | Registry cannot find the claimed badge | Client badge check | `payee_badge_invalid` | `attack suite 21` |
| Revoked / expired badge | Registry reports a status other than Active | Client badge check | `payee_badge_revoked` | `attack suite 22`, `23` |
| NFT not held | Re-register using a nonexistent token whose `balanceOf` is 0 | Contract | `BadgeNotOwned`; subsequent authorize: `NotAgent` | `nonexistent_nft_registration_is_atomic_and_does_not_bump_generation` (C19–C20) |
| Badge lost after authorization | Burn NFT, then have anyone invoke `recheckBadge`; try existing approval/commit | Contract | `AgentPaused` | `badge_loss_recheck_invalidates_existing_approval_and_commit_paths` (C21–C22) |
| Badge revoked / card changed while awaiting approval | Purchase passes the badge check, waits for human approval; meanwhile the badge is revoked or the card hash changes; then resume | Buyer resume re-check; co-signer re-checks the badge itself right before `commitPayment` (also when the buyer skips its check) | `payee_badge_revoked`, `payee_card_hash_mismatch` (stage `identity`, or `cosigner`); authorisation released | `agent/test/flow.test.mjs` (2 tests); `live/test/cosigner-live.test.mjs` (2 tests) |
| Tampered Agent Card | Change local card JSON after its original hash was pinned; registry returns a different fetched SHA-256 | Client badge check | `payee_card_hash_mismatch` | `attack suite 24`; `agent/test/attacks.test.mjs` |
| Wrong transfer payee / amount | Submit an agent-signed transfer differing from the human-approved authorization | Co-signer | `tx_payee_mismatch`, `tx_amount_mismatch` | `attack suite 08`, `09` |
| Removed allowlist entry | Remove payee after approval, or skip preflight with an unlisted payee | Co-signer; mock guard; contract | `payee_not_allowlisted`; `NotAllowlisted` | `attack suite 13`, `27`; `bypassed_client_checks_preserve_caps_allowlist_and_auth_counter` (C25–C27) |
| Paused agent | Owner pauses after approval; try authorize, approve and commit | Co-signer; contract | `agent_paused`; `AgentPaused` | `attack suite 10`; `administrative_pause_blocks_every_payment_entrypoint_until_resumed` (C08–C10) |
| Paused guard | Owner pauses the guard; try authorize, approve and commit | Co-signer; contract | `guard_paused`; `Paused` | `attack suite 11`; same Rust test (C11–C13) |
| Removed agent / generation bump | Remove and re-register; try old approvals and commits; cancel old reservations to refund the new generation | Co-signer; contract | `stale_generation`; `NotAgent`, `StaleGeneration`; cancellation leaves new budget intact | `attack suite 12`; `stale_generation_cancellation_cannot_steal_new_generations_budget` (C15–C18) |
| Expired authorization | Approve one millisecond before TTL, then try commit at TTL; try pending approve at TTL | Co-signer; contract | `authorization_expired`; `Expired` | `attack suite 14`; `approval_one_millisecond_before_expiry_does_not_extend_ttl` (C06–C07) |
| Transfer outlives approval | Transfer expires within the co-signer's window but beyond the authorization's shorter TTL | Co-signer | `tx_outlives_authorization` | `attack suite 15` |
| Double co-sign / restart | Reuse the same approved auth in the same or a restarted co-signer | Co-signer + mock guard | `status_Committed` | `attack suite 16`, `17` |
| Replica race | Two co-signers read Approved concurrently and race to commit | Co-signer + mock guard atomic commit | `commit_WrongStatus` for loser; exactly one signature | `attack suite 35` |
| Double commit / replace digest | Commit a human-approved auth, then try a different digest | Contract; mock guard | `WrongStatus` | `attack suite 28`; `committed_human_approval_cannot_be_reused_or_refunded` (C02) |
| Re-approve Approved / Committed | Owner tries to approve an already approved or committed auth | Contract; mock guard | `WrongStatus` | `attack suite 29`; same Rust test (C01, C03) |
| Refund committed budget | Owner, agent or co-signer cancels a committed auth, then tries spending its booked budget | Contract; mock guard | `WrongStatus`, then `DailyCap` | `attack suite 30`; same Rust test (C04–C05) |
| Skip cap checks | Call authorize directly over per-tx or daily cap, including mixed Pending/Approved/Committed reservations | Contract; mock guard | `PerTxCap`, `DailyCap` | `attack suite 25`, `26`; `bypassed_client_checks_preserve_caps_allowlist_and_auth_counter` (C23–C24) |
| Raise human threshold | Owner configures a threshold above 4 CCD so the guard auto-approves it | Co-signer's pinned threshold | `human_approval_missing_pinned_threshold` | `attack suite 18` |
| Rewrite audit history | Rewrite entries and recompute a valid local hash chain while retaining the old on-chain anchor | Audit anchor verifier | `anchor head is not the hash of the last log entry` | `attack suite 32` |
| Substitute settlement hash | Guard records a transaction whose two wallet signatures cover a different digest | Settlement verifier | `settlement_not_signed_over_commitment` (the runner's name for `settlementMatchesCommitment` returning `false`; that API has no reason code) | `attack suite 33` |

The new Rust cases check additional invariants after rejection: commitments stay unchanged, failed
requests do not allocate auth ids, reservations stay booked, failed NFT registration does not bump
generation, and old-generation cancellations cannot refund the new generation's budget. New live
cases combine the actual human verifier and co-signer with the actual mock guard, rather than
stubbing the approval check or accepting a fake commit.

## Public proof fixture and trust boundaries

`live/attacks/fixtures/approval-chain.json` contains public read-only testnet responses captured on
2026-10-31 while the real `checkApproval` successfully verified `live/state/approvals/auth-5.json`.
It contains cryptographic parameters, public account credential commitments (no revealed
attributes), the slot time of the block that finalized the request anchor, and the two finalized RegisterData transaction summaries. The adapter
restores SDK hash/address/date types. The SDK still performs the ZK and anchor checks; no successful
verification result is recorded or stubbed. This is a frozen chain fixture, not a claim about
current credential status. Offline authorizations and ephemeral signing keys exist only in memory.
The CLI regression test forbids network connections and checks every JSON result.

Card fixtures use the real local card and public deployment pin. The resolver compares the hosted
service's `card_sha256` with `on_chain.metadata_hash_hex` and honours an explicit failed
`hash_matches_on_chain` check, even if `badge_valid` is contradictory. This is a small client
hardening added with this suite; previously the client relied solely on the aggregate verdict.
It continues to trust the hosted registry to report the fetched card and chain fields correctly.

Observed limits, not simulated protections:

- **Settlement substitution is detected after recording.** `recordSettlement` cannot inspect an
  external transaction; it accepts a reported hash. The real settlement verifier detects a digest
  mismatch. The suite does not claim the contract prevents recording it.
- **The owner can raise the on-chain threshold.** The separately pinned co-signer threshold blocks
  payment. The mock fixture registers the resulting policy because MockGuardChain has no
  `updatePolicy`; the co-signer check is unchanged production code.
- **NFT loss needs `recheckBadge`.** Registration checks ownership; a later burn does not trigger
  an automatic guard call. The contract attack explicitly rechecks before exercising the pause.
- **An unused proof field can change.** Changing the originally empty top-level
  `presentation.proof.proofValue` was accepted by the SDK for this single-credential record. It is
  not the credential's ZK proof. No SDK change was made; attacks 04/34 mutate the actual credential
  proof and are refused, including when the attacker recomputes the hash.

## Optional read-only testnet run

```bash
cd live
npm run attacks -- --testnet
```

This runs only the read-only checks, without running the offline signing demonstrations. It uses
the fixed testnet node and hard-checks the full genesis hash
`4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796` and the testnet network constant
before reading the deployment. A different network is a failure. No signing, transaction sending,
or secret loading occurs.

It verifies the real auth-5 ZK approval and both anchors (T1), presents the real auth-3 record
against auth-5's on-chain `human_proof` (T2, `approval_hash_mismatch`), runs the hosted registry's
current response for badge #977 through the payee check unchanged (T3, must pass, so the card-hash
hardening above causes no false refusal), and checks a tampered local copy of `…/agents/977.json`
against the registry's current on-chain pin (T4, `payee_card_hash_mismatch`). Expected summary:
**2 attacks BLOCKED, 2 controls PASS, 0 unexpected**. Node
unavailability produces `[SKIPPED] ... testnet_node_unreachable`; it does not fail the offline suite.
Other unexpected failures still exit 1. `--json` works with this mode too.
