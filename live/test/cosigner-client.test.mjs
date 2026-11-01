import test from 'node:test';
import assert from 'node:assert/strict';
import { CosignerClient, CosignerUnavailable } from '../src/cosigner-client.mjs';
import { LiveAgent } from '../src/live-agent.mjs';
import { PurchaseTools } from '../src/mcp/purchase-tools.mjs';
import { fromJSON, signingDigest } from '../src/x402-buyer.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { paymentFixture, A } from '../attacks/fixtures.mjs';

const TOKEN = 'offline-client-test-token-at-least-32-characters';
const signed = { authId: '5', status: 'signed', signature: 'ab'.repeat(64), receipt: { commitTx: 'c0'.repeat(32), digest: 'cd'.repeat(32) } };
const clientFor = (body, status = 200) => new CosignerClient({ url: 'http://127.0.0.1:4410', token: TOKEN,
  fetchImpl: async () => new Response(JSON.stringify(body), { status }) });

const malformed = [
  ['JSON_null', null, 200],
  ['JSON_null_unauthorized', null, 401],
  ['JSON_null_unavailable', null, 503],
  ['array', [], 200],
  ['primitive', 'signed', 200],
  ['missing_fields', {}, 200],
  ['missing_status', { authId: '5' }, 200],
  ['unknown_status', { ...signed, status: 'maybe_signed' }, 200],
  ['missing_auth_id', { ...signed, authId: undefined }, 200],
  ['different_auth_id', { ...signed, authId: '6' }, 200],
  ['missing_signature', { ...signed, signature: undefined }, 200],
  ['signature_array', { ...signed, signature: [signed.signature] }, 200],
  ['missing_receipt', { ...signed, receipt: undefined }, 200],
  ['null_receipt', { ...signed, receipt: null }, 200],
  ['receipt_array', { ...signed, receipt: [] }, 200],
  ['missing_digest', { ...signed, receipt: { commitTx: signed.receipt.commitTx } }, 200],
  ['malformed_receipt', { ...signed, receipt: { ...signed.receipt, digest: 'bad-digest' } }, 200],
  ['commit_hash_array', { ...signed, receipt: { ...signed.receipt, commitTx: [signed.receipt.commitTx] } }, 200],
  ['missing_refusal_reason', { authId: '5', status: 'refused' }, 422],
  ['empty_refusal_reason', { authId: '5', status: 'refused', reason: '' }, 422],
  ['unrecognized_error', { authId: '5', status: 'error', reason: 'unknown' }, 503],
];

test('client_classifies_all_malformed_signing_responses_as_unavailable', async () => {
  for (const [label, body, status] of malformed) {
    const client = clientFor(body, status);
    await assert.rejects(client.cosign({ authId: 5n }), CosignerUnavailable, label);
    assert.equal(client.lastCommitTx, null, label);
  }
});

test('client_validates_every_release_response_field', async () => {
  const released = { authId: '5', status: 'released', released: true, receipt: { cancelTx: 'ca'.repeat(32) } };
  const bad = [null, [], {}, { ...released, authId: undefined }, { ...released, released: undefined },
    { ...released, released: 'true' }, { ...released, receipt: undefined }, { ...released, receipt: null },
    { ...released, receipt: { cancelTx: ['ca'.repeat(32)] } }, { ...released, receipt: { cancelTx: 'bad-hash' } },
    { ...released, released: false }, { ...released, released: false, receipt: {} }];
  for (const body of bad) await assert.rejects(clientFor(body).releaseWithReceipt(5n), CosignerUnavailable);
  assert.deepEqual(await clientFor(released).releaseWithReceipt(5n), { released: true, cancelTx: released.receipt.cancelTx });
  assert.deepEqual(await clientFor({ ...released, released: false, receipt: { cancelTx: null } }).releaseWithReceipt(5n), { released: false, cancelTx: null });
});

for (const [label, body, status] of malformed.filter(([name]) =>
  ['JSON_null', 'JSON_null_unauthorized', 'JSON_null_unavailable', 'missing_fields', 'missing_digest', 'malformed_receipt'].includes(name))) {
  test(`buyer_preserves_unknown_commit_on_${label}_without_release_or_payment_retry`, async () => {
    const f = await paymentFixture({ amount: 500_000n, human: false });
    const client = clientFor(body, status);
    const transport = client.fetchImpl;
    let signingRequests = 0;
    client.fetchImpl = async (...args) => {
      signingRequests++;
      f.chain.commitPayment(A.cosigner, { id: 5n, digest: signingDigest(fromJSON(f.input.signableJSON)) });
      return transport(...args);
    };
    client.release = async () => assert.fail('unknown signing outcome must not release');
    const audit = new AuditLog();
    const buyer = new LiveAgent({ grpc: f.guard.grpc, guard: f.guard, agent: { address: A.agent }, walletKey0: f.keys.agent.privateKey,
      cosigner: client, audit, network: f.input.requirements.network, fetchImpl: async () => assert.fail('must not send payment') });
    const result = await buyer.pay(5n, f.input.resourceUrl, f.input.requirements);
    assert.deepEqual(result, { status: 'settlement_unknown', authId: 5n, reason: 'cosigner_outcome_unknown' });
    assert.equal(audit.entries.at(-1).event, 'settlement_unknown');
    assert.equal(audit.entries.at(-1).data.authId, '5');
    assert.equal(audit.entries.at(-1).data.error, 'cosigner_outcome_unknown');
    assert.equal(AuditLog.verify(audit.entries).ok, true);
    assert.equal(f.chain.authorization(5n).auth.status, 'Committed');
    assert.equal(f.chain.agent(A.agent).spentTodayNow, 500_000n);
    assert.equal(f.guard.sent.length, 0);
    // Exercise the session retry boundary with this real buyer outcome.
    buyer.buy = async () => result;
    const tools = new PurchaseTools({ agent: buyer, guard: f.guard });
    const args = { url: f.input.resourceUrl, intent: 'offline malformed-response purchase' };
    const pending = await tools.call('buy_resource', args);
    buyer.buy = async () => assert.fail('must not start a second purchase');
    assert.equal(pending.reason, 'settlement_unknown_do_not_retry');
    assert.deepEqual(await tools.call('buy_resource', args), pending);
    assert.deepEqual(await tools.call('purchase_status', { authId: '5' }), pending);
    assert.deepEqual(await tools.call('resume_purchase', { authId: '5' }), pending);
    assert.equal(signingRequests, 1);
  });
}
