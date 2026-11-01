# Judging TrustRail in a few minutes

Everything here runs from the repository root with Node 22+ and needs **no keys, no wallet and no
test CCD**. Install time (`npm ci`) is not counted in the timings below; the testnet check also
depends on the public testnet node, which sometimes answers slowly (the tool retries).

## 1. Offline: the whole flow against a mock chain (about 10 seconds)

```bash
(cd agent && npm test && npm run demo:mock)
```

What you should see from the demo (transaction hashes are random):

| Step | Expected line |
| --- | --- |
| 0.5 CCD weather feed from a badge-verified seller | `-> paid tx …` |
| prompt-injected "refund" to an address carrying someone else's badge | `-> refused (identity: payee_not_bound_to_badge)` |
| seller without a badge | `-> refused (identity: payee_has_no_badge)` |
| 4 CCD dataset, above the 2 CCD threshold | `-> pending_approval`, then after the owner approves `-> paid tx …` |
| loop of weather buys | `-> refused (preflight: DailyCap)` after 16 |

It ends with `Spent today: 12 CCD of 12 CCD` and `Audit log: … entries, chain intact`. The mock
chain runs the same policy rules as the contract; the real contract is tested separately in Rust
(`contract/`, see the README).

## 2. The live testnet deployment, read-only (one command)

```bash
(cd live && npm ci && npm run verify)
```

Expected: 23 lines starting with `PASS` and `all checks passed`, exit code 0. It reads from
Concordium testnet only (no transaction is sent) and checks:

- both Verified-by-Concordium badges (#977 buyer agent, #978 seller) are valid, Active and held by
  the right accounts (hosted Agent Registry), and the guard `<13037,0>` binds the agent to badge #977
  and to its paying wallet, with an approval threshold not above the co-signer's pinned one;
- the agent wallet is a 2-of-2 account and both x402 settlements were signed by both keys over the
  exact digest the co-signer committed on chain;
- the zero-knowledge approval record of the 4 CCD payment re-verifies against the chain and names
  that authorisation, payee and amount;
- the forged-proof and replayed-proof approvals ended cancelled, the 9 CCD request was rejected on
  chain, and the anchored audit-log head covers every authorisation the guard holds.

`npm run check-badge` asks the hosted Agent Registry MCP (`check_badge`) about both badges.

## 3. Where to click

| What | Link |
| --- | --- |
| Guard contract | [<13037,0> on CCDExplorer](https://ccdexplorer.io/testnet/instance/13037/0) |
| 0.5 CCD payment, sponsored x402 settlement from the 2-of-2 wallet | [86b08eae47…](https://ccdexplorer.io/testnet/transaction/86b08eae4720542d0b43eefc527cddaa4a8255163d2770e40c7aea08e122c02b) |
| 4 CCD payment: approval request anchored → owner approve with the proof hash → settlement | [21894906c9…](https://ccdexplorer.io/testnet/transaction/21894906c9faa606b135a60759654e27863619f6610c9b0644849493f4a24dfa) → [6399605db5…](https://ccdexplorer.io/testnet/transaction/6399605db510b3eedb06a4e55363c0bfff2ebcc3735d6724cdca030d75a49800) → [9c8b101ada…](https://ccdexplorer.io/testnet/transaction/9c8b101adaa32ec4cf6e5c5b3c40384e2e4dcf17c3eff4bcf377b4f9306e3a01) |
| Replayed genuine proof → co-signer refuses, authorisation cancelled | [25dd71a0fb…](https://ccdexplorer.io/testnet/transaction/25dd71a0fb16a2cc0d1aad91fb6d9cfe1e891d7d3ccf0dd9cf9863dbd61cfff6) |
| Agent skips its own checks, asks for 9 CCD → rejected on chain (`PerTxCap`) | [a7379c9cdd…](https://ccdexplorer.io/testnet/transaction/a7379c9cdde100c758f83a6d8aa8ca96ba934499713ab9da435499fb6e4de12d) |
| Audit-log head anchored on the guard | [38d93421c1…](https://ccdexplorer.io/testnet/transaction/38d93421c1ca3ee7fcf5ffdc7ee3ba5b7ff2065c1adaa2595bac84605fb7bb9f) |

Every other address and transaction: [TESTNET.md](TESTNET.md). The audit log as an
Art. 12-style record: [AUDIT_LOG.md](AUDIT_LOG.md). Measured fees per flow: [COSTS.md](COSTS.md).

## 4. What the demo does and does not show

- Shown on testnet: badge-checked payees, on-chain caps and allowlist, a payment-specific
  Verify-and-Access proof before the co-signer releases key 1, sponsored x402 settlement, refusals
  of forged and replayed approvals, and an anchored audit log.
- Demo scope: the identity is a testnet-IdP test identity with dummy attributes; the owner's proof
  is made by a script holding that test identity (in production the owner's Concordium ID app
  answers the same request); the co-signer runs in the buyer's Node process (in production it is a
  separate service with its own key store); the seller and facilitator run locally.
- Fixtures in the offline tests reproduce captured evidence; they do not prove the testnet badges
  or node are up today — step 2 does that.

## 5. Optional, slower

- `bash scripts/attacks.sh` — 32 offline attacks through the production co-signer and verifiers,
  plus Rust attack tests against the real contract Wasm (needs the Rust toolchain, see
  [ATTACKS.md](ATTACKS.md)).
- `(cd live && npm test)` — the live-adapter suite (offline, a few minutes).
