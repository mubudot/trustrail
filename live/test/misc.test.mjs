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
