# Concordium Trusted Agents Hackathon (Encode Club) — rules digest

Read 2026-10-30 from the official programme page and its linked material. Times are given in UTC
(as published) and Asia/Taipei (UTC+8).

Sources:
- Programme page + FAQ: https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon
- Encode Club event rules ("Terms of Service"): https://www.encodeclub.com/terms-of-service
- Agent Registry reference: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html
  (CIS-8004, CIS-8, Agent Card, Verified by Concordium badge, MCP service pages)
- x402 on Concordium: https://docs.concordium.com/en/mainnet/how-to/integrations/x402-integration.html and
  https://www.npmjs.com/package/@x402/concordium (v2.29.0)
- Dev environment / testnet identity: https://docs.concordium.com/en/mainnet/tutorials/setup-env.html

## At a glance

| Item | What the page says |
| --- | --- |
| Format | Free, online, 6 weeks. Weeks 1–3: six 60-min workshops (Mon/Wed 15:00 UTC = 23:00 Taipei). Weeks 4–6: testnet build, office hours Tue/Fri 15:00 UTC. |
| Tracks | **None.** The five directions are "starting points, not tracks": existing agent + badge/ERC-8004/x402; verified agents (registry + Agent Card + badge check over MCP/A2A); private verified users (Concordium ID / Verify and Access, e.g. age gate); agent commerce (x402 + sponsored transactions); accountable agents (EU AI Act Art. 12 audit trail, lawful route back to an owner). |
| Prizes | **Not published** anywhere on the programme page or in the Terms. The Terms only say: "All prize announcements made at The Event are tentative and subject to change." Re-check at the 2 Nov launch. |
| Solo | Allowed (FAQ 5: "You can build solo or in a team"). |
| Eligibility | No country/region restriction, no KYC and no sanctions clause published. Only rule: under-18s need parent/guardian consent. Governing law England & Wales. Nothing excludes Taiwan or Japan. |
| AI tools | No policy published (neither page nor Terms). Disclose AI assistance in the README anyway. |
| IP | Participants own what they build (Terms, "Intellectual Property Rights"). Encode may share registration details with sponsors and send marketing. |

## Key dates

| Event | UTC | Taipei |
| --- | --- | --- |
| Launch + team formation | Mon 2 Nov 14:30 | Mon 2 Nov 22:30 |
| Workshops 1–6 | 2, 4, 9, 11, 16, 18 Nov, 15:00 | same days 23:00 |
| Build window opens | Thu 19 Nov | Thu 19 Nov |
| **Checkpoint 1** | **Sun 22 Nov 23:59** | **Mon 23 Nov 07:59** |
| Office hours | 24, 27 Nov; 1, 4 Dec; final walkthrough 8 Dec, 15:00 | 23:00 same days |
| **Final submission closes** | **Wed 9 Dec 23:59** | **Thu 10 Dec 07:59** |
| Judging | 10–11 Dec | — |

Late submissions can't be judged; the platform locks at the deadline (FAQ 13).

Workshop topics (useful for matching what judges expect): W1 Concordium ID + Verify and Access (age
check, no PII held); W2 Agent Registry, CIS-8004, CIS-8, Agent Card, badge, hosted MCP; W3 PLTs, x402 on
Concordium, sponsored transactions, agent-to-agent settlement; W4 Protocol-Level Locks, EU AI Act
Art. 12 record keeping; W5 production: LEI/company identity, Dfns, wallet SDKs, Tether WDK, cost
management; W6 MCP, A2A, Agent Card, roadmap.

## Requirements

1. Runs on **Concordium testnet** (test CCD is free from the wallet faucet).
2. **Meaningful use of at least one** Concordium component: Concordium ID or Verify and Access; Agent
   Registry + Verified by Concordium badge; x402 payments; Protocol-Level Tokens; sponsored
   transactions; or the Agent Registry MCP server.

## Checkpoint 1 (by Sun 22 Nov 23:59 UTC)

Create the project on the Encode platform, add the team (solo = just you), and share a short
description of what you plan to build. It does not need to be finished.

## Final submission (from the project page, by Wed 9 Dec 23:59 UTC)

- Description: what was built, how it works, which Concordium components it uses
- Public code repository
- Demo video, **≤ 3 minutes**
- **CCDExplorer link** (https://ccdexplorer.io/) showing the agent, contract or transactions
- Path to production: what it takes to go live on mainnet with real users
- "Make sure every link is public."

## Judging (Encode + Concordium; not transaction counts)

1. **Depth of integration** — how meaningfully it uses Concordium identity, the Agent Registry and agent payments
2. **Credible path to production** — believable route from testnet to mainnet and real users
3. **It works** — clear end-to-end demo of the core flow
4. **Usefulness** — real problem, real people or agents

## Identity: what is and is not real

- Every Concordium account is created from an identity issued by an identity provider (IdP). On
  **testnet**, the Concordium Wallet for Web offers **"Concordium testnet IP"**; the docs say: "You
  don't have to provide an ID to create an identity on testnet when selecting Concordium testnet IP.
  Test identities are meant for testnet testing only." Its form is pre-filled with dummy attributes.
  → **No real passport/ID is needed for the hackathon build.** Use dummy values; never enter real data.
- Other testnet IdPs listed in the testnet proof explorer (Notabene Staging, Digital Trust Solutions
  TestNet, Global FinReg Testnet, Dataspike) — not needed.
- **Mainnet** badge/identity (path-to-production only, not required to compete): passport + liveness
  check with an independent IdP through the Concordium Wallet; disclosure only by court order with
  Privacy Guardians. Not something to do for this hackathon.
- Verify and Access on testnet trusts `did:ccd:testnet:idp:0..3` issuers.
- Faucet: each testnet account can request test CCD **once, and only before it has incoming
  transactions** (wallet → Activity → Request CCD; the setup guide says 2000 CCD).
- Test PLTs (e.g. a test stablecoin) are **issued manually** by Concordium after a request form; there
  is no public faucet for arbitrary PLTs. Native CCD works with x402 without that.

## Testnet constants (verified 2026-10-30)

- Agent Registry (hosted MCP `contract_info`, network=testnet): CIS-8004 `<12802,0>`
  (module `142462ff…a5c6`), CIS-8 `<12801,0>`. Mainnet: CIS-8004 `<10082,0>`, CIS-8 `<10081,0>`.
- Hosted MCP: `https://agent-registry-mcp.concordium.com/mcp` (+ REST `/v1/check-badge/{badge}`),
  holds no keys; builders return sign-ready payloads.
- x402 testnet network id `ccd:4221332d34e1694168c2a0c0b3fd0f27`; gRPC `grpc.testnet.concordium.com:20000`.

## Exactly what the user must do (Hark cannot)

1. **Encode Club account + apply**: "Sign in to Apply" on the programme page. Sign-up details are not
   shown before login; the page publishes **no KYC** for applying. (Hark can do the sign-up with the
   usual hackathon email if you approve; nothing has been registered.)
2. **Checkpoint 1** (by Mon 23 Nov 07:59 Taipei): create the project, add yourself, paste the short
   description (draft will be in `docs/`). Needs your OK before posting.
3. **Testnet wallet with a test identity** — choose one:
   - (a) you install Concordium Wallet for Web, pick "Concordium testnet IP" (dummy data, no ID), make
     an account, Request CCD, export the key file; or
   - (b) Hark creates a throwaway testnet wallet in its own browser with the testnet IP (dummy
     identity, no real data), key kept outside the repo. Nothing in it is worth money.
   Either way **no real identity documents** are involved. Do not use a mainnet wallet.
4. **Public GitHub repo + demo video upload** (≤ 3 min) and the **final submission** (by Thu 10 Dec
   07:59 Taipei) — your confirmation needed for each public step.
5. **Payout requirements: unknown.** No prize amounts or payout method are published. If a prize is
   announced, expect Encode to ask winners for payout details (possibly a wallet address and/or KYC) at
   that time — re-check at the 2 Nov launch and in the platform's submission terms.
