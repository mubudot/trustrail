// Real LiveAgent + LiveCosigner + x402 codecs/signatures; fake guard, nonce source, badge and seller.
// Generated wallet keys stay in memory. No sockets, secrets, facilitator or testnet transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { LiveAgent } from '../src/live-agent.mjs';
import { LiveCosigner } from '../src/cosigner-live.mjs';
import { fromJSON, signingDigest } from '../src/x402-buyer.mjs';
import { verifyDigestWithKey } from '../src/keys.mjs';
import { enumTag, unOpt } from '../src/guard-client.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { FixtureBadgeResolver } from '../../agent/src/identity/badge.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { dayOf } from '../../agent/src/policy/engine.mjs';
import { A, FakeGuard, auth, record, fakeGrpc, requirements, walletKeys } from './helpers.mjs';

const URL_ = 'https://seller.example/weather';
const TX = { authorize: 'a1'.repeat(32), commitPayment: 'c1'.repeat(32), settlement: '51'.repeat(32), recordSettlement: 'd1'.repeat(32), cancel: 'ca'.repeat(32) };
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function setup({ settlement = 'success', recordFails = false, refuse = false } = {}) {
  const keys = walletKeys();
  const req = requirements('500000');
  const audit = new AuditLog();
  const actor = { address: A.agent, signer: { role: 'agent test signer' } };
  const cosignerAccount = { address: A.cosigner, signer: { role: 'co-signer test signer' } };
  const guard = new FakeGuard({ auth: null, record: record({ day: dayOf(Date.now()) }) });
  guard.grpc = fakeGrpc;
  guard.send = async (entry, value, options) => {
    guard.sent.push({ entry, value, options });
    assert.equal(options.sender, ['commitPayment', 'cancel'].includes(entry) ? A.cosigner : A.agent);
    assert.equal(options.signer, ['commitPayment', 'cancel'].includes(entry) ? cosignerAccount.signer : actor.signer);
    if (entry === 'authorize') {
      guard._auth = auth({ ...value, human_proof: { None: [] } });
      guard._record.spent_today += value.amount;
      const event = Buffer.alloc(9); event[0] = 7; event.writeBigUInt64LE(0n, 1);
      return { txHash: TX.authorize, summary: { events: [{ address: guard.address, events: [event.toString('hex')] }] } };
    }
    if (entry === 'commitPayment') {
      assert.equal(enumTag(guard._auth.status), 'Approved');
      guard._auth.status = { Committed: [] };
      guard._auth.commitment = { Some: [value.digest] };
    } else if (entry === 'recordSettlement') {
      assert.equal(value.tx_hash, TX.settlement);
      assert.equal(audit.entries.at(-1).event, 'paid'); // evidence must precede the fallible guard write
      assert.equal(audit.entries.at(-1).data.txHash, TX.settlement);
      if (recordFails) throw new Error('record_unavailable');
      guard._auth.status = { Settled: [] };
      guard._auth.settlement = { Some: [value.tx_hash] };
    } else if (entry === 'cancel') {
      if (enumTag(guard._auth.status) !== 'Approved') throw new Error('cannot_cancel_committed');
      guard._record.spent_today -= guard._auth.amount;
      guard._auth.status = { Cancelled: [] };
    } else assert.fail(`unexpected guard write ${entry}`);
    return { txHash: TX[entry] };
  };
  const resolver = new FixtureBadgeResolver({ [req.extra.payeeBadge]: { valid: true, active: true, owner: A.seller } });
  const cosigner = new LiveCosigner({ guard, account: cosignerAccount, walletKey: keys.cosigner.privateKey,
    agentPublicKey: keys.agent.publicKey, agentAccount: A.agent, owner: A.owner, resolver, approvals: async () => null });
  const cosignCalls = [];
  const cosign = cosigner.cosign.bind(cosigner);
  cosigner.cosign = async (args) => {
    cosignCalls.push(args);
    const json = args.signableJSON;
    assert.deepEqual(Object.keys(json.signatures.sender[0]), ['0']); // key 0 is present before key 1 is requested
    assert.ok(verifyDigestWithKey(keys.agent.publicKey, signingDigest(fromJSON(json)), json.signatures.sender[0][0]));
    if (refuse) guard._paused = true; // a real co-signer refusal, after the buyer's preflight
    return cosign(args);
  };
  const sellerPayments = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, URL_);
    if (!options) return response(402, {}, { 'payment-required': encodePaymentRequiredHeader({ x402Version: 2, resource: { url, mimeType: 'application/json' }, accepts: [req] }) });
    const payment = decodePaymentSignatureHeader(options.headers['PAYMENT-SIGNATURE']);
    const json = payment.payload.signedTransaction;
    const digest = signingDigest(fromJSON(json));
    assert.deepEqual(payment.accepted, req);
    assert.equal(payment.x402Version, 2);
    assert.deepEqual(Object.keys(json.signatures.sender[0]).sort(), ['0', '1']);
    assert.equal(digest, unOpt(guard._auth.commitment));
    assert.ok(verifyDigestWithKey(keys.agent.publicKey, digest, json.signatures.sender[0][0]));
    assert.ok(verifyDigestWithKey(keys.cosigner.publicKey, digest, json.signatures.sender[0][1]));
    sellerPayments.push(payment);
    if (settlement === 'lost') throw new Error('settlement_response_lost');
    const success = settlement === 'success';
    return response(success ? 200 : 502, success ? { weather: 'fixture' } : { error: 'facilitator_failed' }, {
      'payment-response': encodePaymentResponseHeader({ success, transaction: TX.settlement, network: req.network, payer: A.wallet,
        ...(success ? {} : { errorReason: 'facilitator_unavailable' }) }),
    });
  };
  const makeAgent = () => new LiveAgent({ grpc: fakeGrpc, guard, agent: actor, walletKey0: keys.agent.privateKey,
    cosigner, resolver, audit, network: req.network, fetchImpl });
  return { agent: makeAgent(), makeAgent, req, audit, guard, cosigner, cosignCalls, sellerPayments };
}

test('LiveAgent.buy signs key 0 before co-signing, carries the bound payment to the seller and records settlement', async () => {
  const f = setup();
  const result = await f.agent.buy(URL_, { intent: 'weather fixture' });
  assert.deepEqual(result, { status: 'paid', authId: 0n, txHash: TX.settlement, recordTx: TX.recordSettlement,
    digest: unOpt(f.guard._auth.commitment), commitTx: TX.commitPayment, data: { weather: 'fixture' } });
  assert.equal(f.sellerPayments.length, 1);
  const json = f.sellerPayments[0].payload.signedTransaction;
  assert.equal(json.header.sender, A.wallet);
  assert.equal(json.header.sponsor.account, A.facilitator);
  assert.equal(json.header.numSignatures, 2);
  assert.deepEqual(json.payload, { type: 'transfer', toAddress: A.seller, amount: '500000' });
  assert.equal(f.cosignCalls[0].resourceUrl, URL_);
  assert.deepEqual(f.cosignCalls[0].requirements, f.req);
  assert.equal(f.guard.sent[0].value.purpose_hash, purposeHash(URL_, f.req));
  assert.deepEqual(f.guard.sent.map((s) => s.entry), ['authorize', 'commitPayment', 'recordSettlement']);
  assert.deepEqual(f.guard.sent[2].value, { id: 0n, tx_hash: TX.settlement });
  assert.deepEqual(f.audit.entries.map((e) => e.event), ['request', 'quote', 'authorized', 'cosigned', 'paid', 'settled']);
  const [request, quote, authorized, cosigned, paid, settled] = f.audit.entries;
  assert.ok(request.data.request);
  assert.equal(quote.data.request, request.data.request);
  assert.equal(authorized.data.request, request.data.request);
  assert.equal(authorized.data.txHash, TX.authorize);
  assert.equal(cosigned.data.commitTx, TX.commitPayment);
  assert.equal(paid.data.txHash, TX.settlement);
  assert.equal(settled.data.recordTx, TX.recordSettlement);
  assert.equal(unOpt(f.guard._auth.settlement), TX.settlement);
  assert.equal(AuditLog.verify(f.audit.entries).ok, true);
});

for (const settlement of ['lost', 'facilitator_error']) {
  test(`LiveAgent.buy retains settlement_unknown evidence after ${settlement}; same-authorisation retries never pay twice`, async () => {
    const f = setup({ settlement });
    const result = await f.agent.buy(URL_);
    assert.equal(result.status, 'settlement_unknown');
    assert.equal(result.authId, 0n);
    assert.deepEqual(f.audit.entries.map((e) => e.event), ['request', 'quote', 'authorized', 'cosigned', 'settlement_unknown']);
    const evidence = f.audit.entries.at(-1);
    assert.equal(evidence.data.authId, '0');
    assert.equal(f.audit.entries.at(-2).data.commitTx, TX.commitPayment);
    if (settlement === 'lost') assert.equal(evidence.data.error, 'settlement_response_lost');
    else {
      assert.equal(result.txHash, TX.settlement);
      assert.equal(evidence.data.txHash, TX.settlement);
      assert.equal(evidence.data.httpStatus, 502);
      assert.equal(evidence.data.error, 'facilitator_unavailable');
    }
    const commitment = unOpt(f.guard._auth.commitment);
    // pay() retries the SAME authorisation. A new buy() is a new purchase, not an idempotent retry.
    for (const retryAgent of [f.agent, f.makeAgent()]) {
      const retry = await retryAgent.pay(result.authId, URL_, f.req);
      assert.equal(retry.status, 'refused');
      assert.equal(retry.reason, 'status_Committed');
      assert.equal(retry.released, false);
    }
    assert.equal(f.sellerPayments.length, 1);
    assert.equal(f.guard.sent.filter((s) => s.entry === 'commitPayment').length, 1);
    assert.equal(f.guard.sent.filter((s) => s.entry === 'recordSettlement').length, 0);
    assert.equal(enumTag(f.guard._auth.status), 'Committed');
    assert.equal(unOpt(f.guard._auth.commitment), commitment);
    assert.equal(f.guard._record.spent_today, 500_000n);
    assert.equal(f.audit.entries.find((e) => e.event === 'settlement_unknown'), evidence);
    assert.equal(AuditLog.verify(f.audit.entries).ok, true);
  });
}

test('LiveAgent.buy returns paid_unrecorded with settlement evidence when recordSettlement fails', async () => {
  const f = setup({ recordFails: true });
  const result = await f.agent.buy(URL_);
  assert.deepEqual(result, { status: 'paid_unrecorded', authId: 0n, txHash: TX.settlement,
    digest: unOpt(f.guard._auth.commitment), commitTx: TX.commitPayment, data: { weather: 'fixture' } });
  assert.deepEqual(f.audit.entries.map((e) => e.event), ['request', 'quote', 'authorized', 'cosigned', 'paid', 'settlement_record_failed']);
  assert.equal(f.audit.entries.at(-2).data.txHash, TX.settlement);
  assert.deepEqual(f.audit.entries.at(-1).data, { authId: '0', txHash: TX.settlement, error: 'record_unavailable' });
  assert.equal(enumTag(f.guard._auth.status), 'Committed');
  assert.equal(f.guard._record.spent_today, 500_000n);
  const retry = await f.makeAgent().pay(result.authId, URL_, f.req);
  assert.equal(retry.reason, 'status_Committed');
  assert.equal(f.sellerPayments.length, 1);
  assert.equal(AuditLog.verify(f.audit.entries).ok, true);
});

test('LiveAgent.buy cancels the authorisation and releases budget after a co-signer refusal', async () => {
  const f = setup({ refuse: true });
  const result = await f.agent.buy(URL_);
  assert.deepEqual(result, { status: 'refused', stage: 'cosigner', reason: 'guard_paused', authId: 0n, released: true, cancelTx: TX.cancel });
  assert.deepEqual(f.guard.sent.map((s) => s.entry), ['authorize', 'cancel']);
  assert.equal(f.sellerPayments.length, 0);
  assert.equal(enumTag(f.guard._auth.status), 'Cancelled');
  assert.equal(unOpt(f.guard._auth.commitment), null);
  assert.equal(f.guard._record.spent_today, 0n);
  assert.deepEqual(f.audit.entries.map((e) => e.event), ['request', 'quote', 'authorized', 'refused']);
  assert.equal(f.audit.entries.at(-1).data.cancelTx, TX.cancel);
  assert.equal(AuditLog.verify(f.audit.entries).ok, true);
});
