# What only the entrant has to do

Everything technical is done and runs on testnet without any action from you: the testnet identity
came from the Concordium **testnet** identity provider with its own dummy attributes (no KYC, no
real documents, no wallet app), and the accounts, faucet CCD, guard contract, CIS-8004 badges,
x402 payments and audit anchors were all created by the scripts in [RUNBOOK.md](RUNBOOK.md).
Nothing below involves mainnet or money.

You can review the protections locally with `bash scripts/attacks.sh` from the repository root
([attack map and setup](ATTACKS.md)). Current suites: **202 passing tests** — contract 34
(9 unit + 25 integration), agent 33, live 135. The Node attack demonstration reports
**32 attacks BLOCKED, 4 controls PASS, 0 unexpected**.

Done: the project is created on the Encode dashboard (Checkpoint 1, due Sun 22 Nov 23:59 UTC), the
repository is public, and the demo video is uploaded: https://youtu.be/lQQWTXewqcg (linked from the
README "Judge start" line and [SUBMISSION.md](SUBMISSION.md)).

What is left needs your account or your decision:

1. **Keep the Agent Card host up until judging ends, or approve moving the cards.** The two badges
   are only `VALID` while their cards are served at the pinned URL (today a temporary host on the
   project VPS). Once the repo is public the cards can move to GitHub Pages; that needs one free
   testnet `setAgentURI` per badge (`publish-agent-cards.mjs --pin`).
2. **Final submission, by Wed 9 Dec 23:59 UTC.** Submit on the Encode dashboard with the repo
   link, the video link and a CCDExplorer link (guard `<13037,0>`:
   https://ccdexplorer.io/testnet/instance/13037/0).

Optional: connect Discord in the Encode dashboard to get the programme channels.
