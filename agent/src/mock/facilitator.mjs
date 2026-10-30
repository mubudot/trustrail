// Mock x402 facilitator for Concordium, implementing the 9 verification rules documented for
// @x402/concordium (exact scheme, sponsored V1 transfer), then "sponsor-sign + finalise" on the
// mock ledger. A real deployment uses @x402/concordium/exact/facilitator instead.
import { canonical, sha256Hex } from '../util/canonical.mjs';
import { MAX_EXPIRY_S, signingDigest, transferOf, verifyDigest } from '../payments/tx.mjs';

export class MockFacilitator {
  constructor({ ledger, address, clock = () => Date.now() }) {
    this.ledger = ledger;
    this.address = address;
    this.clock = clock;
  }

  supported() { return { kinds: [{ scheme: 'exact', network: 'ccd:testnet' }], extra: { feePayer: this.address } }; }

  verify(payload, requirements) {
    const bad = (reason) => ({ isValid: false, invalidReason: reason });
    const tx = payload?.signedTransaction;
    if (!tx) return bad('missing_payload');
    if (tx.version !== 1) return bad('invalid_transaction_version'); // rule 1
    if (tx.header?.sender !== payload.sender) return bad('sender_header_mismatch'); // rule 2
    if (tx.header?.sponsor?.account !== this.address) return bad('sponsor_mismatch'); // rule 3
    const t = transferOf(tx);
    if (!t) return bad('unexpected_transaction_type'); // rule 9
    if (t.payTo !== requirements.payTo) return bad('recipient_mismatch'); // rule 4
    if (t.amount !== BigInt(requirements.amount)) return bad('amount_mismatch'); // rule 5
    if (t.asset !== requirements.asset) return bad('asset_type_mismatch'); // rule 6
    const nowS = Math.floor(this.clock() / 1000);
    if (tx.header.expiry <= nowS) return bad('transaction_expired'); // rule 7
    if (tx.header.expiry > nowS + MAX_EXPIRY_S) return bad('expiry_too_far_in_future');
    if (t.payTo === this.address || tx.header.sender === this.address) return bad('sponsor_as_party'); // rule 9
    // rule 8: sender signatures checked against the on-chain keys and threshold
    const acct = this.ledger.account(tx.header.sender);
    if (!acct) return bad('invalid_sender_address');
    const digest = signingDigest(tx);
    const sigs = tx.signatures?.sender?.[0] ?? {};
    const valid = Object.entries(sigs).filter(([i, s]) => acct.keys[i] && verifyDigest(acct.keys[i], digest, s)).length;
    if (valid < acct.threshold) return bad('invalid_sender_signature');
    if (acct.balance < t.amount) return bad('insufficient_funds');
    return { isValid: true, payer: tx.header.sender };
  }

  settle(payload, requirements) {
    const v = this.verify(payload, requirements);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason };
    const tx = payload.signedTransaction;
    const txHash = sha256Hex(canonical(tx));
    const t = transferOf(tx);
    this.ledger.apply(txHash, { from: tx.header.sender, to: t.payTo, amount: t.amount });
    return { success: true, transaction: txHash, network: requirements.network, payer: tx.header.sender };
  }
}
