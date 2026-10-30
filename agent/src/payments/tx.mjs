// x402 "exact" payload for Concordium: a V1 *sponsored* transfer, shaped like the payload of
// @x402/concordium (header.sponsor = facilitator, sender signature map filled by the client,
// sponsor signature added by the facilitator at settlement).
//
// The agent's paying account has TWO keys with threshold 2 (Concordium accounts support several
// keys per credential): key 0 is the agent's, key 1 is the co-signer's. Neither can move funds alone.
//
// MOCK NOTE: `signingDigest` is SHA-256 over canonical JSON of header + payload. On chain the
// digest is the Concordium transaction sign-hash computed by @concordium/web-sdk; the live
// adapter swaps this function, nothing else changes.
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { canonical, sha256Hex } from '../util/canonical.mjs';

export const MAX_EXPIRY_S = 600; // x402 Concordium facilitator rule 7: expiry <= 10 minutes ahead

export function buildSponsoredTransfer({ sender, nonce, payTo, amount, asset, sponsor, nowS, expiryS = 300 }) {
  const payload =
    asset === 'CCD'
      ? { type: 'transfer', toAddress: payTo, amount: amount.toString() }
      : { type: 'tokenUpdate', tokenId: asset.slice(4), operations: [{ transfer: { recipient: payTo, amount: amount.toString() } }] };
  return {
    version: 1,
    header: {
      sender, nonce, expiry: nowS + expiryS, executionEnergyAmount: 300, numSignatures: 2,
      sponsor: { account: sponsor, numSignatures: 1 },
    },
    payload,
    signatures: { sender: { 0: {} } },
  };
}

export const signingDigest = (tx) => sha256Hex(canonical({ header: tx.header, payload: tx.payload }));

export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'), privateKey };
}

export function signDigest(privateKey, digestHex) {
  return sign(null, Buffer.from(digestHex, 'hex'), privateKey).toString('hex');
}

export function verifyDigest(publicKeyHex, digestHex, sigHex) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(digestHex, 'hex'), key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

/** Extract (payTo, amount, asset) from a transfer payload; null if it is not a single transfer. */
export function transferOf(tx) {
  const p = tx?.payload;
  if (p?.type === 'transfer') return { payTo: p.toAddress, amount: BigInt(p.amount), asset: 'CCD' };
  if (p?.type === 'tokenUpdate' && Array.isArray(p.operations) && p.operations.length === 1 && p.operations[0].transfer) {
    const t = p.operations[0].transfer;
    return { payTo: t.recipient, amount: BigInt(t.amount), asset: `PLT:${p.tokenId}` };
  }
  return null;
}
