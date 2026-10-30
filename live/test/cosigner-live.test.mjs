import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCosigner, CosignRefused } from '../src/cosigner-live.mjs';
import { buildTransfer, signAsKey, toJSON, signingDigest, fromJSON } from '../src/x402-buyer.mjs';
import { verifyDigestWithKey } from '../src/keys.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { A, FakeGuard, auth, record, fakeGrpc, requirements, walletKeys } from './helpers.mjs';

const URL_ = 'http://127.0.0.1:4402/dataset';

async function setup({ authOver = {}, recOver = {}, reqAmount = '4000000', approvalOk = true, approvals = true } = {}) {
  const k = walletKeys();
  const req = requirements(reqAmount);
  const guard = new FakeGuard({ auth: auth({ purpose_hash: purposeHash(URL_, requirements()), ...authOver }), record: record(recOver) });
  const checked = [];
  const cos = new LiveCosigner({
    guard, account: { address: A.cosigner, signer: null }, walletKey: k.cosigner.privateKey, agentPublicKey: k.agent.publicKey,
    agentAccount: A.agent, owner: A.owner,
    approvals: async () => (approvals ? { record: {}, anchorTx: 'aa'.repeat(32) } : null),
    checkApproval: async (args) => { checked.push(args); if (!approvalOk) throw new Error('approval_wrong_resource: other payment'); return true; },
  });
  const tx = signAsKey(await buildTransfer(fakeGrpc, { sender: A.wallet, requirements: req }), 0, k.agent.privateKey);
  return { k, guard, cos, tx, req, checked };
}
const refusal = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof CosignRefused, e.message); return e.reason; } return 'signed'; };

test('signs only after verifying the human approval and committing the digest on chain', async () => {
  const { k, guard, cos, tx, checked } = await setup();
  const sig = await cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() });
  const digest = signingDigest(fromJSON(toJSON(tx)));
  assert.ok(verifyDigestWithKey(k.cosigner.publicKey, digest, sig));
  assert.deepEqual(guard.sent.map((s) => s.entry), ['commitPayment']);
  assert.equal(guard.sent[0].value.digest, digest);
  assert.equal(checked[0].expectedAnchorHash, '11'.repeat(32));
  assert.equal(checked[0].resourceId, 'trustrail:ccd:testnet:13037:0:auth:1');
  assert.equal(checked[0].ownerAddress, A.owner);
});

test('refuses: above threshold but no human proof on chain', async () => {
  const { cos, tx } = await setup({ authOver: { human_proof: { None: [] } } });
  assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), 'human_approval_missing');
});

test('refuses: proof does not verify (e.g. replayed from another payment)', async () => {
  const { cos, tx, guard } = await setup({ approvalOk: false });
  assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), 'approval_wrong_resource');
  assert.equal(guard.sent.length, 0, 'nothing committed');
});

test('refuses: proof record unavailable', async () => {
  const { cos, tx } = await setup({ approvals: false });
  assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), 'human_approval_record_unavailable');
});

test('refuses: not Approved, paused agent, payee removed from allowlist, guard paused', async () => {
  for (const [opts, reason] of [
    [{ authOver: { status: { Pending: [] } } }, 'status_Pending'],
    [{ recOver: { paused: true } }, 'agent_paused'],
    [{ recOver: { allowlist: [] } }, 'payee_not_allowlisted'],
    [{ recOver: { generation: 2n } }, 'stale_generation'],
    [{ authOver: { expires_at: new Date(Date.now() - 1).toISOString() } }, 'authorization_expired'],
  ]) {
    const { cos, tx } = await setup(opts);
    assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), reason);
  }
  const { cos, tx, guard } = await setup();
  guard._paused = true;
  assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), 'guard_paused');
});

test('refuses a transfer that differs from the authorisation', async () => {
  const { cos, tx } = await setup({ reqAmount: '4000001' });
  assert.equal(await refusal(cos.cosign({ authId: 1n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() })), 'tx_amount_mismatch');
  const s2 = await setup({ authOver: { payee: A.owner }, recOver: { allowlist: [A.owner, A.seller] } });
  assert.equal(await refusal(s2.cos.cosign({ authId: 1n, signableJSON: toJSON(s2.tx), resourceUrl: URL_, requirements: requirements() })), 'tx_payee_mismatch');
  const s3 = await setup();
  assert.equal(await refusal(s3.cos.cosign({ authId: 1n, signableJSON: toJSON(s3.tx), resourceUrl: 'http://evil/', requirements: requirements() })), 'purpose_mismatch');
});

test('refuses without a valid agent signature, and when the on-chain commit fails', async () => {
  const s = await setup();
  const j = toJSON(s.tx);
  j.signatures.sender[0][0] = '00'.repeat(64);
  assert.equal(await refusal(s.cos.cosign({ authId: 1n, signableJSON: j, resourceUrl: URL_, requirements: requirements() })), 'agent_signature_invalid');
  const s2 = await setup();
  s2.guard.failCommit = true;
  assert.equal(await refusal(s2.cos.cosign({ authId: 1n, signableJSON: toJSON(s2.tx), resourceUrl: URL_, requirements: requirements() })), 'commit_-21');
});

test('small auto-approved payment needs no human proof', async () => {
  const { cos, tx } = await setup({ reqAmount: '500000', authOver: { amount: 500_000n, human_proof: { None: [] } } });
  // (the fixture's purpose hash binds requirements(); only the paid amount differs here)
  const sig = await cos.cosign({ authId: 0n, signableJSON: toJSON(tx), resourceUrl: URL_, requirements: requirements() });
  assert.match(sig, /^[0-9a-f]{128}$/);
});
