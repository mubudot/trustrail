# Status

## Done (offline)
- Contract `agent_spend_guard` builds to Wasm MVP (`wasm32v1-none`, ~120 KB) and deploys in the
  in-memory Concordium test chain. Tests: 9 unit (incl. shared vectors) + 14 integration.
- Node client (zero deps): policy mirror, x402 buyer flow, co-signer, badge check, audit log, mock
  facilitator/ledger/sellers. Tests: 13. `npm run demo:mock` walks through the 5 scenarios.

## Next
1. Testnet account(s) — test identity from "Concordium testnet IP" (no real ID), faucet CCD.
2. Deploy + init the guard on testnet; record the CCDExplorer links.
3. Register the agent in the testnet Agent Registry (hosted MCP builders), publish the Agent Card
   with the badge extension, bind the guard to `<12802,0>`.
4. Live chain adapter (`@concordium/web-sdk`) with the same API as `MockGuardChain`; live x402 via
   `@x402/concordium` (own facilitator if no public testnet one).
5. 2-of-2 agent account (account key update) + co-signer service.
6. Optional LLM planner (reuse from the PayPal entry), demo video, Checkpoint 1 text.

## Known limitations
- Contract cannot verify ZK identity proofs; owner identity = Concordium account (IdP-backed) +
  badge ownership. Payee badge check runs off chain (client).
- Mock tx digest is SHA-256 of canonical JSON, not the Concordium sign-hash (swapped in live mode).
- Expired, unsettled authorisations keep their budget reservation until cancelled (fail closed).
- Authorisation records are never pruned (storage paid by the agent's `authorize` call).
