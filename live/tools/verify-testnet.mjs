// Read-only verification of the live testnet deployment — needs NO keys. Anyone can run it:
//   cd live && npm ci && npm run verify
// Checks: both Agent Registry badges (hosted MCP), guard state of every demo authorisation, the
// ZK "verified human approved this" record of the approved payment (re-verified against chain),
// that replayed / missing proofs are not what the guard recorded as settled, the x402 settlement
// transactions (sponsored, from the 2-of-2 wallet, to the badge-verified seller, signed over the
// digest committed on chain), and that the
// hash-chained audit log's head matches the AuditAnchored event on chain.
import fs from 'node:fs';
import { AccountAddress, TransactionHash } from '@concordium/web-sdk';
import { testnetClient, explorerTx } from '../src/net.mjs';
import { deployedGuard } from '../src/guard-instance.mjs';
import { readState } from '../src/state.mjs';
import { enumTag, unOpt } from '../src/guard-client.mjs';
import { checkApproval, approvalResourceId, approvalContextString } from '../src/human-approval.mjs';
import { guardEventsOf, EVENT_TAGS } from '../src/guard-events.mjs';
import { settlementMatchesCommitment } from '../src/settlement-check.mjs';
import { AUDIT_FILE, loadApproval } from '../src/world.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { nameOf } from '../../agent/src/policy/errors.mjs';

const st = readState();
const run = JSON.parse(fs.readFileSync(new URL('../state/run.json', import.meta.url), 'utf8'));
const grpc = testnetClient();
const guard = deployedGuard(grpc);
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

for (const [which, b] of Object.entries(st.badges)) {
  const j = await (await fetch(`https://agent-registry-mcp.concordium.com/v1/check-badge/${b.tokenAddress}`)).json();
  ok(j.badge_valid === true && j.on_chain?.status === 'Active' && j.on_chain?.owner_account === b.holder, `${which} badge ${b.tokenAddress} valid, Active, owned by ${b.holder}`);
}
const me = await guard.agent(st.guard.agent);
ok(unOpt(me.record.badge)?.token_id?.toString() === st.badges.buyer.tokenId, `guard binds the agent to badge #${st.badges.buyer.tokenId} (owner holds it — checked on chain at registration)`);

ok(me.record.wallet === st.guard.wallet, `guard's registered wallet for the agent is ${st.guard.wallet}`);
const onchainThr = BigInt(me.record.policy.approval_threshold);
const pinnedThr = BigInt(st.guard.policy.approval_threshold);
ok(onchainThr <= pinnedThr, `on-chain approval threshold ${onchainThr} microCCD <= co-signer's pinned threshold ${pinnedThr} (a raise by the owner key alone would not switch off the human check)`);
const wi = await grpc.getAccountInfo(AccountAddress.fromBase58(st.guard.wallet));
const creds = Object.values(wi.accountCredentials);
const cpk = creds[0].value.contents.credentialPublicKeys;
const keys = Object.entries(cpk.keys).map(([i, k]) => [i, k.verifyKey]).sort();
ok(creds.length === 1 && Number(wi.accountThreshold) === 1 && Number(cpk.threshold) === 2
  && JSON.stringify(keys) === JSON.stringify([['0', st.guard.walletPublicKeys.agentKey0], ['1', st.guard.walletPublicKeys.cosignerKey1]]),
  `agent wallet is 2-of-2: one credential, keys = agent key 0 + co-signer key 1, threshold 2`);

const tx = async (h) => (await grpc.getBlockItemStatus(TransactionHash.fromHexString(h))).outcome?.summary;
const need = (n) => { const x = run.steps.filter((s) => s.step === n).at(-1); if (!x) { ok(false, `scenario '${n}' missing from state/run.json`); } return x; };
const paid = ['small', 'big-pay'].map(need).filter(Boolean);
ok(paid.every((p) => p.status === 'paid'), 'both demo payments (0.5 CCD auto, 4 CCD human-approved) are paid');
for (const p of paid) {
  const a = (await guard.authorization(p.authId)).auth;
  const s = await tx(p.txHash);
  ok(enumTag(a.status) === 'Settled' && unOpt(a.settlement) === p.txHash, `auth #${p.authId} Settled with x402 tx ${explorerTx(p.txHash)}`);
  const addr = (x) => String(x?.address ?? x);
  ok(addr(s.sender) === st.guard.wallet && s.sponsor?.sponsor && addr(s.transfer?.to) === st.badges.seller.holder && BigInt(s.transfer.amount.microCcdAmount ?? s.transfer.amount) === BigInt(a.amount),
    `  settlement is a sponsored transfer of ${a.amount} microCCD from the 2-of-2 wallet to the badge-verified seller`);
  ok(await settlementMatchesCommitment(grpc, { txHash: p.txHash, commitment: unOpt(a.commitment), walletPublicKeys: st.guard.walletPublicKeys }),
    `  the settled transaction is the committed one: both wallet signatures in it are on the digest stored by commitPayment`);
  const proof = unOpt(a.human_proof);
  if (BigInt(a.amount) > BigInt(me.record.policy.approval_threshold)) {
    const ap = loadApproval(p.authId);
    let verified = false;
    try { verified = await checkApproval({ grpc, recordJSON: ap.record, anchorTx: ap.anchorTx, ownerAddress: st.guard.owner, resourceId: approvalResourceId(guard.address, p.authId), contextString: approvalContextString(a), expectedAnchorHash: proof, trustedVerifiers: [st.guard.cosigner] }); } catch (e) { console.log('   ', e.message); }
    ok(verified, `  above threshold: ZK proof (age>=18, testnet IdP, owner's account credential) for THIS authorisation re-verified; anchors ${explorerTx(ap.requestTx)} / ${explorerTx(ap.anchorTx)}`);
  }
}
for (const [n, why] of [['forged-pay', 'made-up proof'], ['replay-pay', 'replayed proof of another payment']]) {
  const r = need(n);
  if (!r) continue;
  const a = (await guard.authorization(r.authId)).auth;
  ok(r.stage === 'cosigner' && enumTag(a.status) === 'Cancelled' && unOpt(a.commitment) === null && unOpt(a.human_proof) !== null,
    `auth #${r.authId}: owner approved with a ${why} -> co-signer refused (${r.reason}), never committed, Cancelled`);
}
const hij = need('hijacked');
if (hij) {
  const s = await tx(hij.txHash);
  const rr = s.rejectReason;
  const code = typeof hij.code === 'number' ? nameOf(hij.code) : hij.code;
  ok(s.transactionType === 'failed' && rr?.tag === 'RejectedReceive' && Number(rr.rejectReason) === -11 && code === 'PerTxCap'
    && String(rr.receiveName?.value ?? rr.receiveName) === 'agent_spend_guard.authorize' && BigInt(rr.contractAddress.index) === guard.address.index,
    `hijacked agent's direct 9 CCD authorize rejected by the guard on chain (PerTxCap) ${explorerTx(hij.txHash)}`);
}
const imp = need('impostor');
if (imp) ok(imp.status === 'refused' && imp.reason === 'payee_not_bound_to_badge', 'badge impostor refused before any transaction (payee_not_bound_to_badge)');

const log = new AuditLog({ file: AUDIT_FILE });
ok(AuditLog.verify(log.entries).ok, `audit log hash chain intact (${log.entries.length} entries)`);
const anc = need('anchor');
if (anc) {
  const ev = guardEventsOf(await tx(anc.txHash), guard.address.index).find((e) => e.tag === EVENT_TAGS.AuditAnchored);
  const b = Buffer.from(ev.hex, 'hex');
  const head = b.subarray(33, 65).toString('hex');
  const count = Number(b.readBigUInt64LE(65));
  ok(head === log.entries[count - 1]?.hash, `audit head of entry ${count} matches AuditAnchored on chain ${explorerTx(anc.txHash)}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
