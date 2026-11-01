import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SequenceNumber } from '@concordium/web-sdk';
import { createCosignerService } from '../src/cosigner-service.mjs';
import { CosignerClient, CosignerUnavailable } from '../src/cosigner-client.mjs';
import { CosignRefused } from '../src/cosigner-live.mjs';
import { FixtureBadgeResolver } from '../../agent/src/identity/badge.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { paymentFixture, A } from '../attacks/fixtures.mjs';

const TOKEN = 'offline-nonce-test-token-at-least-32-characters';
const refused = (e) => e instanceof CosignRefused && e.reason === 'wallet_nonce_in_use';
const small = () => paymentFixture({ amount: 500_000n, human: false });
const config = (f, file) => ({ ...f.cos, network: f.input.requirements.network, nonceStateFile: file,
  resolver: new FixtureBadgeResolver({ [f.input.requirements.extra.payeeBadge]: { valid: true, active: true, owner: A.seller } }) });

function journal(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trustrail-nonces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nonces.json');
}
const saved = (file) => JSON.parse(readFileSync(file, 'utf8')).reservations;

async function serve(t, f, file) {
  const server = createCosignerService({ config: config(f, file), token: TOKEN });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, client: new CosignerClient({ url, token: TOKEN }) };
}

async function another(f) {
  const requirements = { ...f.input.requirements, amount: '600000' };
  const { id } = f.chain.authorize(A.agent, { ...f.request, amount: 600_000n,
    purposeHash: purposeHash(f.input.resourceUrl, requirements) });
  return { ...f.input, authId: id, requirements, signableJSON: await f.transaction({ amount: '600000' }) };
}

for (const concurrent of [false, true]) {
  test(`service_refuses_different_authorizations_sharing_a_nonce_concurrent_${concurrent}`, async t => {
    const f = await small();
    const other = await another(f);
    const { client } = await serve(t, f);
    if (concurrent) {
      const out = await Promise.allSettled([client.cosign(f.input), client.cosign(other)]);
      assert.equal(out.filter(r => r.status === 'fulfilled').length, 1);
      assert.ok(refused(out.find(r => r.status === 'rejected').reason));
    } else {
      await client.cosign(f.input);
      await assert.rejects(client.cosign(other), refused);
    }
    const auths = [f.input.authId, other.authId].map(id => f.chain.authorization(id).auth);
    assert.equal(auths.filter(a => a.status === 'Committed').length, 1);
    assert.equal(auths.filter(a => a.status === 'Approved' && a.commitment === null).length, 1);
    assert.deepEqual(f.guard.sent.map(s => s.entry), ['commitPayment']);
  });
}

test('service_releases_a_reservation_after_guard_settlement', async t => {
  const f = await small();
  const file = journal(t);
  const { client } = await serve(t, f, file);
  const other = await another(f);
  await client.cosign(f.input);
  await assert.rejects(client.cosign(other), refused);
  f.chain.recordSettlement(A.agent, { id: f.input.authId, txHash: '51'.repeat(32) });
  // Keep the fake node's nonce view unchanged to exercise guard-based cleanup independently.
  await client.cosign(other);
  assert.deepEqual(saved(file).map(r => r.authId), [String(other.authId)]);
  assert.equal(f.guard.sent.filter(s => s.entry === 'commitPayment').length, 2);
});

test('service_reconciles_an_unrecorded_payment_when_the_wallet_nonce_advances', async t => {
  const f = await small();
  const file = journal(t);
  const { client } = await serve(t, f, file);
  await client.cosign(f.input);
  f.guard.grpc.getNextAccountNonce = async () => ({ nonce: SequenceNumber.create(8n) });
  const other = await another(f);
  await client.cosign(other);
  assert.equal(f.chain.authorization(f.input.authId).auth.status, 'Committed');
  assert.deepEqual(saved(file).map(r => [r.authId, r.nonce]), [[String(other.authId), '8']]);
});

test('service_clears_a_precommit_reservation_only_after_cancellation', async t => {
  const f = await small();
  const file = journal(t);
  const { client } = await serve(t, f, file);
  const send = f.guard.send.bind(f.guard);
  f.guard.send = async (entry, ...args) => {
    if (entry === 'commitPayment') throw new Error('commit_response_lost');
    return send(entry, ...args);
  };
  await assert.rejects(client.cosign(f.input), e => e instanceof CosignRefused && e.reason === 'commit_failed');
  const other = await another(f);
  await assert.rejects(client.cosign(other), refused);
  assert.equal(saved(file).length, 1);
  assert.equal(await client.release(f.input.authId), true);
  assert.equal(saved(file).length, 0);
  f.guard.send = send;
  await client.cosign(other);
  assert.equal(f.chain.authorization(other.authId).auth.status, 'Committed');
});

test('service_keeps_public_reservations_across_lost_responses_and_restart', async t => {
  const f = await small();
  const file = journal(t);
  const first = await serve(t, f, file);
  const transport = first.client.fetchImpl;
  first.client.fetchImpl = async (...args) => { await fetch(...args); throw new Error('response_lost'); };
  await assert.rejects(first.client.cosign(f.input), CosignerUnavailable);
  first.client.fetchImpl = transport;
  assert.equal(f.chain.authorization(f.input.authId).auth.status, 'Committed');
  assert.deepEqual(Object.keys(saved(file)[0]).sort(), ['authId', 'digest', 'nonce', 'wallet']);
  const other = await another(f);
  await assert.rejects(first.client.cosign(other), refused);
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const restarted = await serve(t, f, file);
  await assert.rejects(restarted.client.cosign(other), refused);
  await assert.rejects(restarted.client.cosign(f.input), e => e instanceof CosignRefused && e.reason === 'status_Committed');
  assert.equal(await restarted.client.release(f.input.authId), false);
  assert.equal(saved(file).length, 1);
  assert.equal(f.guard.sent.filter(s => s.entry === 'commitPayment').length, 1);
});

test('service_never_commits_when_the_reservation_journal_cannot_be_saved', async t => {
  const f = await small();
  const file = journal(t);
  const { client } = await serve(t, f, file);
  mkdirSync(file); // Atomically replacing this directory with the journal file must fail.
  await assert.rejects(client.cosign(f.input), CosignerUnavailable);
  assert.equal(f.chain.authorization(f.input.authId).auth.status, 'Approved');
  assert.equal(f.guard.sent.length, 0);
});

test('service_retains_a_reservation_when_reconciliation_reads_fail', async t => {
  const f = await small();
  const file = journal(t);
  const { client } = await serve(t, f, file);
  await client.cosign(f.input);
  const other = await another(f);
  const authorization = f.guard.authorization.bind(f.guard);
  f.guard.authorization = async id => {
    if (BigInt(id) === f.input.authId) throw new Error('guard_read_unavailable');
    return authorization(id);
  };
  await assert.rejects(client.cosign(other), CosignerUnavailable);
  assert.equal(saved(file).length, 1);
  assert.equal(f.chain.authorization(other.authId).auth.commitment, null);
  f.guard.authorization = authorization;
  await assert.rejects(client.cosign(other), refused);
  assert.equal(f.guard.sent.length, 1);
});

test('service_fails_closed_on_corrupt_or_differently_scoped_nonce_journals', async t => {
  const f = await small();
  const file = journal(t);
  for (const contents of ['null', '{', JSON.stringify({ version: 1, scope: 'other-guard', reservations: [] })]) {
    writeFileSync(file, contents);
    assert.throws(() => createCosignerService({ config: config(f, file), token: TOKEN }), /invalid_wallet_nonce_journal/);
  }
  assert.equal(f.guard.sent.length, 0);
});
