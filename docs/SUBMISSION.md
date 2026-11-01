# Final submission — draft text for the Encode project page

Due Wed 9 Dec 23:59 UTC. Every link below must open without signing in (the repository links work once it is public).

**Project name:** TrustRail — no verified human, no payment

**Links**

- Code: https://github.com/mubudot/trustrail
- Demo video (2:58): https://youtu.be/lQQWTXewqcg
- CCDExplorer: guard contract https://ccdexplorer.io/testnet/instance/13037/0
  (deployment and selected demo transactions: [TESTNET.md](https://github.com/mubudot/trustrail/blob/main/docs/TESTNET.md); full list of recorded transactions: [COSTS.md](COSTS.md), with purchase lifecycles in [AUDIT_LOG.md](AUDIT_LOG.md))
- Path to production: [PRODUCTION.md](https://github.com/mubudot/trustrail/blob/main/docs/PRODUCTION.md) · Judge route: [JUDGING.md](https://github.com/mubudot/trustrail/blob/main/docs/JUDGING.md)

## Description

TrustRail is a spending control for teams whose AI agents buy data and API access from other agents
over x402. Routine purchases run on their own inside a policy; a larger purchase needs the
accountable owner to approve *that* purchase with a Concordium identity proof; and afterwards there
is an audit trail anyone can check.

How it works: a guard contract on Concordium enforces per-payment and daily caps, an allowlist of
payees and an approval threshold. Before paying, the buyer and co-signer check the seller's
Verified-by-Concordium badge through the hosted Agent Registry and require it to be bound to the
pay-to address. The agent's paying wallet is a native 2-of-2 Concordium account: the agent holds one key, a small
co-signer holds the other. Above 2 CCD the co-signer signs only after it re-verifies a
Verify-and-Access zero-knowledge proof from the owner account's identity credential, made for a
request anchored on chain that names the guard, the authorisation, the payee, the amount and the
purpose. It then commits the exact signing digest on chain and releases its signature once.
Settlement is a sponsored x402 transfer, so the agent's wallet pays no fees. Approval records and
the agent's hash-chained audit log are anchored on chain (an EU AI Act Art. 12-style record).

What the demo shows on testnet: a 0.5 CCD purchase paid automatically; a 4 CCD purchase held as
pending, approved with the owner's proof and settled; an owner-key approval with a made-up proof and
a replayed genuine proof, both refused by the co-signer and cancelled; a 9 CCD request rejected on
chain; a look-alike seller refused before any transaction. `npm run verify` re-checks all of it
read-only, without keys. 32 offline attacks are blocked through the production co-signer and
verifiers.

Demo scope, stated plainly: the owner identity is a testnet-IdP test identity with dummy attributes,
the owner's proof is produced by a script, the co-signer runs in the buyer's process, and the seller
and facilitator run locally. No external pilot results are claimed.

## Concordium components used

- Concordium ID / Verify and Access — payment-specific zero-knowledge approval, Verification Audit
  Record anchored on chain
- Agent Registry (CIS-8004) + Verified by Concordium badge — both agents registered through the
  hosted MCP; the guard checks buyer badge ownership on chain; the buyer and co-signer check payee badges
- x402 on Concordium with sponsored transactions
- Native multi-key accounts (the 2-of-2 wallet)

## Path to production (short)

Mainnet needs: owner approval from an owner-controlled Concordium wallet supporting an
account-credential proof for the guard owner's account (wallet transport and exact request
compatibility remain to be demonstrated), the co-signer as a separate service with its own key store, mainnet registry and identity providers, a PLT stablecoin budget,
funded control accounts and a hosted facilitator, then an external testnet pilot and a bounded
mainnet launch. Measured fees per purchase: [COSTS.md](https://github.com/mubudot/trustrail/blob/main/docs/COSTS.md). Full plan with gates:
[PRODUCTION.md](https://github.com/mubudot/trustrail/blob/main/docs/PRODUCTION.md).

## Build history

Work started on 30 Oct 2026, before the 2 Nov launch, from the published hackathon brief; the git
history is kept as is. Built with AI coding assistants; all code was run and tested locally and on
testnet.
