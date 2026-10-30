// Checks that the agent's hash-chained audit log is covered by an AuditAnchored event on chain,
// without trusting state/run.json to pick the "right" anchor.
//
// AuditAnchored layout (contract/src/events.rs, tag 18): tag u8 | by AccountAddress (32 bytes)
// | head HashSha256 (32 bytes) | count u64 little-endian.
//
// A rollback (truncate the log and present an OLDER anchor) is caught using the chain, not
// state/run.json, as the source of truth:
//  1. the guard's own counter (view.next_auth_id) says how many authorisations exist; for each one
//     the log must record its CURRENT on-chain lifecycle: authorised; approved when a human_proof
//     is set; co-signed when a commitment is set; settled with the exact on-chain settlement hash;
//     refused when it was cancelled or rejected;
//  2. every transaction the log or run.json names (any `txHash` / `*Tx` field) and every on-chain
//     settlement must be finalized at or before the anchor's block; unknown hashes fail.
// Any lookup error propagates: a failed read never counts as "absent".
import { AccountAddress, BlockHash, TransactionHash } from '@concordium/web-sdk';
import { guardEventsOf, EVENT_TAGS } from './guard-events.mjs';
import { enumTag, unOpt } from './guard-client.mjs';

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

/**
 * Current lifecycle of every authorisation the guard holds, read from chain. The count comes from
 * the contract's own `next_auth_id`; a missing record or any read error throws (never fails open).
 */
export async function readOnChainAuthorizations(guard) {
  const view = await guard.view();
  const n = Number(view.next_auth_id);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('guard view has no usable next_auth_id');
  const out = [];
  for (let id = 0; id < n; id++) {
    const r = await guard.authorization(id);
    if (!r || !r.auth) throw new Error(`authorisation #${id} below next_auth_id is missing on chain`);
    const a = r.auth;
    out.push({ id, status: enumTag(a.status), settlement: unOpt(a.settlement), committed: unOpt(a.commitment) !== null, humanProof: unOpt(a.human_proof) !== null });
  }
  return out;
}

/** Which lifecycle facts of one on-chain authorisation the log fails to record. */
export function lifecycleGaps(auth, entries) {
  const mine = entries.filter((e) => e?.data && e.data.authId !== undefined && e.data.authId !== null && String(e.data.authId) === String(auth.id));
  const has = (pred) => mine.some(pred);
  const gaps = [];
  if (!has((e) => e.event === 'authorized')) gaps.push('authorized');
  if (auth.humanProof && !has((e) => /approved/.test(e.event))) gaps.push('approved');
  if (auth.committed && !has((e) => e.event === 'cosigned')) gaps.push('cosigned');
  if (auth.status === 'Settled' && !has((e) => e.event === 'settled' && e.data.txHash === auth.settlement)) gaps.push('settled with the on-chain settlement hash');
  if ((auth.status === 'Cancelled' || auth.status === 'Rejected') && !has((e) => e.event === 'refused')) gaps.push('refused');
  return gaps;
}

/** A field holds a transaction hash when it is named `txHash` or ends in `Tx` (e.g. approveTx, cancelTx, recordAnchorTx). */
const isTxField = (k) => k === 'txHash' || /Tx$/.test(k);

/** Every transaction hash named by a list of records (log entries' `data`, or run.json steps). Malformed values are kept so they fail the height check. */
export function txHashesIn(records) {
  const out = new Set();
  for (const r of records) for (const [k, v] of Object.entries(r ?? {})) {
    if (isTxField(k) && v !== null && v !== undefined && v !== '') out.add(String(v).toLowerCase());
  }
  return [...out];
}

/** Every transaction hash the log itself names. */
export const txHashesInLog = (entries) => txHashesIn(entries.map((e) => e?.data));

/** Block height of a FINALIZED transaction, or null when it is unknown, not finalized, or not a valid hash. */
export async function txHeight(grpc, txHash) {
  if (!/^[0-9a-f]{64}$/i.test(String(txHash))) return null;
  let st;
  try { st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash)); } catch (e) {
    if (/not ?found/i.test(String(e?.message ?? e))) return null;
    throw e; // transient read errors fail the run instead of passing silently
  }
  const bh = st?.status === 'finalized' ? st?.outcome?.blockHash : null;
  if (!bh) return null;
  const info = await grpc.getBlockInfo(typeof bh === 'string' ? BlockHash.fromHexString(bh) : bh);
  return BigInt(info.blockHeight);
}

/**
 * Pure decision used by verify and the tests.
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function judgeAnchor({ event, allowedSenders, entries, onChainAuths, anchorHeight, coveredHeights }) {
  const reasons = [];
  const n = entries.length;
  if (!event) reasons.push('no AuditAnchored event from this guard in the anchor transaction');
  else {
    if (!allowedSenders.includes(event.by)) reasons.push('anchor sent by an account the guard does not let anchor');
    if (event.count !== n) reasons.push(`anchor covers ${event.count} entries, log has ${n}`);
    if (event.head !== entries[n - 1]?.hash) reasons.push('anchor head is not the hash of the last log entry');
  }
  for (const auth of onChainAuths) {
    const gaps = lifecycleGaps(auth, entries);
    if (gaps.length) reasons.push(`authorisation #${auth.id} is ${auth.status} on chain but the anchored log lacks: ${gaps.join(', ')}`);
  }
  if (anchorHeight === null || anchorHeight === undefined) reasons.push('anchor block height unknown');
  else if (coveredHeights.some((h) => h === null || h > anchorHeight)) reasons.push('anchor is older than a demo transaction it should cover');
  return { ok: reasons.length === 0, reasons };
}

/** Gather the on-chain facts for one anchor transaction and judge it. Read errors propagate. */
export async function checkAuditAnchor({ grpc, guard, anchorTxHash, entries, allowedSenders, coveredTxHashes = [] }) {
  // coveredTxHashes: extra transactions (e.g. every *Tx / txHash field of run.json) that must be finalized at or before the anchor.
  const st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(anchorTxHash));
  const ev = guardEventsOf(st?.outcome?.summary ?? {}, guard.address.index).find((e) => e.tag === EVENT_TAGS.AuditAnchored);
  const event = ev ? decodeAuditAnchored(ev.hex) : null;
  const onChainAuths = await readOnChainAuthorizations(guard);
  const anchorHeight = await txHeight(grpc, anchorTxHash);
  const covered = new Set([...coveredTxHashes.map((h) => h.toLowerCase()), ...txHashesInLog(entries),
    ...onChainAuths.map((a) => a.settlement).filter(Boolean).map((h) => h.toLowerCase())]);
  const coveredHeights = [];
  for (const h of covered) coveredHeights.push(await txHeight(grpc, h));
  return { event, onChainAuthCount: onChainAuths.length, ...judgeAnchor({ event, allowedSenders, entries, onChainAuths, anchorHeight, coveredHeights }) };
}
