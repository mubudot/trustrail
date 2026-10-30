// Read-only verification of the live testnet deployment — needs NO keys. Anyone can run it:
//   cd live && npm ci && npm run verify
// Checks: both Agent Registry badges (hosted MCP), guard state of every demo authorisation, the
// ZK "verified human approved this" record of the approved payment (re-verified against chain),
// that replayed / missing proofs are not what the guard recorded as settled, the x402 settlement
// transactions (sponsored, from the 2-of-2 wallet, to the badge-verified seller), and that the
// hash-chained audit log's head matches the AuditAnchored event on chain.
import fs from 'node:fs';
import { AccountAddress, TransactionHash } from '@concordium/web-sdk';
import { testnetClient, explorerTx } from '../src/net.mjs';
import { deployedGuard } from '../src/guard-instance.mjs';
import { readState } from '../src/state.mjs';
import { enumTag, unOpt } from '../src/guard-client.mjs';
import { checkApproval, approvalResourceId } from '../src/human-approval.mjs';
import { guardEventsOf, EVENT_TAGS } from '../src/guard-events.mjs';
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

const wi = await grpc.getAccountInfo(AccountAddress.fromBase58(st.guard.wallet));
const cpk = Object.values(wi.accountCredentials)[0].value.contents.credentialPublicKeys;
ok(Object.keys(cpk.keys).length === 2 && Number(cpk.threshold) === 2 && Number(wi.accountThreshold) === 1, `agent wallet ${st.guard.wallet} is 2-of-2 (agent key + co-signer key)`);

const tx = async (h) => (await grpc.getBlockItemStatus(TransactionHash.fromHexString(h))).outcome?.summary;
const paid = run.steps.filter((s) => s.status === 'paid');
for (const p of paid) {
  const a = (await guard.authorization(p.authId)).auth;
  const s = await tx(p.txHash);
  ok(enumTag(a.status) === 'Settled' && unOpt(a.settlement) === p.txHash, `auth #${p.authId} Settled with x402 tx ${explorerTx(p.txHash)}`);
  const addr = (x) => String(x?.address ?? x);
  ok(addr(s.sender) === st.guard.wallet && s.sponsor?.sponsor && addr(s.transfer?.to) === st.badges.seller.holder && BigInt(s.transfer.amount.microCcdAmount ?? s.transfer.amount) === BigInt(a.amount),
    `  settlement is a sponsored transfer of ${a.amount} microCCD from the 2-of-2 wallet to the badge-verified seller`);
  const proof = unOpt(a.human_proof);
  if (BigInt(a.amount) > BigInt(me.record.policy.approval_threshold)) {
    const ap = loadApproval(p.authId);
    let verified = false;
    try { verified = await checkApproval({ grpc, recordJSON: ap.record, anchorTx: ap.anchorTx, ownerAddress: st.guard.owner, resourceId: approvalResourceId(guard.address, p.authId), expectedAnchorHash: proof }); } catch (e) { console.log('   ', e.message); }
    ok(verified, `  above threshold: ZK proof (age>=18, testnet IdP, owner's account credential) for THIS authorisation re-verified; anchors ${explorerTx(ap.requestTx)} / ${explorerTx(ap.anchorTx)}`);
  }
}
for (const id of run.steps.filter((s) => s.stage === 'cosigner').map((s) => s.authId)) {
  const a = (await guard.authorization(id)).auth;
  ok(enumTag(a.status) === 'Cancelled' && unOpt(a.commitment) === null, `auth #${id}: approved without a valid proof -> never co-signed, Cancelled (budget released)`);
}
const hij = run.steps.find((s) => s.step === 'hijacked');
if (hij) { const s = await tx(hij.txHash); ok(s.transactionType === 'failed' || s.rejectReason, `hijacked agent's direct 9 CCD authorize rejected on chain (${typeof hij.code === 'number' ? nameOf(hij.code) : hij.code}) ${explorerTx(hij.txHash)}`); }

const log = new AuditLog({ file: AUDIT_FILE });
ok(AuditLog.verify(log.entries).ok, `audit log hash chain intact (${log.entries.length} entries)`);
const anc = run.steps.filter((s) => s.step === 'anchor').at(-1);
if (anc) {
  const ev = guardEventsOf(await tx(anc.txHash), guard.address.index).find((e) => e.tag === EVENT_TAGS.AuditAnchored);
  const b = Buffer.from(ev.hex, 'hex');
  const head = b.subarray(33, 65).toString('hex');
  const count = Number(b.readBigUInt64LE(65));
  ok(head === log.entries[count - 1]?.hash, `audit head of entry ${count} matches AuditAnchored on chain ${explorerTx(anc.txHash)}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
