// Buyer side of x402 on Concordium for a 2-of-2 wallet. Builds exactly the V1 sponsored transfer
// that @x402/concordium's client builds, but splits signing: the agent signs with key 0, the
// co-signer (after its own checks and the on-chain commit) with key 1.
import {
  AccountAddress, CcdAmount, TransactionExpiry, Transaction, AccountTransactionV1,
} from '@concordium/web-sdk';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { signDigestWithKey } from './keys.mjs';

export async function getPaymentRequired(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (res.status === 200) return { free: true, body: await res.json() };
  const h = res.headers.get('payment-required');
  if (res.status !== 402 || !h) return { error: `unexpected_status_${res.status}` };
  return { paymentRequired: decodePaymentRequiredHeader(h) };
}

/** Choose the first `exact` CCD offer on our network. */
export function selectRequirements(pr, { network, asset = 'CCD' }) {
  return pr.accepts.find((r) => r.scheme === 'exact' && r.network === network && (r.asset || 'CCD').toUpperCase() === asset) ?? null;
}

/** Unsigned V1 sponsored CCD transfer (same construction as @x402/concordium's client). */
export async function buildTransfer(grpc, { sender, requirements, notAfterS, numSignatures = 2 }) {
  const { nonce } = await grpc.getNextAccountNonce(AccountAddress.fromBase58(sender));
  const nowS = Math.floor(Date.now() / 1000);
  const expiryS = Math.min(nowS + requirements.maxTimeoutSeconds - 5, notAfterS ?? Infinity, nowS + 300);
  return Transaction.transfer({ toAddress: AccountAddress.fromBase58(requirements.payTo), amount: CcdAmount.fromMicroCcd(BigInt(requirements.amount)) })
    .addMetadata({ sender: AccountAddress.fromBase58(sender), nonce, expiry: TransactionExpiry.fromEpochSeconds(expiryS) })
    .addMultiSig(numSignatures) // the paying wallet is 2-of-2 (agent key 0 + co-signer key 1)
    .addSponsor(AccountAddress.fromBase58(requirements.extra.feePayer))
    .build();
}

/** The Concordium sign-hash of a signable transaction (what every key signs). */
export function signingDigest(signable) {
  return Buffer.from(AccountTransactionV1.signDigest(Transaction.preFinalized(signable))).toString('hex');
}

/** Add a raw Ed25519 signature for key `keyIndex` of credential 0. */
export const addSig = (signable, keyIndex, sigHex) => Transaction.addSignature(signable, { 0: { [keyIndex]: sigHex } });

export function signAsKey(signable, keyIndex, privateKeyHex) {
  return addSig(signable, keyIndex, signDigestWithKey(privateKeyHex, signingDigest(signable)));
}

export const toJSON = (signable) => toJsonSafe(Transaction.toJSON(signable));
export const fromJSON = (json) => Transaction.signableFromJSON(json);

export async function payWith(url, requirements, signable, fetchImpl = fetch) {
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: requirements, payload: { signedTransaction: toJSON(signable) } });
  const res = await fetchImpl(url, { headers: { 'PAYMENT-SIGNATURE': header } });
  const ph = res.headers.get('payment-response');
  return { status: res.status, body: await res.json().catch(() => null), settlement: ph ? decodePaymentResponseHeader(ph) : null };
}

function toJsonSafe(v) {
  if (typeof v === 'bigint') return v > Number.MAX_SAFE_INTEGER || v < Number.MIN_SAFE_INTEGER ? v.toString() : Number(v);
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJsonSafe(x)]));
  return v;
}
