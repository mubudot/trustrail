# What only the entrant has to do

Everything technical is done and runs on testnet without any action from you: the testnet identity
came from the Concordium **testnet** identity provider with its own dummy attributes (no KYC, no
real documents, no wallet app), and the accounts, faucet CCD, guard contract, CIS-8004 badges,
x402 payments and audit anchors were all created by the scripts in [RUNBOOK.md](RUNBOOK.md).
Nothing below involves mainnet or money.

You can review the protections locally with `bash scripts/attacks.sh` from the repository root
([attack map and setup](ATTACKS.md)). Current suites: **177 passing tests** — contract 34
(9 unit + 25 integration), agent 33, live 110. The Node attack demonstration reports
**32 attacks BLOCKED, 4 controls PASS, 0 unexpected**.

What is left needs your account or your decision:

1. **Checkpoint 1, by Mon 23 Nov 07:59 Taipei (Sun 22 Nov 23:59 UTC).** On the Encode dashboard
   (Concordium Trusted Agents Hackathon → Create Project) paste the name and description from
   [CHECKPOINT1.md](CHECKPOINT1.md). The programme opens on 2 Nov; you can also just tell the
   assistant to do it with your saved Encode login.
2. **Say when the repository may go public.** The final submission needs a public repo. The
   history has been scanned for secrets and personal data; `live/.secrets/` is gitignored.
3. **Approve the demo video upload** (YouTube, unlisted is enough) when you have reviewed it.
4. **Keep the Agent Card host up until judging ends, or approve moving the cards.** The two badges
   are only `VALID` while their cards are served at the pinned URL (today a temporary host on the
   project VPS). Once the repo is public the cards can move to GitHub Pages; that needs one free
   testnet `setAgentURI` per badge (`publish-agent-cards.mjs --pin`), which the assistant can run.
5. **Final submission, by Thu 10 Dec 07:59 Taipei.** Submit on the Encode dashboard with the repo
   link, the video link and a CCDExplorer link (guard `<13037,0>`:
   https://ccdexplorer.io/testnet/instance/13037/0).

Optional: connect Discord in the Encode dashboard to get the programme channels.
