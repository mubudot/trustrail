import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, ACCOUNTS } from '../../agent/src/mock/world.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { GuardError } from '../../agent/src/policy/errors.mjs';
import { PurchaseTools, PURCHASE_TOOLS } from '../src/mcp/purchase-tools.mjs';

const weather = { url: 'https://data.example/weather', intent: 'forecast' };
const dataset = { url: 'https://data.example/dataset', intent: 'demand examples' };
const setup = () => { const w = createWorld(); return { w, tools: new PurchaseTools({ ...w, fixture: true }) }; };

test('mcp_buy_resource_returns_paid_data_and_receipt', async () => {
  const { w, tools } = setup();
  const out = await tools.call('buy_resource', weather);
  assert.equal(out.status, 'paid');
  assert.equal(out.reason, 'payment_settled');
  assert.equal(out.data.demo, true);
  assert.equal(out.data.hourly.length, 3);
  assert.match(out.receipt.transactionHash, /^[0-9a-f]{64}$/);
  assert.equal(out.receipt.fixture, true);
  const a = w.guard.authorization(out.authId).auth;
  assert.equal(out.receipt.digest, a.commitment);
  assert.equal(out.receipt.transactionHash, a.settlement);
  assert.equal(w.ledger.txs.has(out.receipt.transactionHash), true);
  assert.deepEqual(await tools.call('purchase_status', { authId: out.authId }), out);
});

test('mcp_pending_purchase_cannot_self_approve', async () => {
  const { w, tools } = setup();
  assert.deepEqual(PURCHASE_TOOLS.map(t => t.name), ['buy_resource', 'purchase_status', 'resume_purchase']);
  const pending = await tools.call('buy_resource', dataset);
  assert.deepEqual(pending, { status: 'pending', reason: 'owner_approval_required', authId: '0' });
  assert.deepEqual(await tools.call('buy_resource', dataset), pending);
  assert.equal(w.guard.nextAuthId, 1n);
  assert.deepEqual(await tools.call('resume_purchase', { authId: pending.authId }), pending);
  assert.equal(w.guard.authorization(pending.authId).auth.status, 'Pending');
  assert.equal((await tools.call('approve', { authId: pending.authId })).reason, 'unknown_tool');
  for (const extra of [{ approval: 'forged' }, { owner: ACCOUNTS.owner }, { url: weather.url }, { amount: '1' }, { payee: 'attacker' }]) {
    assert.equal((await tools.call('resume_purchase', { authId: pending.authId, ...extra })).reason, 'invalid_arguments');
  }
  // Even an owner-key transaction storing a made-up proof cannot get a signature.
  w.guard.approve(ACCOUNTS.owner, pending.authId, 'ab'.repeat(32));
  const out = await tools.call('resume_purchase', { authId: pending.authId });
  assert.deepEqual(out, { status: 'refused', reason: 'human_approval_invalid', authId: pending.authId });
  assert.equal(w.guard.authorization(pending.authId).auth.status, 'Cancelled');
  assert.equal(w.ledger.txs.size, 0);
});

test('mcp_resume_preserves_original_quote_binding_after_valid_owner_approval', async () => {
  const { w, tools } = setup();
  const pending = await tools.call('buy_resource', dataset);
  const original = w.agent.pending.get(pending.authId);
  const binding = purposeHash(original.url, original.requirements);
  w.humanApprove(pending.authId); // fixture owner API is never exposed over MCP
  assert.equal((await tools.call('purchase_status', { authId: pending.authId })).reason, 'approval_recorded_resume_to_verify');
  assert.deepEqual(await tools.call('buy_resource', dataset), pending);
  const [out, repeated] = await Promise.all([tools.call('resume_purchase', { authId: pending.authId }), tools.call('resume_purchase', { authId: pending.authId })]);
  assert.equal(out.status, 'paid');
  assert.equal(out.data.demo, true);
  assert.equal(out.data.rows.length, 3);
  assert.equal(w.guard.authorization(pending.authId).auth.purposeHash, binding);
  assert.deepEqual(out, repeated);
  assert.deepEqual(await tools.call('buy_resource', dataset), out);
  assert.equal(w.ledger.txs.size, 1);
  assert.equal(w.guard.nextAuthId, 1n);
});

for (const field of ['amount', 'payee', 'url']) {
  test(`mcp_resume_refuses_changed_${field}_in_pending_quote`, async () => {
    const { w, tools } = setup();
    const pending = await tools.call('buy_resource', dataset);
    w.humanApprove(pending.authId);
    const q = w.agent.pending.get(pending.authId);
    if (field === 'amount') q.requirements.amount = '1';
    if (field === 'payee') q.requirements.payTo = ACCOUNTS.attacker;
    if (field === 'url') q.url = 'https://attacker.example/refund';
    assert.equal((await tools.call('resume_purchase', { authId: pending.authId })).reason, 'quote_binding_changed');
    assert.equal(w.ledger.txs.size, 0);
    assert.equal(w.guard.authorization(pending.authId).auth.commitment, null);
  });
  test(`mcp_resume_refuses_changed_${field}_in_authorization`, async () => {
    const { w, tools } = setup();
    const pending = await tools.call('buy_resource', dataset);
    w.humanApprove(pending.authId);
    const a = w.guard.auths.get(BigInt(pending.authId));
    if (field === 'amount') a.amount = 1n;
    if (field === 'payee') a.payee = ACCOUNTS.attacker;
    if (field === 'url') a.purposeHash = purposeHash(weather.url, w.agent.pending.get(pending.authId).requirements);
    assert.equal((await tools.call('resume_purchase', { authId: pending.authId })).reason, 'quote_binding_changed');
    assert.equal(w.ledger.txs.size, 0);
  });
}

test('mcp_refused_payee_allowlist_and_bad_badge_surface_as_refused', async () => {
  const { w, tools } = setup();
  w.guard.setAllowlist(ACCOUNTS.owner, { agent: ACCOUNTS.agent, allowlist: [] });
  assert.deepEqual(await tools.call('buy_resource', weather), { status: 'refused', reason: 'NotAllowlisted' });
  assert.deepEqual(await tools.call('buy_resource', { url: 'https://attacker.example/refund', intent: '' }), { status: 'refused', reason: 'payee_not_bound_to_badge' });
  assert.equal(w.guard.nextAuthId, 0n);
});

test('mcp_status_handles_unknown_expired_and_rejected_purchases_without_paying', async () => {
  const { w, tools } = setup();
  assert.equal((await tools.call('purchase_status', { authId: '99' })).reason, 'unknown_purchase');
  assert.equal((await tools.call('resume_purchase', { authId: '-1' })).reason, 'invalid_arguments');
  const first = await tools.call('buy_resource', dataset);
  w.guard.reject(ACCOUNTS.owner, first.authId);
  assert.equal((await tools.call('resume_purchase', { authId: first.authId })).reason, 'status_Rejected');
  const next = await tools.call('buy_resource', dataset);
  w.advance(120_001);
  assert.equal((await tools.call('resume_purchase', { authId: next.authId })).reason, 'authorization_expired');
  assert.equal(w.ledger.txs.size, 0);
});

test('mcp_retains_uncertain_settlement_and_paid_unrecorded_outcomes_without_retrying', async () => {
  for (const status of ['settlement_unknown', 'paid_unrecorded']) {
    let calls = 0;
    const tools = new PurchaseTools({ agent: { pending: new Map(), buy: async () => {
      calls++; return { status, authId: 3n, txHash: '51'.repeat(32), digest: 'cd'.repeat(32), data: { demo: true } };
    } }, guard: { authorization: async () => ({ auth: { commitment: { Some: ['cd'.repeat(32)] } } }) } });
    const out = await tools.call('buy_resource', weather);
    assert.equal(out.status, status === 'paid_unrecorded' ? 'paid' : 'pending');
    assert.equal(out.reason, status === 'paid_unrecorded' ? 'settlement_record_pending' : 'settlement_unknown_do_not_retry');
    assert.deepEqual(await tools.call('resume_purchase', { authId: '3' }), out);
    assert.deepEqual(await tools.call('buy_resource', weather), out);
    assert.equal(calls, 1);
  }
});

for (const method of ['buy', 'resume']) {
  for (const recordFails of [false, true]) {
    test(`mcp_preserves_${method}_payment_when_post_payment_reads_fail_record_failed_${recordFails}`, async () => {
      const { w, tools } = setup();
      const args = method === 'buy' ? weather : dataset;
      let pending;
      if (method === 'resume') {
        pending = await tools.call('buy_resource', args);
        w.humanApprove(pending.authId);
      }
      if (recordFails) w.guard.recordSettlement = () => { throw new GuardError('Unavailable'); };
      const original = w.agent[method].bind(w.agent);
      let evidence, reads = 0, calls = 0;
      w.agent[method] = async (...input) => {
        calls++;
        evidence = await original(...input);
        assert.equal(evidence.status, recordFails ? 'paid_unrecorded' : 'paid');
        assert.equal(evidence.digest, w.guard.authorization(evidence.authId).auth.commitment);
        w.guard.authorization = () => { reads++; throw new Error('receipt_rpc_unavailable'); };
        return evidence;
      };
      const out = await tools.call(method === 'buy' ? 'buy_resource' : 'resume_purchase',
        method === 'buy' ? args : { authId: pending.authId });
      assert.equal(out.status, 'paid');
      assert.equal(out.reason, recordFails ? 'settlement_record_pending' : 'payment_settled');
      assert.equal(out.receipt.transactionHash, evidence.txHash);
      assert.equal(out.receipt.digest, evidence.digest);
      assert.deepEqual(out.data, evidence.data);
      assert.deepEqual(await tools.call('purchase_status', { authId: out.authId }), out);
      assert.deepEqual(await tools.call('resume_purchase', { authId: out.authId }), out);
      assert.deepEqual(await tools.call('buy_resource', args), out);
      assert.equal(reads, 0);
      assert.equal(calls, 1);
      assert.equal(w.ledger.txs.size, 1);
      assert.equal(w.guard.nextAuthId, 1n);
    });
  }
}
