// Settlement ↔ commitment binding, checked from the chain alone (read-only, no keys).
//
// commitPayment stored the signing digest the co-signer was about to sign. Here we fetch the
// finalized settlement transaction itself (raw GetBlockItems; the high-level web-sdk client only
// returns summaries) and check that the 2-of-2 wallet's signatures in it are valid Ed25519
// signatures on that committed digest. The node only accepts a transaction whose signatures verify
// against its own sign hash, so this shows the settled transaction IS the committed one — not just a
// transfer with the same fields.
import { BlockHash, TransactionHash } from '@concordium/web-sdk';
import { verifyDigestWithKey } from './keys.mjs';
import { withRetry } from './net.mjs';

const hex = (b) => Buffer.from(b).toString('hex');

/** Signatures of credential 0 of the sender of block item `txHash` ({keyIndex: sigHex}), or null. */
export function senderSignaturesOf(grpc, txHash) {
  return withRetry(() => readSenderSignatures(grpc, txHash));
}

async function readSenderSignatures(grpc, txHash) {
  const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  if (status.status !== 'finalized') return null;
  const blockHash = status.outcome.blockHash;
  const call = grpc.client.getBlockItems({ blockHashInput: { oneofKind: 'given', given: { value: BlockHash.toBuffer(blockHash) } } });
  for await (const item of call.responses) {
    if (hex(item.hash.value) !== txHash) continue;
    const t = item.blockItem[item.blockItem.oneofKind];
    const sender = t?.signatures?.senderSignatures ?? t?.signature;
    const cred0 = sender?.signatures?.[0]?.signatures;
    if (!cred0) return null;
    return Object.fromEntries(Object.entries(cred0).map(([k, v]) => [k, hex(v.value)]));
  }
  return null;
}

/**
 * True iff the settled transaction carries valid signatures on `commitment` from BOTH wallet keys.
 * @param walletPublicKeys {agentKey0, cosignerKey1} hex
 */
export async function settlementMatchesCommitment(grpc, { txHash, commitment, walletPublicKeys }) {
  if (!commitment) return false;
  const sigs = await senderSignaturesOf(grpc, txHash);
  if (!sigs || !sigs[0] || !sigs[1]) return false;
  return verifyDigestWithKey(walletPublicKeys.agentKey0, commitment, sigs[0])
    && verifyDigestWithKey(walletPublicKeys.cosignerKey1, commitment, sigs[1]);
}
