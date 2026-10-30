// Checks that the agent's hash-chained audit log is covered by an AuditAnchored event on chain,
// without trusting state/run.json to pick the "right" anchor.
//
// AuditAnchored layout (contract/src/events.rs, tag 18): tag u8 | by AccountAddress (32 bytes)
// | head HashSha256 (32 bytes) | count u64 little-endian.
//
// A rollback (truncate the log and present an OLDER anchor) is caught two ways that only use the
// chain as the source of truth:
//  1. every authorisation the guard holds on chain (ids 0..N-1, probed until the first missing id)
//     must appear in the anchored log, and
//  2. the anchor must be in a block at or after every demo transaction being verified.
import { AccountAddress, BlockHash, TransactionHash } from '@concordium/web-sdk';
import { guardEventsOf, EVENT_TAGS } from './guard-events.mjs';

export const ANCHOR_EVENT_LEN = 1 + 32 + 32 + 8;

/** Decode an AuditAnchored event's raw bytes. Returns null when the bytes are too short or the tag is wrong. */
export function decodeAuditAnchored(hex) {
  const b = Buffer.from(hex, 'hex');
  if (b.length < ANCHOR_EVENT_LEN || b[0] !== EVENT_TAGS.AuditAnchored) return null;
  return {
    by: AccountAddress.fromBuffer(b.subarray(1, 33)).address,
    head: b.subarray(33, 65).toString('hex'),
    count: Number(b.readBigUInt64LE(65)),
  };
}

/** Number of authorisations the guard holds: ids are dense from 0, so probe until the first gap. */
export async function countGuardAuthorizations(guard, max = 10_000) {
  let n = 0;
  for (; n < max; n++) {
    let a = null;
    try { a = await guard.authorization(n); } catch { a = null; }
    if (!a || !a.auth) break;
  }
  return n;
}

/** Auth ids (as strings) that the log mentions in any entry's data.authId / data.id. */
export function authIdsInLog(entries) {
  const ids = new Set();
  for (const e of entries) {
    const d = e?.data ?? {};
    if (d.authId !== undefined && d.authId !== null) ids.add(String(d.authId));
  }
  return ids;
}

/** Block height of a finalized transaction (null if unknown). */
export async function txHeight(grpc, txHash) {
  const st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  const bh = st?.outcome?.blockHash;
  if (!bh) return null;
  const info = await grpc.getBlockInfo(typeof bh === 'string' ? BlockHash.fromHexString(bh) : bh);
  return BigInt(info.blockHeight);
}

/**
 * Pure decision used by verify and the tests.
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function judgeAnchor({ event, allowedSenders, entries, onChainAuthCount, anchorHeight, coveredHeights }) {
  const reasons = [];
  const n = entries.length;
  if (!event) reasons.push('no AuditAnchored event from this guard in the anchor transaction');
  else {
    if (!allowedSenders.includes(event.by)) reasons.push('anchor sent by an account the guard does not let anchor');
    if (event.count !== n) reasons.push(`anchor covers ${event.count} entries, log has ${n}`);
    if (event.head !== entries[n - 1]?.hash) reasons.push('anchor head is not the hash of the last log entry');
  }
  const ids = authIdsInLog(entries);
  const missing = [];
  for (let i = 0; i < onChainAuthCount; i++) if (!ids.has(String(i))) missing.push(i);
  if (missing.length) reasons.push(`authorisations on chain but not in the anchored log: #${missing.join(', #')}`);
  if (anchorHeight === null || anchorHeight === undefined) reasons.push('anchor block height unknown');
  else if (coveredHeights.some((h) => h === null || h > anchorHeight)) reasons.push('anchor is older than a demo transaction it should cover');
  return { ok: reasons.length === 0, reasons };
}

/** Gather the on-chain facts for one anchor transaction and judge it. */
export async function checkAuditAnchor({ grpc, guard, anchorTxHash, entries, allowedSenders, coveredTxHashes }) {
  const st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(anchorTxHash));
  const ev = guardEventsOf(st?.outcome?.summary ?? {}, guard.address.index).find((e) => e.tag === EVENT_TAGS.AuditAnchored);
  const event = ev ? decodeAuditAnchored(ev.hex) : null;
  const onChainAuthCount = await countGuardAuthorizations(guard);
  const anchorHeight = await txHeight(grpc, anchorTxHash);
  const coveredHeights = [];
  for (const h of coveredTxHashes) coveredHeights.push(await txHeight(grpc, h));
  return { event, onChainAuthCount, ...judgeAnchor({ event, allowedSenders, entries, onChainAuthCount, anchorHeight, coveredHeights }) };
}
