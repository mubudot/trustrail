# Testnet runbook: from nothing to a verified, audited x402 payment

Everything here runs on **Concordium testnet** with free tools: the Concordium testnet identity
provider (its own dummy attributes, no real documents), the wallet-proxy faucet (free test CCD),
the hosted Agent Registry MCP (`https://agent-registry-mcp.concordium.com/mcp`) and
`@x402/concordium`. No mainnet, no money, no wallet app, no browser.

The deployment in [TESTNET.md](TESTNET.md) was made exactly this way. To only **check** it, skip to
step 9: `npm run verify`, `npm run check-badge` and `npm run audit:doc` need no keys.

For reproducible attack demonstrations, see [ATTACKS.md](ATTACKS.md): from the repository root,
`bash scripts/attacks.sh` runs the offline contract and Node suites. Tests: **158 total** — contract
9 unit + 25 integration = 34, agent 33, live 91. The Node runner reports 32 attacks blocked and
4 controls passed; the 7 Rust attack tests also print 27 refusals and 3 controls. Configure your
Rust toolchain and install the existing live dependencies first. `cd live && npm run attacks --
--testnet` runs optional read-only checks, with no keys or transactions.

Keys and the throwaway identity go to `live/.secrets/` (gitignored, mode 600). The public record
goes to `live/state/` (committed).

```bash
cd live && npm ci
```

## 0. Start from empty public state (only for a deployment of your own)

The checkout ships the record of *our* deployment (`live/state/`) and our Agent Cards
(`live/agent-cards/`). The tools skip any step already recorded there, so move both aside first:

```bash
mv state state.example && mkdir -p state/approvals
mv agent-cards agent-cards.example && mkdir agent-cards
```

## 1. Throwaway testnet identity (Concordium testnet IdP)

```bash
node tools/identity-start.mjs owner    # seed + identity object request for the "Concordium testnet IP"
node tools/identity-finish.mjs owner   # submits the IdP's test form with its own dummy defaults, waits for the identity object
```

## 2. Accounts and test CCD

```bash
node tools/create-accounts.mjs         # owner, agent, wallet (2-of-2: agent key 0 + co-signer key 1), cosigner, seller, facilitator
                                       # CRED_BASE=<n> picks fresh credential numbers if earlier ones are used
node tools/faucet.mjs <role> [<role> ...]  # one wallet-proxy faucet drop per fresh account
node tools/fund.mjs <role>=<CCD> [...]     # the owner tops up roles that need more; the wallet needs the payment amounts (its x402 transfers are fee-sponsored by the facilitator)
```

## 3. Guard contract bound to the CIS-8004 registry

```bash
node tools/deploy-guard.mjs            # deploys live/deployed/agent_spend_guard.wasm.v1, init bound to <12802,0>
```

The module is the exact one built by `scripts/build-wasm.sh`. Testnet already holds it (module
`2265603ddca0…`), so the tool reuses it and only creates your own instance; rebuild and copy a new
module into `live/deployed/` only if you change the contract.

## 4. Register both agents in the Agent Registry (CIS-8004) through the hosted MCP

```bash
node tools/registry-mint.mjs buyer     # MCP build_register -> owner signs -> agent NFT (badge) to the OWNER
node tools/registry-mint.mjs seller    # same for the payee agent, minted to the seller account
```

## 5. Agent Cards with the Concordium badge, pinned on chain

```bash
node tools/publish-agent-cards.mjs         # MCP build_agent_card -> live/agent-cards/<tokenId>.json
# serve the two files verbatim at CARD_BASE (edit CARD_BASE in the tool to your host, e.g. GitHub Pages)
node tools/publish-agent-cards.mjs --pin   # checks the served bytes, MCP build_set_agent_uri -> setAgentURI with the card's SHA-256
```

## 6. Check the badges through the hosted MCP

```bash
npm run check-badge                         # MCP check_badge for both badges in live/state/testnet.json
npm run check-badge -- JyP9XqAasF5crQaoy7nMw  # or any badge token address
```

Each line must say `VALID`, `Active`, the expected owner, and that the card hash matches on chain.
The same verdict is at `https://agent-registry-mcp.concordium.com/v1/check-badge/<token address>`.

## 7. Register the buyer agent in the guard

```bash
node tools/register-agent-in-guard.mjs     # the contract checks balanceOf on the real registry: the owner must hold the badge
```
It also records the 2-of-2 wallet's two public keys in `live/state/testnet.json`; `verify` checks
the wallet and each settlement's signatures against them.

Policy: ≤ 5 CCD per payment, ≤ 12 CCD per UTC day, above 2 CCD a verified human must approve,
authorisations live 15 minutes, payee allowlist = the seller.

## 8. The x402 payments, gated by the cap and the approval

One step per command; each starts a local x402 seller (real `@x402/concordium` facilitator, real
sponsored settlement on testnet) and appends its evidence to `live/state/run.json` and the audit log.

```bash
node demo/testnet.mjs small            # 0.5 CCD: under the threshold -> guard approves -> co-signed -> x402 settles
node demo/testnet.mjs big-request      # 4 CCD: guard holds it as Pending
node demo/testnet.mjs big-approve      # anchored request -> owner's ZK proof -> record anchored -> approve(id, anchor hash)
node demo/testnet.mjs big-pay          # co-signer re-verifies the proof against chain -> x402 settles
node demo/testnet.mjs forged-request && node demo/testnet.mjs forged-approve && node demo/testnet.mjs forged-pay   # refused
node demo/testnet.mjs replay-request && node demo/testnet.mjs replay-approve && node demo/testnet.mjs replay-pay   # refused
node demo/testnet.mjs over-cap         # 9 CCD: refused by the local preflight
node demo/testnet.mjs hijacked         # 9 CCD sent straight to the guard: rejected on chain (PerTxCap)
node demo/testnet.mjs impostor         # look-alike payee: refused before any transaction
node demo/testnet.mjs anchor           # anchorAudit(head, count) of the hash-chained log
```

## 9. Check it and publish the record (read-only, no keys)

```bash
npm run verify                    # 23 checks against testnet: badges, guard, ZK approval, settlements, anchor
node tools/write-testnet-doc.mjs  # docs/TESTNET.md: every object and transaction with CCDExplorer links
npm run audit:doc                 # docs/AUDIT_LOG.md: the Art. 12-style audit record, block times, anchor check
```
