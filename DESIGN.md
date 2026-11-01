# Design — Trusted Agent Spend Guard on Concordium

Working name: **TrustRail** — "give your AI agent a wallet without giving it your wallet".

## Problem

An AI agent that can pay (x402: pay-per-request APIs, data, other agents) holds a key. If it is
prompt-injected, buggy, or simply wrong, nothing stops it from paying the wrong party or draining
the budget, and afterwards nobody can show *who* was accountable and *what* was authorised.
Counterparties have the mirror problem: before an agent pays or is paid, it wants to know a verified
human stands behind the other side.

## What the hackathon rewards (RULES.md) and how this maps

| Judging axis | Our answer |
| --- | --- |
| Concordium identity | Owner is a Concordium account (every account is IdP-backed; testnet IP for the demo). The guard contract only lets an agent spend if its **CIS-8004 Agent Registry NFT is held by the guard owner** (checked on-chain via CIS-2 `balanceOf` at registration and re-checkable), so the badge, the owner and the spending policy are one chain of accountability. Payees can be required to show a valid *Verified by Concordium* badge (hosted MCP `check-badge`) before the agent pays them. |
| Agent Registry | Agent registered in CIS-8004 (testnet `<12802,0>`), Agent Card with badge extension + `x402Support: true` + a `spendPolicy` pointer to the guard contract. |
| Agent payments | x402 on Concordium (`@x402/concordium`, exact scheme, sponsored V1 transfer — agent needs no CCD for fees) **gated by an on-chain authorisation** in the guard contract; plus an on-chain escrow mode for agent-to-agent CCD payments. |
| Accountability / EU AI Act Art. 12 | Every decision (authorised, pending human approval, approved, rejected, cancelled, settled with the x402 tx hash, refused attempts that were preflighted) is an on-chain event + record; the off-chain audit log is hash-chained and links each entry to the on-chain authorisation id and settlement tx. |
| Path to production | Same contract on mainnet; owner identity from a real IdP; badge from the official registry `<10082,0>`; co-signer run by the owner (or a custodian such as Dfns); PLT stablecoin (EURR/USDR) as the budget asset; sponsor service for fees. |

## Components

```
            verified human owner (Concordium account, IdP-backed)
             | registerAgent / policy / approve / reject / pause / withdraw
             v
+-------------------- agent_spend_guard contract --------------------+
| agents[agent account] = { badge(CIS-8004 token), policy, allowlist, |
|                           paused, day, spent_today, generation }    |
| authorize(payee, amount, asset, mode, purpose_hash)                 |
|   paused? registered? asset? allowlisted? per-tx? daily?            |
|   <= threshold -> Approved (Escrow: CCD transferred now)            |
|   >  threshold -> Pending (budget reserved) -> owner approve/reject |
| recordSettlement(id, x402 tx hash)  | cancel(id) | events = audit    |
+---------------------------------------------------------------------+
             ^ authorize / recordSettlement            ^ CIS-2 balanceOf
             |                                          | (badge owned by owner?)
   AI agent (untrusted)  ---x402--->  seller API      CIS-8004 Agent Registry
       | builds sponsored V1 transfer (sender = agent account,
       |   2-of-2 keys: agent key + guard co-signer key)
       v
   co-signer (deterministic, owner-run): signs ONLY if the tx exactly matches an
   Approved, unexpired, unconsumed on-chain authorisation (payee, amount, asset,
   expiry). Then facilitator sponsors + submits; tx hash recorded on chain.
```

### Why two enforcement points

The standard x402 facilitator only settles a *sponsored transfer from the payer's own account*
(rule 6/9: SimpleTransfer or PLT TokenUpdate, exactly one operation). A contract call cannot be the
x402 payment. So:

1. **Policy lives on chain** (the guard contract): limits, allowlist, approval, budget accounting,
   audit — the same for every client, checkable on CCDExplorer.
2. **Key custody makes it binding**: each agent has two accounts. Its **control account** (single
   key) calls the guard (`authorize`, `cancel`, `recordSettlement`). Its **wallet** holds the
   budget and pays x402; it has **two keys, threshold 2** (Concordium accounts support several keys
   per credential): the agent holds one, the co-signer the other. The co-signer signs only a
   transfer that matches an on-chain `Approved` authorisation, and first calls
   `commitPayment(id, digest)` — an atomic on-chain Approved → Committed transition — so each
   authorisation is co-signed at most once, even across restarts or replicas, and a committed
   authorisation can never be cancelled for a refund. The agent alone cannot move funds; the
   co-signer alone has no reason to (its logic is deterministic and small enough to audit).
3. **Escrow mode** for agent-to-agent CCD payments that do not need x402: the contract holds the
   budget and transfers directly — fully on-chain enforcement, no co-signer.

The live testnet demo uses a native 2-of-2 wallet: the agent signs key 0, and the co-signer checks
and commits the transfer before signing key 1. Both keys currently run in the buyer process;
separate co-signer custody remains production work. Mock mode exercises the same signing policy.

## Verified-human approval (live since 2026-10-31)

Approvals above the threshold are bound to a **Concordium Verify-and-Access (Verifiable
Presentation V1) proof** instead of a bare owner signature:

1. The verifier (the co-signer service) anchors a `VerificationRequestV1` (RegisterData) whose context
   carries a random nonce, ResourceID `trustrail:ccd:testnet:<guard>:auth:<id>` and a context string
   with amount, payee and purpose hash; the claim is account-based `dob` range (age ≥ 18) from the
   trusted testnet IdP(s).
2. The owner's wallet produces a ZK presentation from the **owner account's** credential.
3. The verifier checks it with the node (proof, credential Active, credential belongs to the guard
   owner, ResourceID = this authorisation), builds the `VerificationAuditRecordV1` and anchors its hash.
4. The owner calls `approve({id, human_proof: anchorHash})`; the contract stores the hash.
5. Before co-signing, the co-signer re-derives everything from the record JSON + chain and compares
   the anchor hash with the authorisation's `human_proof`. Forged, missing or replayed records → refuse
   and cancel (budget released). The contract itself cannot verify ZK proofs; that is why the binding
   lives in the key that has to co-sign.

## Contract policy (deterministic)

- Amounts are atomic units (microCCD for CCD; PLT smallest unit) as `u64`.
- Day = `slot_time / 86_400_000` (UTC days). Pending requests reserve budget on their day.
- Order of checks (first failure wins): contract paused → agent registered → agent paused →
  asset matches policy → amount > 0 → payee allowlisted → amount ≤ per-tx cap → spent_today +
  amount ≤ daily cap → (amount > approval threshold ? Pending : Approved).
- Lifecycle: `Pending` → (owner) `Approved` → (co-signer `commitPayment`) `Committed` → (agent or
  co-signer `recordSettlement`, unique tx hash) `Settled`; or `Rejected` / `Cancelled`. Escrow-mode
  authorisations go straight to `Settled` when the contract pays.
- Authorisations expire `auth_ttl_ms` after creation (max 1 day). Expired Pending/Approved ones can
  no longer be approved or committed; their reservation is **not** refunded automatically (fail
  closed); owner, agent or co-signer may `cancel` (Pending/Approved only), which refunds only if
  still the same day. Committed authorisations stay booked: the payment may be on chain.
- Daily caps charge the authorisation's UTC day.
- `generation` bumps on removeAgent/re-register so stale authorisations cannot be approved after a
  policy reset (idea from near-agent-spend-guard).
- Allowlist bounded (≤ 32 payees); empty allowlist = nothing payable.
- If the contract is initialised with a CIS-8004 registry address, `registerAgent` requires a badge
  in that registry and the owner must hold that NFT (CIS-2 `balanceOf == 1`); `recheckBadge` lets
  anyone re-run the check and auto-pauses the agent if the owner no longer holds it.

## Agent client (Node, `agent/`)

- `policy.mjs` — pure JS mirror of the contract policy for **preflight** (refuse locally before
  spending gas; same error codes).
- `x402-flow.mjs` — buyer flow: request → 402 + PaymentRequirements → preflight → on-chain
  `authorize` → build sponsored V1 transfer → co-signer → retry with `PAYMENT-SIGNATURE` → record
  settlement.
- `cosigner.mjs` — the binding check: payload shape, sender = agent wallet, payee/amount/asset equal the
  authorisation, tx expiry ≤ authorisation expiry and ≤ 10 min, one operation, sponsor ≠ payee,
  authorisation not yet consumed.
- `badge.mjs` — counterparty badge check (hosted MCP REST in live mode, fixture in mock mode).
- `audit.mjs` — hash-chained JSONL audit log.
- `mock/` — in-memory chain (same policy), x402 seller + facilitator, so judges can run everything
  with no key and no network: `npm test`, `npm run demo:mock`.
- Live mode (`live/`, implemented on testnet): `@concordium/web-sdk` + `@x402/concordium`, hosted
  Agent Registry MCP, native 2-of-2 payments and payment-specific verified-human approvals.

## Reused ideas

- near-agent-spend-guard: on-chain caps/allowlist/threshold, pending with reserved budget, owner-only
  admin, pause, generation counter, bounded state, events as audit, restricted agent key.
- paypal-guardrail-buyer: deterministic guardrail engine separate from the LLM, preflight with stable
  error codes, human approval queue, hash-chained audit, offline/mock mode for judges.

## Out of scope for now / open questions

- On-chain verification of ZK identity proofs (contracts cannot verify them; Verify and Access is
  verified off-chain — used for the payee/owner-attribute check in the client).
- Protocol-Level Locks (W4) as an alternative to escrow — revisit after the workshop.
- Whether the hosted x402 facilitator for Concordium testnet is public, or we run our own
  (`@x402/concordium/exact/facilitator`, needs a funded sponsor account).
