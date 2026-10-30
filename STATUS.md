# Status (2026-10-30)

## Done (offline, nothing deployed)
- Contract `agent_spend_guard`: builds with cargo-concordium 5 (`build/agent_spend_guard.wasm.v1`,
  schema embedded, ~91 KB) and as a raw Wasm-MVP module for tests. Tests: 9 unit (incl. shared
  vectors) + 16 integration (in-memory chain).
- Node client (zero deps): policy mirror, x402 buyer flow, co-signer with on-chain commit, badge
  check, hash-chained audit log, mock facilitator/ledger/sellers. Tests: 24. `npm run demo:mock`.
- Codex review 1 (work/concordium_codex1.md in the project workspace, not in the repo) — fixes:
  - P1 budget refund after payment: new `Committed` state; the co-signer must `commitPayment(id,
    digest)` on chain before it signs; committed authorisations can never be cancelled/refunded.
  - P1 single use across co-signer restarts/replicas: enforced by that on-chain transition.
  - P1 co-signer ignored pause/generation/allowlist: re-checked locally and by `commitPayment`.
  - P1 2-of-2 account could not call the guard: split into agent **control account** (single key,
    calls the guard) and agent **wallet** (2-of-2, holds the budget, pays x402); wallet stored in
    the agent record and must not be the agent, the owner or a payee.
  - P2 settlement: tx hash can settle only one authorisation (`DuplicateSettlement`); recording is
    always possible once committed; HTTP failure after commit is logged as `settlement_unknown`.
  - P2 mock/contract parity: shared `validatePolicy`, wallet rules, `removeAgent`, error list now
    checked against the Rust enum source.
  - Codex's own fixes: replay-safe mock ledger/facilitator (nonce), hosted badge response parsing,
    file-backed audit log (BigInt-safe, resumes chain).

## Next
1. Testnet account(s) — test identity from "Concordium testnet IP" (no real ID), faucet CCD.
2. Deploy + init the guard on testnet; record the CCDExplorer links.
3. Register the agent in the testnet Agent Registry (hosted MCP builders), publish the Agent Card
   with the badge extension, bind the guard to CIS-8004 `<12802,0>`, set `agentWallet` = wallet.
4. Live adapters: `@concordium/web-sdk` guard client (same API as `MockGuardChain`), real
   transaction sign-hash, `@x402/concordium` payload (PLT ops are CBOR-encoded; asset ids are bare
   token ids), fetch adapter (`headers.get`, `json()`); own facilitator if no public testnet one.
5. 2-of-2 wallet (account key update) + co-signer service; reconciler that matches committed
   digests to finalised transactions.
6. Optional LLM planner, demo video, Checkpoint 1 text.

## Known limitations
- The contract cannot verify ZK identity proofs; owner identity = Concordium account
  (IdP-backed) + badge ownership (CIS-2 `balanceOf` only — Active status / card hash are checked
  off chain). Losing the badge pauses the agent only when someone calls `recheckBadge`.
- Payee badge checks run in the client; a hostile agent process could skip them (the on-chain
  allowlist still binds).
- `recordSettlement` stores the reported tx hash; it is not verified on chain (reconcile off chain
  against the committed digest).
- Daily caps charge the authorisation's UTC day, not the day the transfer finalises.
- Preflight refusals are logged off chain only (they never reach the contract).
- Mock tx digest is SHA-256 of canonical JSON, not the Concordium sign-hash.
- Expired, uncommitted authorisations keep their budget until cancelled (fail closed).
- Authorisation records are never pruned (storage paid by the `authorize` caller).
- The audit hash chain detects edits/deletions inside the log; anchoring its head on chain is next.
