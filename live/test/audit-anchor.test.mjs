import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress } from '@concordium/web-sdk';
import { decodeAuditAnchored, judgeAnchor, countGuardAuthorizations, ANCHOR_EVENT_LEN } from '../src/audit-anchor.mjs';
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
// 6 authorisations (#0..#5), two entries each.
const fullLog = Array.from({ length: 12 }, (_, i) => ({ seq: i, hash: h(i + 1), data: { authId: String(Math.floor(i / 2)) } }));
const base = (entries, extra = {}) => ({
  event: decodeAuditAnchored(anchorHex(OWNER, entries.at(-1).hash, entries.length)),
  allowedSenders: [OWNER], entries, onChainAuthCount: 6, anchorHeight: 100n, coveredHeights: [10n, 50n, 99n], ...extra,
});

test('AuditAnchored decoding: tag u8 | by 32 | head 32 | count u64 LE', () => {
  const e = decodeAuditAnchored(anchorHex(OWNER, h(7), 40));
  assert.deepEqual(e, { by: OWNER, head: h(7), count: 40 });
  assert.equal(decodeAuditAnchored(anchorHex(OWNER, h(7), 40).slice(0, -2)), null);
  assert.equal(decodeAuditAnchored('11' + anchorHex(OWNER, h(7), 40).slice(2)), null);
});

test('anchor of the whole log, after the run, covering every on-chain authorisation passes', () => {
  assert.deepEqual(judgeAnchor(base(fullLog)), { ok: true, reasons: [] });
});

test('rollback: older anchor of a truncated log fails even if run.json was edited to match', () => {
  const truncated = fullLog.slice(0, 8); // drops #4 and #5
  const r = judgeAnchor(base(truncated, { anchorHeight: 40n, coveredHeights: [10n, 30n] }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join('|'), /not in the anchored log: #4, #5/);
});

test('anchor older than a covered demo transaction fails', () => {
  const r = judgeAnchor(base(fullLog, { anchorHeight: 60n }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join('|'), /older than a demo transaction/);
});

test('prefix anchor, wrong head, or foreign sender fails', () => {
  const prefix = { ...base(fullLog), event: decodeAuditAnchored(anchorHex(OWNER, fullLog[9].hash, 10)) };
  assert.equal(judgeAnchor(prefix).ok, false);
  const wrongHead = { ...base(fullLog), event: decodeAuditAnchored(anchorHex(OWNER, h(999), 12)) };
  assert.equal(judgeAnchor(wrongHead).ok, false);
  const foreign = { ...base(fullLog), event: decodeAuditAnchored(anchorHex(OTHER, fullLog.at(-1).hash, 12)) };
  assert.match(judgeAnchor(foreign).reasons.join('|'), /does not let anchor/);
  assert.equal(judgeAnchor({ ...base(fullLog), event: null }).ok, false);
  assert.equal(judgeAnchor({ ...base(fullLog), anchorHeight: null }).ok, false);
  assert.equal(judgeAnchor({ ...base(fullLog), coveredHeights: [null] }).ok, false);
});

test('on-chain authorisation count probes dense ids until the first gap', async () => {
  const have = new Set([0, 1, 2]);
  const guard = { authorization: async (i) => (have.has(i) ? { auth: { id: i } } : null) };
  assert.equal(await countGuardAuthorizations(guard), 3);
  const throwing = { authorization: async (i) => { if (i > 1) throw new Error('not found'); return { auth: {} }; } };
  assert.equal(await countGuardAuthorizations(throwing), 2);
});
