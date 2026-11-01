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
| Co-signer | recorded runs: `LiveCosigner` in the buyer's Node process; authenticated HTTP service/client and separate buyer config implemented and tested offline | separate infrastructure run by the owner or a custodian; key 1 in an HSM or custody service | service boundary implemented; separate custody has not been demonstrated on testnet yet |
| Custody service (e.g. Dfns) | — | must be shown to sign a Concordium transaction digest for one key of a native multi-key account; until demonstrated, an HSM-backed co-signer is the fallback | unverified |
| Agent badge | testnet registry, Agent Cards on a temporary host | mainnet registry; Agent Cards on a durable host whose bytes match the pinned hash | to do (small) |
| Budget asset | CCD | a PLT stablecoin (e.g. EURR/USDR, subject to availability). The policy and contract already model a PLT asset; the live buyer, seller and co-signer accept CCD simple transfers only (`live/src/cosigner-live.mjs` refuses anything else) and need a PLT transfer path with token id and decimals checks | to do |
| Fees | x402 settlement sponsored by a facilitator we run; control transactions paid by the agent, owner and co-signer accounts | a hosted facilitator (or the seller's) sponsors settlements; the operator funds the control accounts — see costs below | to do |
| Escrow mode | exists in the contract, not proof-gated | disabled for mainnet (x402 mode only), because the contract cannot check the human proof itself | config |
| Contract | `<13037,0>`, no upgrade entrypoint | fresh deployment of the same module after an external review; policy changes stay with the owner key, the co-signer keeps its own pinned threshold | to do |

## Separate co-signer service (offline tested)

[`cosigner-service.mjs`](../live/src/cosigner-service.mjs) holds wallet key 1 and the co-signer
control credential. It wraps the existing proof, transaction, policy and badge checks.
[`cosigner-client.mjs`](../live/src/cosigner-client.mjs) exposes the same `cosign()` / `release()`
interface used by the buyer. The default wiring remains in process; **all recorded testnet runs
used it. Separate custody has not been demonstrated on testnet yet.**

The operator provisions two separate credential files, outside the checkout and with restrictive
file permissions. No export or migration of the demo's existing secrets was performed for this
implementation. Running two processes against the same all-roles bundle would not establish
separate custody.

| File | Required shape / contents |
| --- | --- |
| Buyer config | Exactly `agent` and `wallet`, each with `address` and `keys: {"0": {"privateKey": …, "publicKey": …}}`; optional `threshold`. These are the agent control key and payment wallet key 0. Additional roles or wallet key 1 are rejected. |
| Service config | `network` (testnet x402 network id), `guard: {index, subindex}`, `owner`, `agent`, `humanProofAbove` (decimal microCCD), `agentPublicKey` (wallet key 0 public key), `walletKey` (wallet key 1 private key), `account` (co-signer control address and `keys[0]` pair), `approvalsDir` (public verifier records), `nonceStateFile` (durable public nonce journal). Both paths are relative to the config file. |

The service pins its **own** guard, network, owner, agent, threshold and badge resolver on startup.
Its badge resolver is the hosted registry adapter. The request cannot change any of these, supply
an approval record, or turn off badge checks. The service reads approval records from its own
verifier directory; their ZK proof and anchors are still checked against the chain.

In the service environment, set `TRUSTRAIL_COSIGNER_CONFIG` to its dedicated file and
`TRUSTRAIL_COSIGNER_TOKEN` to a shared random bearer secret (at least 32 characters), then run
`(cd live && npm run cosigner:serve)`. It listens on loopback port 4410 by default; host/port can
be set with `TRUSTRAIL_COSIGNER_HOST` / `TRUSTRAIL_COSIGNER_PORT`. Use HTTPS for a separate host
(the client permits plain HTTP only on loopback), with the service behind the TLS endpoint.

In the buyer environment, set `TRUSTRAIL_BUYER_CONFIG` to its dedicated file,
`TRUSTRAIL_COSIGNER_URL` to the service endpoint, and the same `TRUSTRAIL_COSIGNER_TOKEN`.
`createLiveWorld()` then loads only that buyer file, constructs the HTTP client, and does not
load the all-roles secret store or start the local seller/facilitator. Use an independently
operated seller URL. This opt-in wiring also applies to MCP `--world testnet`; it has not been
run against testnet. Neither command is part of the offline verification route.

`POST /cosign` accepts only `{authId, signableJSON, resourceUrl, requirements}` (authId is a decimal
string). Success returns `{authId, status: "signed", signature, receipt: {commitTx, digest}}`.
`POST /release` accepts only `{authId}` for this service's agent; its response contains
`{authId, status: "released", released, receipt: {cancelTx}}`. Refusals carry `status: "refused"`
and a stable `reason`; missing authentication returns HTTP 401. Signing refusals do not
implicitly cancel: the buyer calls `release()` and receives that cancellation's receipt.
A lost signing response is an unknown outcome, preserved for reconciliation without cancellation
or payment retry. Per-call receipts avoid sharing mutable receipt state across HTTP requests;
the guard's atomic `commitPayment` ensures only one signature for the **same authorization**
across replicas. It does not coordinate wallet nonces across different authorizations.

Within one signing instance, signing and release are serialized per wallet. Before committing,
the service reserves the wallet nonce for its authorization, digest and exact signed transfer
header expiry (`notAfterS`, decimal epoch seconds); another authorization at that nonce receives
`wallet_nonce_in_use` before `commitPayment`. A reservation clears only when the node's next wallet
nonce advances past it, the last finalized block's slot time is **strictly past the signed transfer
expiry**, or the guard reports Cancelled. The contract allows cancellation only before commitment,
when no co-signer signature has been released. A buyer can write a Settled record with an invented
hash, so Settled alone leaves the reservation in place.

Expiry recovery is automatic during reconciliation on a fresh signing or release request, including
after a service restart. The service reads finalized time from the node via gRPC; local time,
buyer-supplied time and the authorization deadline cannot free a nonce. Equality with the signed
expiry retains the reservation. A failed or invalid chain-time read also retains it. The expired
transfer can no longer be included once finalized time passes its expiry, but its old committed
budget stays booked; recovery never changes the guard's accounting.

`nonceStateFile` uses **journal version 2**, written atomically before commit and restored on restart.
It stores only public wallet addresses, nonces, authorization ids, digests and signed expiries,
scoped to the configured network, guard and agent. Keep this file across restarts and never delete
it to bypass a refusal. A journal write failure prevents committing.

**Version 1 journals are rejected at startup** with `unsupported_wallet_nonce_journal_version`;
there is no automatic migration because those entries lack the exact signed expiry. Preserve the
old journal. To provision version 2, recover each original transfer, verify its digest against the
entry and add its exact header expiry; omit an entry only after independently verifying nonce
consumption or cancellation. Do not start with a replacement journal while any entry is unresolved,
and never substitute an authorization deadline for a signed expiry.

**Before mainnet, run a single signing instance for each wallet, or add a shared lock and durable
reservation store spanning every replica.** The journal is for one writer and does not supply a
cross-process lock. Two replicas with separate memory or even the same journal file can still
commit different authorizations at one nonce; multi-replica wallet safety is not implemented or
claimed. Low-level in-process co-signers also lack this service coordinator.

Offline tests use generated keys, the actual approval verifier with captured public chain
responses, mock guard transitions, HTTP on loopback, and fake settlement responses. They cover
small and proof-required buyer payments, forged proofs, pinned settings, authentication,
key separation, cancellation receipts, malformed/lost responses, a same-authorization replica race,
different-authorization nonce conflicts within one service, forged settlement records, finalized-time
expiry recovery after lost responses and restart, failed chain-time reads and journal version rejection.
They do not establish
separate host custody, a live owner wallet integration or a new testnet settlement.

## Recovery and operations

- `settlement_unknown` (the facilitator did not confirm) and `paid_unrecorded` (paid, but
  `recordSettlement` failed) are already reported by the buyer (`live/src/live-agent.mjs`) and kept in
  the audit log with any transaction hash. In production an operator job reconciles them against the
  chain before the agent may buy again. Service nonce recovery after the signed expiry uses finalized
  chain time automatically as described above; committed authorisations stay booked under the guard's
  existing budget accounting even when their nonce reservations clear.
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
