# TrustRail demo video — plan and script (target ≤ 3:00; delivered cut 2:58)

Pitch first: **No verified human, no payment.** Every on-chain screen is a real Concordium
**testnet** transaction from the demo run in [TESTNET.md](TESTNET.md), shown on CCDExplorer. The
badge screen is real output of `cd live && npm run check-badge` and the closing check is real output
of `cd live && npm run verify` (both read-only, no keys). The attack-suite screen is real output of
the offline runner `cd live && npm run attacks` (also run by `bash scripts/attacks.sh`; no keys, no network).

Rules for the footage: no keys or seed phrases, no personal names, no real identity data. The
on-chain identities are testnet-IdP test identities with dummy attributes; only public account
addresses, account indexes and transaction hashes appear.

Format: 1920×1080, 30 fps, English narration (local TTS) with burned-in captions, no music.
Look: dark navy background, one blue accent, green for "paid", red for "refused". Explorer
screenshots are captured at 2× and cropped to the transaction and event panels, with a large
callout that restates the key fact so it reads on a phone.

| # | Time (approx.) | Screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00–0:16 | Title: "No verified human, no payment." · TrustRail · AI agent payments on Concordium · live on testnet | No verified human, no payment. TrustRail lets an AI agent pay other agents on Concordium, but every large payment needs a zero-knowledge proof that the verified owner approved it. Every payment you will see is a real transaction on Concordium testnet. |
| 2 | 0:16–0:27 | The problem: caps + an approve button = a flag any owner-key holder can flip | Agents now pay for data and APIs over x402. Most agent wallets stop at a spending cap and an approve button, and anything holding the owner key can press it. |
| 3 | 0:27–0:50 | Diagram: agent (key 0) + co-signer (key 1) = 2-of-2 wallet; guard contract `<13037,0>`; Verify-and-Access proof bound to guard / authorisation / payee / amount | The agent's wallet is a native two-of-two Concordium account: the agent holds one key, a small co-signer holds the other. A guard contract enforces caps and the allowlist on chain. Above two CCD, the co-signer signs only after it re-verifies a Verify and Access proof from the owner's Concordium identity that names this guard, authorisation, payee and amount. |
| 4 | 0:50–1:02 | Agent Registry badges: real `cd live && npm run check-badge` output (hosted Agent Registry MCP `check_badge`, read-only): buyer agent CIS-8004 token #977 and seller agent token #978, both VALID, Active, card hash matches on chain (card host shortened to its path on screen) | Both agents carry Agent Registry badges, tokens 977 and 978. The hosted registry reports both valid, and each agent card matches its hash on chain. |
| 5 | 1:02–1:15 | CCDExplorer: real x402 settlement, sponsored transfer 0.5 CCD from the 2-of-2 wallet, Success (`86b08eae…`) | First, a half CCD weather feed. Under the threshold, the guard approves it, the co-signer commits the exact signing digest, and the x402 facilitator sponsors the transfer. |
| 6 | 1:15–1:41 | CCDExplorer sequence: `authorize` → Pending (`b7783b8b…`); verification request anchored, Data Registered (`21894906…`); `approve` with `human_proof` (`6399605d…`); x402 settlement, sponsored transfer 4 CCD, Success (`9c8b101a…`) | Now a four CCD dataset. The guard holds it as pending. The co-signer anchors a verification request on chain. The owner answers with a zero-knowledge proof: an adult with a valid Concordium identity who holds the owner account's credential; no other identity attribute is revealed. The hash of that audit record goes into the guard with approve. Only then does the co-signer sign, and the four CCD settle. |
| 7 | 1:42–1:54 | Attack 1: owner key + made-up proof hash → `human_approval_record_unavailable` (agent's hash-chained audit log) | Now the attacks. With the owner key alone, we approve a payment with a made-up proof hash. The contract accepts it, but with no proof behind it the co-signer refuses and nothing pays. |
| 8 | 1:54–2:04 | Attack 2: CCDExplorer `cancel` (`25dd71a0…`) after a replayed genuine proof → `approval_wrong_resource` | Next, we replay a genuine proof from an earlier payment. The proof and its anchor are valid, but they name a different authorisation. Refused, and cancelled on chain. |
| 9 | 2:04–2:21 | Attack 3: CCDExplorer Rejected, `rejected_receive` (`a7379c9c…`) = `PerTxCap`; Attack 4: look-alike seller → `payee_not_bound_to_badge` | A misbehaving agent skips its own checks and asks the guard for nine CCD directly. The contract rejects it on chain: per transaction cap. A look-alike seller with a real badge but a different pay-to address is refused before any transaction. |
| 10 | 2:21–2:28 | Attack suite: real output of the offline runner, 14 of the 32 `[BLOCKED]` lines with their exact refusal codes (replayed proof `approval_wrong_resource`, wrong payee/amount, paused/re-registered agent, expired authorisation, double co-sign `status_Committed`, raised threshold, stolen/revoked badge, tampered Agent Card `payee_card_hash_mismatch`, daily cap, forged credential proof, replica race); summary "32 attacks BLOCKED, 4 controls PASS, 0 unexpected"; "+ 27 contract refusals against the real guard Wasm · 158 automated tests in total" | One command runs thirty-two attacks offline through the same checks: all blocked, and legitimate payments still pass. |
| 11 | 2:28–2:42 | Terminal: real `npm run verify` output, 23 PASS, "all checks passed"; audit log head anchored after the run and matching all 6 on-chain authorisations (`38d93421…`) | Anyone can check this without keys. One command re-checks the badges, the wallet, both settlements against the committed digest, the proof, every refusal, and the anchored audit log. Twenty-three checks pass. |
| 12 | 2:42–2:58 | Honest limits + close: owner key = policy admin (co-signer pins its own threshold); demo co-signer shares the agent's Node process (production: separate service); 158 tests (contract 34 · agent 33 · live adapters 91); "No verified human, no payment." | What we do not claim: the owner key can change the policy; the co-signer pins its own threshold. In this demo the co-signer shares the agent's process; production needs it as a separate service. TrustRail. No verified human, no payment. |

Build: `work/ccdvid/build.py` in the hackathon workspace (outside this repo) renders the scenes from
the explorer captures, `check-badge`, `attacks` and `verify` output, narrates them with Piper, and writes `concordium_demo.mp4`.
