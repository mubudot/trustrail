# Path to production

**Where it stands.** TrustRail runs on Concordium **testnet** with CCD payments: guard contract,
Agent Registry badges, payment-specific Verify-and-Access approvals, sponsored x402 settlement and
an anchored audit log ([TESTNET.md](TESTNET.md)). Not yet delivered: a mainnet deployment, owner
approval from an owner-controlled Concordium wallet supporting an account-credential proof for the
guard owner's account, a co-signer on separate infrastructure, PLT
stablecoin settlement, and any external pilot. This page is the plan for those, with the gates that
must pass before real money moves. Nothing below is claimed as done unless it links to code.

The standalone Concordium ID App cannot supply this account-bound proof: account verification
requires a wallet with account access ([Concordium: Select verification method](https://docs.concordium.com/en/mainnet/how-to/concordium-id/verify-and-access/select-verification-method.html)).
Wallet transport and exact request compatibility remain to be demonstrated.

## First users

Small teams that run an AI agent which buys data and API calls from other agents over x402 — for
example a research agent paying per dataset or per report. They want routine purchases to happen
without a person in the loop, larger ones to need an accountable owner's explicit approval of *that*
purchase, and a record they can show an auditor afterwards. Sellers get something too: a buyer
whose badge proves a verified human stands behind it.

## What changes from testnet to mainnet

| Area | Today (testnet) | Mainnet | Status |
| --- | --- | --- | --- |
| Network constants | `live/src/net.mjs` (`TESTNET`: gRPC host, x402 network id, registry `<12802,0>`) | a `MAINNET` profile: mainnet gRPC, the mainnet x402 network id, CIS-8004 `<10082,0>` / CIS-8 `<10081,0>`; select the profile by config, not by editing code | to do (small) |
| Approval request | `live/src/human-approval.mjs`: testnet IdP 0 trusted, `did:ccd:testnet:` subjects, resource id `trustrail:ccd:testnet:…` | the same Verify-and-Access V1 request with mainnet DIDs and the mainnet identity providers the operator chooses to accept | to do (small); request format unchanged |
| Who makes the proof | a script holding the test identity's seed | an owner-controlled Concordium wallet supports an account-credential proof for the guard owner's account; the approval screen shows payee, amount, asset and purpose | to do — wallet transport and exact request compatibility remain to be demonstrated |
| Owner identity | testnet IdP test identity, dummy attributes | a real identity from a mainnet IdP (passport + liveness in the Concordium wallet); disclosure only through Privacy Guardians and a court order | owner's own step |
| Company owners | — | for a business, the approving owner account belongs to an authorised employee; linking it to the company's identity (e.g. LEI) is a later option, not implemented | planned |
| Co-signer | `LiveCosigner` in the buyer's Node process (`live/src/world.mjs` loads both keys) | a separate service on separate infrastructure, run by the owner or a custodian; the agent calls it over an API with the same plain-JSON inputs `cosign()` takes today; key 1 in an HSM or a custody service | to do — required before mainnet |
| Custody service (e.g. Dfns) | — | must be shown to sign a Concordium transaction digest for one key of a native multi-key account; until demonstrated, an HSM-backed co-signer is the fallback | unverified |
| Agent badge | testnet registry, Agent Cards on a temporary host | mainnet registry; Agent Cards on a durable host whose bytes match the pinned hash | to do (small) |
| Budget asset | CCD | a PLT stablecoin (e.g. EURR/USDR, subject to availability). The policy and contract already model a PLT asset; the live buyer, seller and co-signer accept CCD simple transfers only (`live/src/cosigner-live.mjs` refuses anything else) and need a PLT transfer path with token id and decimals checks | to do |
| Fees | x402 settlement sponsored by a facilitator we run; control transactions paid by the agent, owner and co-signer accounts | a hosted facilitator (or the seller's) sponsors settlements; the operator funds the control accounts — see costs below | to do |
| Escrow mode | exists in the contract, not proof-gated | disabled for mainnet (x402 mode only), because the contract cannot check the human proof itself | config |
| Contract | `<13037,0>`, no upgrade entrypoint | fresh deployment of the same module after an external review; policy changes stay with the owner key, the co-signer keeps its own pinned threshold | to do |

## Recovery and operations

- `settlement_unknown` (the facilitator did not confirm) and `paid_unrecorded` (paid, but
  `recordSettlement` failed) are already reported by the buyer (`live/src/live-agent.mjs`) and kept in
  the audit log with any transaction hash. In production an operator job reconciles them against the
  chain before the agent may buy again; committed authorisations stay booked against the daily cap
  until then.
- Keys: the guard binds the wallet's address, not its keys, so the wallet's keys can be rotated
  without touching the contract. Changing the keys of the 2-of-2 wallet itself needs both keys, so
  the custodian must hold a recoverable backup of key 1. Losing key 1 stops every payment (fail
  closed); the owner can still pause the agent in the guard (`setPaused`) and withdraw escrow.
- Audit anchoring: in the demo the log head was anchored by an explicit step
  (`node demo/testnet.mjs anchor`, which calls `anchorAudit`). In production the operator anchors on a
  schedule, e.g. after each batch of purchases; `npm run verify` is the check an auditor runs.

## What it costs

Every purchase is a handful of ordinary transactions. Measured from the demo's finalized testnet
transactions with `(cd live && npm run costs)` (read-only, no keys), medians per component:
[COSTS.md](COSTS.md).

| Purchase | Transactions | Energy | Fee at the testnet chain parameters read on 1 Nov 2026 |
| --- | --- | ---: | ---: |
| Small (at or below the threshold) | `authorize` + `commitPayment` + x402 settlement + `recordSettlement` + ¼ of an audit anchor | ≈ 5,550 | ≈ €0.11 |
| Large (human-approved) | the same + verification-request anchor + approval-record anchor + `approve` | ≈ 7,930 | ≈ €0.16 |

Four transactions per small purchase and seven per human-approved one (plus a share of the audit
anchor) is the price of putting every step on chain; for purchases of
a few euros or more it is small, for sub-cent API calls it is not. Two levers for production (not
implemented yet):
batch micro-purchases under one authorisation (a prepaid allowance per seller and day), and anchor
the audit log once per batch rather than per run.

Who pays: the settlement fee is paid by the sponsoring facilitator, not by the agent's wallet. The
control transactions are paid by the agent's control account, the co-signer and the owner, so an
operator funds those accounts. Mainnet energy use is the same as on testnet; the CCD price of energy
follows the chain's exchange-rate parameters at the time, so mainnet fees must be converted at
current rates — no mainnet price is claimed here. Hosting the co-signer and facilitator, and any
custody service, come on top.

## Gates before real money

1. **Separate custody.** Co-signer on its own host with its own key store; the agent process holds
   key 0 only. Re-run the attack suite and `verify` against that setup.
2. **Owner approval in the owner's wallet.** Demonstrate account-credential proof support for the
   guard owner's account, the wallet transport and exact V1 request compatibility; show payee,
   amount and purpose before approval.
3. **Recovery tested.** Forced facilitator failure and forced `recordSettlement` failure are
   reconciled without a double payment.
4. **External testnet pilot.** One outside team runs the agent against an independently operated
   seller for two weeks. Proposed measures: approval completion rate and time, refusal correctness,
   purchase latency, total fees. (Proposed — no pilot has run yet.)
5. **Bounded mainnet launch.** Small caps in a stablecoin, external review of the contract and
   co-signer, then raise limits.
