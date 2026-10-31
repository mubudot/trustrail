import assert from 'node:assert/strict';
import { approval, proofChain } from '../proof-chain.mjs';
import { paymentFixture, A } from '../fixtures.mjs';
import { attack, control, refusal } from '../reporter.mjs';
import { checkApproval } from '../../src/human-approval.mjs';
import { verifyDigestWithKey } from '../../src/keys.mjs';
import { signingDigest, fromJSON } from '../../src/x402-buyer.mjs';
import { VerificationAuditRecordV1 } from '@concordium/web-sdk/wasm';

function forgedCredentialRecord() {
  const record = structuredClone(approval.record);
  const proof = record.presentation.verifiableCredential[0].proof;
  proof.proofValue = proof.proofValue.slice(0, -1) + (proof.proofValue.endsWith('0') ? '1' : '0');
  return record;
}

const check = async (over = {}) => {
  try {
    await checkApproval({ grpc: proofChain(), recordJSON: approval.record, anchorTx: approval.anchorTx,
      ownerAddress: A.owner, resourceId: approval.record.id, expectedAnchorHash: approval.anchorHash,
      trustedVerifiers: [A.cosigner], ...over });
    return 'ACCEPTED';
  } catch (e) { return e.message.split(':')[0]; }
};

export const approvalScenarios = [
  control('00', 'legitimate 4 CCD payment with human approval co-signed', async () => {
    const s = await paymentFixture();
    const sig = await s.cos.cosign(s.input); // Real checkApproval, ZK proof, anchors, mock commit.
    assert.ok(verifyDigestWithKey(s.keys.cosigner.publicKey, signingDigest(fromJSON(s.input.signableJSON)), sig));
    assert.equal(s.chain.authorization(5n).auth.status, 'Committed');
    return 'PASS';
  }),
  attack('01', 'replayed real proof for another authorisation', 'co-signer', 'approval_wrong_resource', async () => {
    const s = await paymentFixture();
    const target = s.chain.authorize(A.agent, s.request);
    s.chain.approve(A.owner, target.id, approval.anchorHash);
    const reason = await refusal(() => s.cos.cosign({ ...s.input, authId: target.id }));
    assert.equal(s.chain.authorization(target.id).auth.commitment, null);
    return reason;
  }),
  ...[['02', 'payee', A.owner], ['03', 'amount', '4000001']].map(([id, field, value]) =>
    attack(id, `real proof reused with different ${field}`, 'human approval', 'approval_wrong_payment_details', () => {
      const original = approval.record.request.context.given.find((g) => g.label === 'ContextString').context;
      return check({ contextString: original.replace(field === 'payee' ? A.seller : '4000000', value) });
    })),
  attack('04', 'bit-flipped human proof record', 'human approval', 'approval_hash_mismatch', async () => {
    return check({ recordJSON: forgedCredentialRecord() });
  }),
  attack('05', 'made-up approval anchor hash', 'co-signer', 'approval_hash_mismatch', async () => {
    const s = await paymentFixture({ humanProof: 'ab'.repeat(32) });
    return refusal(() => s.cos.cosign(s.input));
  }),
  attack('06', 'owner approval with no proof record', 'co-signer', 'human_approval_record_unavailable', async () => {
    const s = await paymentFixture({ approvalRecord: null, humanProof: 'ab'.repeat(32) });
    return refusal(() => s.cos.cosign(s.input));
  }),
  attack('34', 'forged credential proof with recomputed anchor hash', 'human approval', 'approval_proof_invalid', () => {
    const record = forgedCredentialRecord();
    const hash = Buffer.from(VerificationAuditRecordV1.computeAnchorHash(VerificationAuditRecordV1.fromJSON(record))).toString('hex');
    return check({ recordJSON: record, expectedAnchorHash: hash });
  }),
];
