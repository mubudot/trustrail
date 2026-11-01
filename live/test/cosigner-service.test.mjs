import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VerificationAuditRecordV1 } from '@concordium/web-sdk/wasm';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { FixtureBadgeResolver } from '../../agent/src/identity/badge.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { createCosignerService } from '../src/cosigner-service.mjs';
import { CosignerClient, CosignerUnavailable } from '../src/cosigner-client.mjs';
import { CosignRefused } from '../src/cosigner-live.mjs';
import { loadBuyerAccounts } from '../src/signers.mjs';
import { loadCosignerConfig } from '../src/cosigner-config.mjs';
import { createLiveWorld } from '../src/world.mjs';
import { LiveAgent } from '../src/live-agent.mjs';
import { verifyDigestWithKey } from '../src/keys.mjs';
import { fromJSON, signingDigest } from '../src/x402-buyer.mjs';
import { paymentFixture, policy, A } from '../attacks/fixtures.mjs';
import { approval } from '../attacks/proof-chain.mjs';

const TOKEN = 'offline-test-bearer-token-at-least-32-characters';
const json = (v) => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x));
const small = () => paymentFixture({ amount: 500_000n, human: false });
const rejection = (reason) => (e) => e instanceof CosignRefused && e.reason === reason;

function serviceConfig(f) {
  return { ...f.cos, network: f.input.requirements.network,
    resolver: new FixtureBadgeResolver({ [f.input.requirements.extra.payeeBadge]: { valid: true, active: true, owner: A.seller } }) };
}

async function serve(t, config) {
  const server = createCosignerService({ config, token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, client: new CosignerClient({ url, token: TOKEN }) };
}
const post = (url, input, token = TOKEN, endpoint = 'cosign') => fetch(`${url}/${endpoint}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(json(input)),
});

test('buyer_configuration_contains_no_cosigner_key', async t => {
  const f = await small();
  const dir = mkdtempSync(path.join(tmpdir(), 'trustrail-buyer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'buyer.json');
  const buyer = { agent: { address: A.agent, keys: { 0: f.keys.agent } }, wallet: { address: A.wallet, keys: { 0: f.keys.agent }, threshold: 2 } };
  const save = (c) => writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  save(buyer);
  assert.deepEqual(Object.keys(loadBuyerAccounts(file)), ['agent', 'wallet']);
  const w = await createLiveWorld({ cosignerUrl: 'http://127.0.0.1:4410', cosignerToken: TOKEN, buyerConfigFile: file, audit: new AuditLog() });
  t.after(w.close);
  assert.ok(w.cosigner instanceof CosignerClient);
  assert.equal(w.agent.walletKey0, f.keys.agent.privateKey);
  assert.deepEqual(Object.keys(w.acc.wallet.keys), ['0']);
  assert.equal(JSON.stringify(w.acc).includes(f.keys.cosigner.privateKey), false);
  assert.equal('cosigner' in w.acc, false);
  assert.equal('owner' in w.acc, false);
  assert.equal('seller' in w, false);
  assert.equal(w.audit.file, null);
  save({ ...buyer, wallet: { ...buyer.wallet, keys: { 0: f.keys.agent, 1: f.keys.cosigner } } });
  assert.throws(() => loadBuyerAccounts(file), /key 0 only/);
  save({ ...buyer, cosigner: { address: A.cosigner, keys: { 0: f.keys.cosigner } } });
  assert.throws(() => loadBuyerAccounts(file), /only agent and wallet/);
  assert.throws(() => loadBuyerAccounts(), /required/);
});

test('service_configuration_is_independent_and_pins_guard_network_owner_agent_threshold_and_resolver', async t => {
  const f = await small();
  const dir = mkdtempSync(path.join(tmpdir(), 'trustrail-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'service.json');
  const c = { network: f.input.requirements.network, guard: { index: '13037', subindex: '0' }, owner: A.owner, agent: A.agent,
    humanProofAbove: '2000000', agentPublicKey: f.keys.agent.publicKey, walletKey: f.keys.cosigner.privateKey,
    account: { address: A.cosigner, keys: { 0: f.keys.cosigner } }, approvalsDir: './approvals' };
  writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  const config = loadCosignerConfig(file);
  assert.equal(config.walletKey, f.keys.cosigner.privateKey);
  assert.equal(config.owner, A.owner);
  assert.equal(config.agentAccount, A.agent);
  assert.equal(config.humanProofAbove, 2_000_000n);
  assert.equal(config.network, f.input.requirements.network);
  assert.deepEqual(config.guard.address, { index: 13037n, subindex: 0n });
  assert.equal(typeof config.resolver.resolve, 'function');
  assert.equal(await config.approvals(5n), null);
  assert.equal('agentKey' in config, false);
  writeFileSync(file, JSON.stringify({ ...c, network: 'ccd:other' }));
  assert.throws(() => loadCosignerConfig(file), /testnet only/);
  assert.throws(() => createCosignerService({ config: { ...serviceConfig(f), humanProofAbove: undefined }, token: TOKEN }), /pinned threshold/);
});

test('service_client_completes_small_and_verified_human_buyer_payments_with_commit_receipts', async t => {
  for (const f of [await small(), await paymentFixture()]) {
    const { client } = await serve(t, serviceConfig(f));
    const send = f.guard.send.bind(f.guard);
    f.guard.send = async (entry, value, options) => {
      if (entry !== 'recordSettlement') return send(entry, value, options);
      f.chain.recordSettlement(options.sender, { id: value.id, txHash: value.tx_hash });
      return { txHash: 'd1'.repeat(32) };
    };
    let paid = false;
    const buyer = new LiveAgent({ grpc: f.guard.grpc, guard: f.guard, agent: { address: A.agent }, walletKey0: f.keys.agent.privateKey,
      cosigner: client, audit: new AuditLog(), network: f.input.requirements.network, fetchImpl: async (url, options) => {
        assert.equal(url, f.input.resourceUrl);
        const payment = decodePaymentSignatureHeader(options.headers['PAYMENT-SIGNATURE']);
        const tx = payment.payload.signedTransaction;
        const digest = signingDigest(fromJSON(tx));
        assert.deepEqual(payment.accepted, f.input.requirements);
        assert.equal(f.chain.authorization(5n).auth.commitment, digest);
        assert.ok(verifyDigestWithKey(f.keys.agent.publicKey, digest, tx.signatures.sender[0][0]));
        assert.ok(verifyDigestWithKey(f.keys.cosigner.publicKey, digest, tx.signatures.sender[0][1]));
        paid = true;
        return new Response(JSON.stringify({ demo: true, purchased: 'fixture content' }), { headers: {
          'payment-response': encodePaymentResponseHeader({ success: true, transaction: '51'.repeat(32), network: f.input.requirements.network, payer: A.wallet }),
        } });
      } });
    assert.equal('walletKey' in buyer, false);
    const result = await buyer.pay(5n, f.input.resourceUrl, f.input.requirements);
    assert.equal(paid, true);
    assert.equal(result.status, 'paid');
    assert.equal(result.commitTx, 'c0'.repeat(32));
    assert.equal(result.recordTx, 'd1'.repeat(32));
    assert.equal(result.data.purchased, 'fixture content');
    assert.equal(client.lastCommitTx, 'c0'.repeat(32));
    assert.equal(f.chain.authorization(f.input.authId).auth.status, 'Settled');
    assert.equal(f.guard.sent.length, 1);
    assert.equal(f.guard.sent[0].entry, 'commitPayment');
  }
});

test('caller_cannot_override_pinned_threshold_or_owner', async t => {
  const f = await paymentFixture({ human: false, registeredPolicy: { ...policy, approvalThreshold: 10_000_000n } });
  const { url, client } = await serve(t, serviceConfig(f));
  for (const patch of [{ humanProofAbove: '99999999' }, { owner: A.agent }, { guard: { index: '1' } },
    { network: 'ccd:other' }, { resolver: {} }, { approvals: { record: 'forged' } }, { config: { owner: A.agent, humanProofAbove: '99999999' } }]) {
    const response = await post(url, { ...f.input, ...patch });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).reason, 'invalid_arguments');
  }
  await assert.rejects(client.cosign(f.input), rejection('human_approval_missing_pinned_threshold'));
  assert.equal(f.guard.sent.length, 0);
});

test('service_refuses_forged_approval_before_signing', async t => {
  const record = structuredClone(approval.record);
  const proof = record.presentation.verifiableCredential[0].proof;
  proof.proofValue = proof.proofValue.slice(0, -1) + (proof.proofValue.endsWith('0') ? '1' : '0');
  const anchorHash = Buffer.from(VerificationAuditRecordV1.computeAnchorHash(VerificationAuditRecordV1.fromJSON(record))).toString('hex');
  const f = await paymentFixture({ humanProof: anchorHash, approvalRecord: { ...approval, record } });
  const { client } = await serve(t, serviceConfig(f));
  await assert.rejects(client.cosign(f.input), rejection('approval_proof_invalid'));
  assert.equal(f.guard.sent.length, 0);
  assert.equal(f.chain.authorization(5n).auth.commitment, null);
  assert.equal(await client.release(5n), true);
  assert.equal(client.lastCancelTx, 'c0'.repeat(32));
  assert.equal(f.chain.authorization(5n).auth.status, 'Cancelled');
});

test('unauthenticated_request_is_refused_before_guard_or_signing', async t => {
  const f = await small();
  const { url } = await serve(t, serviceConfig(f));
  const raw = await fetch(`${url}/cosign`, { method: 'POST', body: '{not even json' });
  assert.equal(raw.status, 401);
  assert.equal((await raw.json()).reason, 'unauthenticated');
  const badClient = new CosignerClient({ url, token: 'wrong-token-that-is-long-enough-for-client' });
  await assert.rejects(badClient.cosign(f.input), rejection('unauthenticated'));
  assert.equal(f.guard.sent.length, 0);
});

test('replica_concurrent_race_releases_only_one_signature', async t => {
  const f = await small();
  const send = f.guard.send.bind(f.guard);
  let arrivals = 0, both;
  const barrier = new Promise(resolve => { both = resolve; });
  f.guard.send = async (...args) => {
    if (args[0] === 'commitPayment') { if (++arrivals === 2) both(); await barrier; }
    return send(...args); // shared mock guard performs the atomic transition, not a service lock
  };
  const first = await serve(t, serviceConfig(f));
  const second = await serve(t, serviceConfig(f));
  const results = await Promise.allSettled([first.client.cosignWithReceipt(f.input), second.client.cosignWithReceipt(f.input)]);
  assert.equal(arrivals, 2);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.reason, 'commit_WrongStatus');
  const out = results.find(r => r.status === 'fulfilled').value;
  assert.ok(verifyDigestWithKey(f.keys.cosigner.publicKey, out.digest, out.signature));
  assert.equal(out.commitTx, 'c0'.repeat(32));
  assert.equal(f.guard.sent.length, 1);
  assert.equal(f.chain.agent(A.agent).spentTodayNow, 500_000n);
});

test('cancel_receipt_is_returned_in_response_and_not_reused_when_cancel_fails', async t => {
  const f = await small();
  const { client } = await serve(t, serviceConfig(f));
  const out = await client.releaseWithReceipt(5n);
  assert.deepEqual(out, { released: true, cancelTx: 'c0'.repeat(32) });
  const second = f.chain.authorize(A.agent, f.request);
  assert.equal(await client.release(second.id), true);
  assert.equal(client.lastCancelTx, 'c0'.repeat(32));
  assert.equal(await client.release(second.id), false);
  assert.equal(client.lastCancelTx, null);
});

test('service_cannot_cancel_an_authorization_for_a_different_agent', async t => {
  const f = await small();
  f.chain.registerAgent(A.owner, { ...f.registration, agent: 'other-agent-control' });
  const other = f.chain.authorize('other-agent-control', f.request);
  const { client } = await serve(t, serviceConfig(f));
  await assert.rejects(client.releaseWithReceipt(other.id), rejection('authorization_for_other_agent'));
  assert.equal(f.chain.authorization(other.id).auth.status, 'Approved');
  assert.equal(f.guard.sent.length, 0);
});

test('service_pins_network_and_rechecks_its_own_badge_resolver', async t => {
  const f = await small();
  const config = serviceConfig(f);
  const { client } = await serve(t, config);
  await assert.rejects(client.cosign({ ...f.input, requirements: { ...f.input.requirements, network: 'ccd:other' } }), rejection('network_mismatch'));
  config.resolver.entries[f.input.requirements.extra.payeeBadge].active = false;
  await assert.rejects(client.cosign(f.input), rejection('payee_badge_revoked'));
  assert.equal(f.guard.sent.length, 0);
});

test('buyer_keeps_unknown_remote_commit_booked_and_never_cancels_or_sends_payment', async () => {
  const f = await small();
  const client = new CosignerClient({ url: 'http://127.0.0.1:4410', token: TOKEN, fetchImpl: async () => {
    f.chain.commitPayment(A.cosigner, { id: 5n, digest: signingDigest(fromJSON(f.input.signableJSON)) });
    throw new Error('response lost after commit');
  } });
  const audit = new AuditLog();
  const buyer = new LiveAgent({ grpc: f.guard.grpc, guard: f.guard, agent: { address: A.agent }, walletKey0: f.keys.agent.privateKey,
    cosigner: client, audit, network: f.input.requirements.network, fetchImpl: async () => assert.fail('must not send payment') });
  const result = await buyer.pay(5n, f.input.resourceUrl, f.input.requirements);
  assert.deepEqual(result, { status: 'settlement_unknown', authId: 5n, reason: 'cosigner_outcome_unknown' });
  assert.equal(audit.entries.at(-1).event, 'settlement_unknown');
  assert.equal(f.chain.authorization(5n).auth.status, 'Committed');
  assert.equal(f.chain.agent(A.agent).spentTodayNow, 500_000n);
  assert.equal(f.guard.sent.length, 0); // no cancellation; commit above simulates a lost remote response
});

test('client_rejects_insecure_urls_weak_tokens_and_malformed_success_responses', async () => {
  assert.throws(() => new CosignerClient({ url: 'http://service.example', token: TOKEN }), /HTTPS/);
  assert.throws(() => new CosignerClient({ url: 'http://127.0.0.1:4410', token: 'short' }), /32 characters/);
  const f = await small();
  const client = new CosignerClient({ url: 'http://127.0.0.1:4410', token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ authId: '5', status: 'signed', signature: 'not a signature' })) });
  await assert.rejects(client.cosign(f.input), CosignerUnavailable);
  assert.equal(client.lastCommitTx, null);
});
