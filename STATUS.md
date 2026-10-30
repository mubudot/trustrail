# Status (2026-10-31)

## Live on Concordium testnet (details and links: docs/TESTNET.md)
- Throwaway test identity from the **Concordium testnet IdP** (its own dummy attributes, no real
  documents), created programmatically (`live/tools/identity-start.mjs`, `identity-finish.mjs`).
- Six accounts from that identity (owner, agent control, 2-of-2 agent wallet, co-signer, seller,
  facilitator) via credential deployment (`create-accounts.mjs`), funded from the wallet-proxy faucet
  (`faucet.mjs`) and by the owner (`fund.mjs`). Keys: `live/.secrets/` (gitignored, mode 600).
  An earlier set of six accounts (credential numbers 0–5) was created with a bug in the attribute
  randomness and is unused.
- Guard module deployed + instance `<13037,0>` bound to CIS-8004 `<12802,0>` (`deploy-guard.mjs`).
- Agent NFTs #977 (owner, buyer agent) and #978 (seller) minted through the hosted Agent Registry
  MCP builders; Agent Cards built by the MCP, served at a demo host, hashes pinned with setAgentURI;
  hosted `check-badge`: valid for both (`registry-mint.mjs`, `publish-agent-cards.mjs`).
- Agent registered in the guard with badge #977 — the contract checked `balanceOf` on the real
  registry (`register-agent-in-guard.mjs`).
- Demo run (`demo/testnet.mjs`): two real x402 payments (0.5 CCD auto, 4 CCD after a ZK human
  approval), forged-proof and replayed-proof approvals refused by the co-signer, preflight and
  on-chain cap refusals, badge-impostor refusal, audit head anchored.
- `npm run verify` (read-only) re-checks all of it: 23 checks pass.

## Tests
- contract: 9 unit + 18 integration (`cargo test`, after `scripts/build-wasm.sh`)
- agent (offline reference client + mock chain): 27 (`npm test`)
- live adapters (offline, fakes for chain): 23 (`npm test`)

## Changes in this round
- Contract: `approve` now takes `{id, human_proof}` and stores the Verification Audit Record anchor
  hash in the authorisation (`Approved` event carries it); new `anchorAudit` entrypoint +
  `AuditAnchored` event (owner, registered agent or co-signer only).
- Mock client mirrors both; mock co-signer requires a verifying human proof above the threshold.
- New `live/` package: testnet adapters, co-signer, human approval, x402 buyer/seller, tools, tests.

## Known limitations / next
- The contract cannot verify ZK proofs; it records the proof hash and the co-signer enforces it.
  Escrow-mode approvals (contract pays directly) are therefore not proof-gated — demo uses x402 mode.
- Approval proof is produced by a script holding the owner's seed (testnet). Production: the owner's
  Concordium ID / wallet answers the anchored request (same V1 request format).
- Seller + facilitator run locally during the demo; Agent Cards are on a temporary demo host
  (trustrail-204-44-110-122.sslip.io). For the final video, consider hosting cards on GitHub Pages
  once the repo is public.
- Budget asset is CCD; PLT (EURR/USDR) transfers are supported by the policy and co-signer design but
  not yet by the live buyer.
- `setAgentWallet` on the registry is not used (the wallet is 2-of-2; the MCP builder expects one
  signature); the Agent Card lists the guard and payment wallet under `services`.
- Payee badge checks run in the client; the on-chain allowlist still binds.
