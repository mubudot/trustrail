import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { decodeAuditAnchored, judgeAnchor, readOnChainAuthorizations, lifecycleGaps, txHashesInLog, ANCHOR_EVENT_LEN } from '../src/audit-anchor.mjs';
import { EVENT_TAGS } from '../src/guard-events.mjs';

const OWNER = '4quNUwSZDXiz2zb6jGQ8ytj6UX3ASqwyoBt4owTc5k9h6mMnMU';
const OTHER = '3joCzai3rDHSPbqH6FnsDs4ZwCiVcErjdpRvdEavojrzu2Pn7H';
const anchorHex = (by, head, count) => {
  const b = Buffer.alloc(ANCHOR_EVENT_LEN);
  b[0] = EVENT_TAGS.AuditAnchored;
  Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(by))).copy(b, 1);
  Buffer.from(head, 'hex').copy(b, 33);
  b.writeBigUInt64LE(BigInt(count), 65);
  return b.toString('hex');
};
const h = (i) => i.toString(16).padStart(64, '0');
const SETTLE0 = 'a'.repeat(64);
// #0 auto-approved and settled, #1 human-approved and settled... simplified to: #0 settled, #1 pending->approved->settled, #2 cancelled.
const ev = (event, data) => ({ event, data });
const lifecycle = [
  ev('authorized', { authId: '0', txHash: h(100) }), ev('cosigned', { authId: '0' }), ev('settled', { authId: '0', txHash: SETTLE0 }),
  ev('authorized', { authId: '1', txHash: h(101) }), ev('human_approved', { authId: '1', approveTx: h(102) }), ev('cosigned', { authId: '1' }), ev('settled', { authId: '1', txHash: h(103) }),
  ev('authorized', { authId: '2', txHash: h(104) }), ev('approved_without_proof', { authId: '2' }), ev('refused', { authId: '2', reason: 'human_approval_record_unavailable' }),
].map((e, i) => ({ ...e, seq: i, hash: h(i + 1) }));
const chain = [
  { id: 0, status: 'Settled', settlement: SETTLE0, committed: true, humanProof: false },
  { id: 1, status: 'Settled', settlement: h(103), committed: true, humanProof: true },
  { id: 2, status: 'Cancelled', settlement: null, committed: false, humanProof: true },
];
const base = (entries, extra = {}) => ({
  event: decodeAuditAnchored(anchorHex(OWNER, entries.at(-1).hash, entries.length)),
  allowedSenders: [OWNER], entries, onChainAuths: chain, anchorHeight: 100n, coveredHeights: [10n, 50n, 99n], ...extra,
});

test('AuditAnchored decoding: tag u8 | by 32 | head 32 | count u64 LE', () => {
  assert.deepEqual(decodeAuditAnchored(anchorHex(OWNER, h(7), 40)), { by: OWNER, head: h(7), count: 40 });
  assert.equal(decodeAuditAnchored(anchorHex(OWNER, h(7), 40).slice(0, -2)), null);
  assert.equal(decodeAuditAnchored('11' + anchorHex(OWNER, h(7), 40).slice(2)), null);
});

test('anchor of the whole log, after the run, recording every on-chain lifecycle passes', () => {
  assert.deepEqual(judgeAnchor(base(lifecycle)), { ok: true, reasons: [] });
});

test('rollback: older anchor of a log that predates authorisations fails', () => {
  const r = judgeAnchor(base(lifecycle.slice(0, 3)));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join('|'), /#1 is Settled on chain but the anchored log lacks: authorized, approved, cosigned, settled/);
  assert.match(r.reasons.join('|'), /#2 is Cancelled on chain .* refused/);
});

test('rollback: older anchor that names every id but predates later lifecycle steps fails', () => {
  // A legitimate anchor taken while #1 was still Pending: every id is mentioned, the approval and settlement are not.
  const early = lifecycle.filter((e) => !(e.data.authId === '1' && e.event !== 'authorized'));
  const r = judgeAnchor(base(early));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join('|'), /#1 is Settled on chain but the anchored log lacks: approved, cosigned, settled/);
});

test('a settled entry with a different hash than the chain records fails', () => {
  const swapped = lifecycle.map((e) => (e.event === 'settled' && e.data.authId === '0' ? { ...e, data: { ...e.data, txHash: h(999) } } : e));
  assert.match(judgeAnchor(base(swapped)).reasons.join('|'), /#0 .* settled with the on-chain settlement hash/);
});

test('anchor older than a covered transaction fails', () => {
  assert.match(judgeAnchor(base(lifecycle, { anchorHeight: 60n })).reasons.join('|'), /older than a demo transaction/);
  assert.equal(judgeAnchor(base(lifecycle, { coveredHeights: [null] })).ok, false);
  assert.equal(judgeAnchor(base(lifecycle, { anchorHeight: null })).ok, false);
});

test('prefix anchor, wrong head, foreign sender, or no event fails', () => {
  const prefix = { ...base(lifecycle), event: decodeAuditAnchored(anchorHex(OWNER, lifecycle[8].hash, 9)) };
  assert.equal(judgeAnchor(prefix).ok, false);
  const wrongHead = { ...base(lifecycle), event: decodeAuditAnchored(anchorHex(OWNER, h(999), lifecycle.length)) };
  assert.equal(judgeAnchor(wrongHead).ok, false);
  const foreign = { ...base(lifecycle), event: decodeAuditAnchored(anchorHex(OTHER, lifecycle.at(-1).hash, lifecycle.length)) };
  assert.match(judgeAnchor(foreign).reasons.join('|'), /does not let anchor/);
  assert.equal(judgeAnchor({ ...base(lifecycle), event: null }).ok, false);
});

test('on-chain authorisations come from next_auth_id; read errors and gaps throw (never fail open)', async () => {
  const rec = (status) => ({ auth: { status: { [status]: [] }, settlement: { None: [] }, commitment: { None: [] }, human_proof: { None: [] } } });
  const ok = { view: async () => ({ next_auth_id: 2n }), authorization: async () => rec('Pending') };
  assert.equal((await readOnChainAuthorizations(ok)).length, 2);
  const erroring = { view: async () => ({ next_auth_id: 3n }), authorization: async (i) => { if (i === 1) throw new Error('UNAVAILABLE'); return rec('Pending'); } };
  await assert.rejects(readOnChainAuthorizations(erroring), /UNAVAILABLE/);
  const gap = { view: async () => ({ next_auth_id: 3n }), authorization: async (i) => (i === 2 ? null : rec('Pending')) };
  await assert.rejects(readOnChainAuthorizations(gap), /#2 below next_auth_id is missing/);
  await assert.rejects(readOnChainAuthorizations({ view: async () => ({}) }), /next_auth_id/);
});

test('log tx hashes are collected for the height check', () => {
  assert.deepEqual(txHashesInLog(lifecycle).sort(), [h(100), SETTLE0, h(101), h(102), h(103), h(104)].sort());
  assert.deepEqual(lifecycleGaps(chain[2], lifecycle), []);
});
