// Live testnet scenarios, one step per run (each finishes well inside two minutes):
//   small | big-request | big-approve | big-pay | forged-request | forged-approve | forged-pay |
//   replay-request | replay-approve | replay-pay |
//   over-cap | hijacked | impostor | anchor
// Evidence (tx hashes, outcomes) is appended to live/state/run.json; docs/TESTNET.md is written from it.
import fs from 'node:fs';
import path from 'node:path';
import { createLiveWorld, STATE_DIR, approvalFile, loadApproval } from '../src/world.mjs';
import { requestApproval, proveApproval, recordApproval, approvalResourceId } from '../src/human-approval.mjs';
import { readSecret } from '../src/secrets.mjs';
import { roleSigner } from '../src/signers.mjs';
import { selectRequirements, getPaymentRequired } from '../src/x402-buyer.mjs';
import { TESTNET } from '../src/net.mjs';

const RUN_FILE = path.join(STATE_DIR, 'run.json');
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const run = fs.existsSync(RUN_FILE) ? JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')) : { steps: [] };
const save = (step, result) => {
  run.steps.push({ step, at: new Date().toISOString(), ...JSON.parse(JSON.stringify(result, big)) });
  fs.writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
  console.log(step, JSON.stringify(result, big));
};
const last = (step) => [...run.steps].reverse().find((s) => s.step === step);

const step = process.argv[2];
const w = await createLiveWorld();
const ownerSide = { sender: w.acc.owner.address, signer: roleSigner(w.acc.owner) };
const verifier = { address: w.acc.cosigner.address, signer: roleSigner(w.acc.cosigner) };
try {
  if (step === 'small') {
    save(step, await w.agent.buy(`${w.seller.url}/weather`, { intent: 'check the weather' }));
  } else if (step === 'big-request' || step === 'forged-request' || step === 'replay-request') {
    save(step, await w.agent.buy(`${w.seller.url}/dataset`, { intent: 'buy a labelled dataset' }));
    // keep what resume() needs across runs: the requirements the authorisation was made for
    const pr = await getPaymentRequired(`${w.seller.url}/dataset`);
    const req = selectRequirements(pr.paymentRequired, { network: TESTNET.x402Network });
    run.pending ??= {};
    run.pending[step] = { authId: run.steps.at(-1).authId, url: `${w.seller.url}/dataset`, requirements: req };
    fs.writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
  } else if (step === 'big-approve') {
    // Verified-human approval: ZK proof (age >= 18, testnet IdP) from the OWNER account credential.
    const { authId } = run.pending['big-request'];
    let rec = loadApproval(authId); // resumable: the proof + anchor may already exist
    if (!rec) {
      const view = await w.guard.authorization(authId);
      const request = await requestApproval({ grpc: w.grpc, verifier, guard: w.guard.address, authId, auth: view.auth });
      const presentation = await proveApproval({ grpc: w.grpc, request, identity: readSecret('identity-owner'), credNumber: w.acc.owner.credNumber, ownerAddress: w.acc.owner.address });
      rec = await recordApproval({ grpc: w.grpc, verifier, request, presentation, ownerAddress: w.acc.owner.address, resourceId: approvalResourceId(w.guard.address, authId) });
      fs.writeFileSync(approvalFile(authId), `${JSON.stringify({ record: rec.record, anchorTx: rec.anchorTx, requestTx: rec.requestTx, anchorHash: rec.anchorHash }, big, 2)}\n`);
    }
    const ap = await w.guard.send('approve', { id: BigInt(authId), human_proof: rec.anchorHash }, ownerSide);
    w.audit.append('human_approved', { authId, requestTx: rec.requestTx, anchorTx: rec.anchorTx, anchorHash: rec.anchorHash, approveTx: ap.txHash });
    save(step, { authId, requestTx: rec.requestTx, recordAnchorTx: rec.anchorTx, anchorHash: rec.anchorHash, approveTx: ap.txHash });
  } else if (step === 'forged-approve') {
    // The owner key alone (no proof): approve with a made-up hash. The contract accepts the call,
    // but the co-signer will not sign without a verifiable record behind that hash.
    const { authId } = run.pending['forged-request'];
    const ap = await w.guard.send('approve', { id: BigInt(authId), human_proof: 'ab'.repeat(32) }, ownerSide);
    w.audit.append('approved_without_proof', { authId, approveTx: ap.txHash });
    save(step, { authId, approveTx: ap.txHash });
  } else if (step === 'replay-approve') {
    // Replay attack: approve with the anchor hash of the VALID human approval of auth #1 and hand
    // the co-signer that genuine record. Proof and anchor verify — but they name another payment.
    const { authId } = run.pending['replay-request'];
    const first = loadApproval(run.pending['big-request'].authId);
    fs.writeFileSync(approvalFile(authId), `${JSON.stringify({ ...first, _note: `replayed from auth #${run.pending['big-request'].authId} (attack demo)` }, null, 2)}\n`);
    const ap = await w.guard.send('approve', { id: BigInt(authId), human_proof: first.anchorHash }, ownerSide);
    w.audit.append('approved_with_replayed_proof', { authId, approveTx: ap.txHash });
    save(step, { authId, approveTx: ap.txHash, replayedAnchorHash: first.anchorHash });
  } else if (['big-pay', 'forged-pay', 'replay-pay'].includes(step)) {
    const p = run.pending[step.replace('-pay', '-request')];
    w.agent.pending.set(String(p.authId), { url: p.url, requirements: p.requirements });
    save(step, await w.agent.resume(p.authId));
  } else if (step === 'over-cap') {
    save(step, await w.agent.buy(`${w.seller.url}/bulk`, { intent: 'export everything' }));
  } else if (step === 'hijacked') {
    // A compromised agent process skips the local preflight and asks the chain directly.
    const pr = await getPaymentRequired(`${w.seller.url}/bulk`);
    const req = selectRequirements(pr.paymentRequired, { network: TESTNET.x402Network });
    save(step, await w.agent.authorize(req, `${w.seller.url}/bulk`));
  } else if (step === 'impostor') {
    save(step, await w.agent.buy(`${w.impostor.url}/refund`, { intent: 'claim refund' }));
  } else if (step === 'anchor') {
    const head = w.audit.entries.at(-1);
    const r = await w.guard.send('anchorAudit', { head: head.hash, count: BigInt(w.audit.entries.length) }, { sender: w.acc.agent.address, signer: roleSigner(w.acc.agent) });
    save(step, { head: head.hash, count: w.audit.entries.length, txHash: r.txHash });
  } else {
    throw new Error(`unknown step ${step}`);
  }
} finally {
  w.close();
}
process.exit(0);
