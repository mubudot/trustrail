import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeOutcome, guardEventsOf, EVENT_TAGS } from '../src/guard-events.mjs';
import { engineRecord } from '../src/live-agent.mjs';
import { approvalResourceId, approvalContextString } from '../src/human-approval.mjs';
import { callTool } from '../src/registry-mcp.mjs';
import { GuardClient } from '../src/guard-client.mjs';
import { evaluate } from '../../agent/src/policy/engine.mjs';
import { A, record } from './helpers.mjs';

const ev = (tag, id) => { const b = Buffer.alloc(9); b[0] = tag; b.writeBigUInt64LE(BigInt(id), 1); return b.toString('hex'); };

test('authorize outcome is read from the guard event (Authorized vs PendingApproval)', () => {
  const s = (tag) => ({ events: [{ address: { index: 99n }, events: ['ff00'] }, { address: { index: 13037n }, events: [ev(tag, 5)] }] });
  assert.deepEqual(authorizeOutcome(s(EVENT_TAGS.Authorized), 13037n), { id: 5n, status: 'Approved' });
  assert.deepEqual(authorizeOutcome(s(EVENT_TAGS.PendingApproval), 13037n), { id: 5n, status: 'Pending' });
  assert.throws(() => authorizeOutcome({ events: [] }, 13037n));
  assert.equal(guardEventsOf(s(7), 13037n).length, 1);
});

test('contract AgentView maps onto the shared policy engine', () => {
  const r = engineRecord({ record: record({ day: 20756n, spent_today: 4_500_000n }) });
  assert.equal(r.policy.asset, 'CCD');
  const today = 20756n;
  assert.deepEqual(evaluate({ agent: r, payee: A.seller, asset: 'CCD', amount: 500_000n, today }), { ok: true, decision: 'Approve' });
  assert.deepEqual(evaluate({ agent: r, payee: A.seller, asset: 'CCD', amount: 4_000_000n, today }), { ok: true, decision: 'NeedsApproval' });
  assert.equal(evaluate({ agent: r, payee: A.seller, asset: 'CCD', amount: 9_000_000n, today }).error, 'PerTxCap');
  assert.equal(evaluate({ agent: r, payee: A.seller, asset: 'CCD', amount: 5_000_000n, today }).error, undefined);
  assert.equal(evaluate({ agent: r, payee: A.owner, asset: 'CCD', amount: 1n, today }).error, 'NotAllowlisted');
});

test('approval request names exactly one authorisation of one guard', () => {
  assert.equal(approvalResourceId({ index: 13037n, subindex: 0n }, 4n), 'trustrail:ccd:testnet:13037:0:auth:4');
  assert.match(approvalContextString({ amount: 4000000n, payee: A.seller, purpose_hash: 'ab'.repeat(32) }), /approve 4000000 microCCD to 3joC/);
});

test('registry MCP client returns structured content and surfaces tool errors', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ result: { structuredContent: { badge_valid: true } } }) });
  assert.deepEqual(await callTool('check_badge', {}, { fetchImpl: ok }), { badge_valid: true });
  const txt = async () => ({ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: '{"a":1}' }] } }) });
  assert.deepEqual(await callTool('x', {}, { fetchImpl: txt }), { a: 1 });
  const bad = async () => ({ ok: true, json: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'nope' }] } }) });
  await assert.rejects(callTool('x', {}, { fetchImpl: bad }), /nope/);
});

test('guard parameters serialise through the deployed module schema', () => {
  const g = new GuardClient({ grpc: null, address: { index: 1n, subindex: 0n } });
  assert.equal(g.param('approve', { id: 3n, human_proof: 'aa'.repeat(32) }).toString(), `0300000000000000${'aa'.repeat(32)}`);
  assert.equal(g.param('anchorAudit', { head: 'bb'.repeat(32), count: 2n }).toString(), `${'bb'.repeat(32)}0200000000000000`);
  assert.throws(() => g.param('approve', { id: 3n }));
});

test('approval context must match the anchored request exactly (nonce, resource, block hash)', async () => {
  const { checkContext } = await import('../src/human-approval.mjs');
  const { BlockHash, TransactionHash } = await import('@concordium/web-sdk');
  const bh = BlockHash.fromHexString('ab'.repeat(32));
  const request = {
    transactionRef: TransactionHash.fromHexString('cd'.repeat(32)),
    context: { given: [{ label: 'Nonce', context: new Uint8Array([1, 2]) }, { label: 'ResourceID', context: 'r:1' }], requested: ['BlockHash'] },
  };
  const pres = (over = {}) => ({ presentationContext: { given: [{ label: 'Nonce', context: new Uint8Array([1, 2]) }, { label: 'ResourceID', context: 'r:1' }], requested: [{ label: 'BlockHash', context: bh }], ...over } });
  const grpc = { getBlockItemStatus: async () => ({ status: 'finalized', outcome: { blockHash: bh } }) };
  await checkContext(grpc, request, pres());
  await assert.rejects(checkContext(grpc, request, pres({ given: [{ label: 'Nonce', context: new Uint8Array([9]) }, { label: 'ResourceID', context: 'r:1' }] })), /approval_context_mismatch: Nonce/);
  await assert.rejects(checkContext(grpc, request, pres({ given: [{ label: 'Nonce', context: new Uint8Array([1, 2]) }, { label: 'ResourceID', context: 'r:2' }] })), /ResourceID/);
  await assert.rejects(checkContext(grpc, request, pres({ requested: [{ label: 'BlockHash', context: BlockHash.fromHexString('ef'.repeat(32)) }] })), /BlockHash/);
  await assert.rejects(checkContext({ getBlockItemStatus: async () => ({ status: 'committed' }) }, request, pres()), /not_finalized/);
});

test('requested claims must be the account-based age check from a trusted IdP', async () => {
  const { checkRequestedClaims } = await import('../src/human-approval.mjs');
  const { getPastDate } = await import('@concordium/web-sdk');
  const good = { subjectClaims: [{ type: 'identity', source: ['accountCredential'], issuers: ['did:ccd:testnet:idp:0'], statements: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: getPastDate(18, 1) }] }] };
  checkRequestedClaims(good);
  const c = structuredClone(good); c.subjectClaims[0].statements = [];
  assert.throws(() => checkRequestedClaims(c), /approval_wrong_claims/);
  const c2 = structuredClone(good); c2.subjectClaims[0].issuers = ['did:ccd:testnet:idp:9'];
  assert.throws(() => checkRequestedClaims(c2), /untrusted_issuer/);
  const c3 = structuredClone(good); c3.subjectClaims[0].statements[0].upper = getPastDate(10, 1);
  assert.throws(() => checkRequestedClaims(c3), /approval_wrong_claims/);
});
