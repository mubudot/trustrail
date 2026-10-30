// x402 buyer side for Concordium, with the guard in the loop:
//   402 -> pick requirements -> (caller checks policy/badge) -> build sponsored transfer ->
//   agent signs (key 0) -> co-signer signs (key 1) -> retry with PAYMENT-SIGNATURE -> settlement.
import { buildSponsoredTransfer, signDigest, signingDigest } from './tx.mjs';
import { b64, unb64 } from '../util/b64json.mjs';

export function parsePaymentRequired(res) {
  const h = res.headers['PAYMENT-REQUIRED'];
  if (res.status !== 402 || !h) return null;
  return unb64(h);
}

/** Choose the first `exact` offer on our network in our budget asset. */
export function selectRequirements(paymentRequired, { network, asset }) {
  return paymentRequired.accepts.find((r) => r.scheme === 'exact' && r.network === network && r.asset === asset) ?? null;
}

/**
 * Build and agent-sign the transfer; returns the tx with signature slot 0 filled.
 * `notAfterS`: the authorisation's expiry — the transaction must not outlive it.
 */
export function buildAgentSignedTx({ agentAccount, agentKey, nonce, requirements, nowS, notAfterS = Infinity }) {
  const expiryS = Math.min(requirements.maxTimeoutSeconds ?? 300, 300, notAfterS - nowS);
  const tx = buildSponsoredTransfer({
    sender: agentAccount, nonce, payTo: requirements.payTo, amount: BigInt(requirements.amount),
    asset: requirements.asset, sponsor: requirements.extra.feePayer, nowS, expiryS,
  });
  tx.signatures.sender[0][0] = signDigest(agentKey, signingDigest(tx));
  return tx;
}

export async function submitPayment({ fetchImpl, url, requirements, tx }) {
  const header = b64({ x402Version: 2, accepted: requirements, payload: { signedTransaction: tx, sender: tx.header.sender } });
  const res = await fetchImpl(url, { headers: { 'PAYMENT-SIGNATURE': header } });
  const settlement = res.headers['PAYMENT-RESPONSE'] ? unb64(res.headers['PAYMENT-RESPONSE']) : null;
  return { res, settlement };
}
