# TrustRail demo video — plan and script (target ≤ 3:00; delivered cut 2:51)

Pitch first: **No verified human, no payment.** Every on-chain screen is a real Concordium
**testnet** transaction from the demo run in [TESTNET.md](TESTNET.md), shown on CCDExplorer. The
closing check is real output of `cd live && npm run verify` (read-only, no keys).

Rules for the footage: no keys or seed phrases, no personal names, no real identity data. The
on-chain identities are testnet-IdP test identities with dummy attributes; only public account
addresses, account indexes and transaction hashes appear.

Format: 1920×1080, 30 fps, English narration (local TTS) with burned-in captions, no music.
Look: dark navy background, one blue accent, green for "paid", red for "refused". Explorer
screenshots are captured at 2× and cropped to the transaction and event panels, with a large
callout that restates the key fact so it reads on a phone.

| # | Time (approx.) | Screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00–0:14 | Title: "No verified human, no payment." · TrustRail · AI agent payments on Concordium · live on testnet | No verified human, no payment. TrustRail lets an AI agent pay other agents on Concordium, but every large payment needs a zero-knowledge proof that the identity-verified owner approved that exact payment. Everything you will see is a real testnet transaction. |
| 2 | 0:14–0:27 | The problem: caps + an approve button = a flag any owner-key holder can flip | Agents now pay for data and APIs over x402. Most agent wallets stop at a spending cap and an approve button. But an approve button is just a flag: anything holding the owner key can press it. |
| 3 | 0:27–0:52 | Diagram: agent (key 0) + co-signer (key 1) = 2-of-2 wallet; guard contract `<13037,0>`; Verify-and-Access proof bound to guard / authorisation / payee / amount | The agent's wallet is a native two-of-two Concordium account. The agent holds one key, a small co-signer holds the other. A guard contract enforces caps and the allowlist on chain. Above two CCD, the co-signer signs only after it re-verifies a Verify and Access proof, made from the owner's Concordium identity, that names this guard, this authorisation, this payee and this amount. |
| 4 | 0:52–1:03 | CCDExplorer: sponsored transfer 0.5 CCD, Success (`86b08eae…`) | First, a half CCD weather feed. It is under the threshold, so the guard approves it on chain, the co-signer commits the exact transaction hash, and the x402 facilitator sponsors the transfer. |
| 5 | 1:03–1:35 | CCDExplorer sequence: `authorize` → Pending (`b7783b8b…`); verification request anchored, Data Registered (`21894906…`); `approve` with `human_proof` (`6399605d…`); sponsored transfer 4 CCD, Success (`9c8b101a…`) | Now a four CCD dataset. The guard holds it as pending. The co-signer anchors a verification request on chain. The owner answers with a zero-knowledge proof: an adult with a valid Concordium identity who holds the owner account's credential, and nothing else is revealed. The hash of that audit record goes into the guard with approve. Only then does the co-signer sign, and the four CCD settle. |
| 6 | 1:35–1:48 | Attack 1: owner key + made-up proof hash → `human_approval_record_unavailable` (agent's hash-chained audit log) | Now the attacks. With the owner key alone, we approve a payment with a made-up proof hash. The contract accepts the call, but there is no proof behind it. The co-signer refuses, and the wallet cannot pay without its key. |
| 7 | 1:48–2:00 | Attack 2: CCDExplorer `cancel` (`25dd71a0…`) after a replayed genuine proof → `approval_wrong_resource` | Next, we replay a genuine proof from an earlier payment. The proof and its anchor are valid, but they name a different authorisation. Refused, and cancelled on chain. |
| 8 | 2:00–2:16 | Attack 3: CCDExplorer Rejected, `rejected_receive` (`a7379c9c…`) = `PerTxCap`; Attack 4: look-alike seller → `payee_not_bound_to_badge` | A misbehaving agent skips its own checks and asks the guard for nine CCD directly. The contract rejects it on chain: per transaction cap. And a look-alike seller that shows a real badge but a different pay-to address is refused before any transaction. |
| 9 | 2:16–2:36 | Terminal: real `npm run verify` output, 23 PASS, "all checks passed"; audit log head anchored after the run and matching all 6 on-chain authorisations (`38d93421…`) | Anyone can check this without keys. One command re-verifies the badges, the two-of-two wallet, both settlements against the committed transaction hash, the zero-knowledge proof, every refusal, and the audit log head anchored on chain. Twenty-three checks pass. |
| 10 | 2:36–2:56 | Honest limits + close: owner key = policy admin (co-signer pins its own threshold); demo co-signer shares the agent's Node process (production: separate service); 88 tests (contract 27 · agent 27 · live adapters 34); "No verified human, no payment." | What we do not claim: the owner key can still change the policy, so the co-signer pins its own threshold and refuses without a proof. In this demo the co-signer shares the agent's process; production needs it as a separate service. TrustRail. No verified human, no payment. |

Build: `work/ccdvid/build.py` in the hackathon workspace (outside this repo) renders the scenes from
the explorer captures and `verify` output, narrates them with Piper, and writes `concordium_demo.mp4`.
