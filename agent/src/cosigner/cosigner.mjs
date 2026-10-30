// The deterministic co-signer. It holds key 1 of the agent's 2-of-2 paying wallet and signs a
// transfer ONLY when it matches an `Approved`, unexpired on-chain authorisation. Before releasing
// its signature it calls `commitPayment(id, digest)` on the guard: that on-chain transition
// (Approved -> Committed) is atomic, so an authorisation is co-signed at most once even across
// co-signer restarts or several instances, and the contract re-checks pause / generation /
// allowlist at that moment. No model, no prompts, no discretion: every refusal has a stable code.
import { GuardError } from '../policy/errors.mjs';
import { purposeHash } from '../util/canonical.mjs';
import { MAX_EXPIRY_S, signDigest, signingDigest, transferOf, verifyDigest } from '../payments/tx.mjs';

export class CosignRefused extends Error {
  constructor(reason) {
    super(`co-signer refused: ${reason}`);
    this.reason = reason;
  }
}

export class Cosigner {
  /**
   * @param {{guard: object, account: string, keyPair: {privateKey: import('node:crypto').KeyObject},
   *          agentAccount: string, agentPublicKey: string, clock?: () => number}} opts
   *   `account` is the co-signer's own Concordium account (the guard's configured `cosigner`).
   */
  constructor({ guard, account, keyPair, agentAccount, agentPublicKey, clock = () => Date.now() }) {
    Object.assign(this, { guard, account, keyPair, agentAccount, agentPublicKey, clock });
  }

  /** Returns the co-signature (hex) or throws CosignRefused. */
  cosign({ authId, tx, resourceUrl, requirements }) {
    const no = (r) => { throw new CosignRefused(r); };
    const view = this.guard.authorization(authId);
    if (!view) no('unknown_authorization');
    const a = view.auth;
    const nowMs = BigInt(this.clock());
    if (a.mode !== 'X402' || a.status !== 'Approved') no(`status_${a.status}`);
    if (nowMs >= a.expiresAt) no('authorization_expired');
    if (a.agent !== this.agentAccount) no('authorization_for_other_agent');
    // Live controls (fast local refusal; the contract re-checks them in commitPayment).
    if (this.guard.view().paused) no('guard_paused');
    const current = this.guard.agent(a.agent)?.record;
    if (!current || current.generation !== a.generation) no('stale_generation');
    if (current.paused) no('agent_paused');
    if (!current.allowlist.includes(a.payee)) no('payee_not_allowlisted');

    if (tx?.version !== 1) no('tx_version');
    const h = tx.header ?? {};
    if (h.sender !== current.wallet) no('tx_sender_not_agent_wallet');
    if (h.numSignatures !== 2) no('tx_num_signatures');
    if (!h.sponsor?.account) no('tx_no_sponsor');
    const t = transferOf(tx);
    if (!t) no('tx_not_a_single_transfer');
    if (t.payTo !== a.payee) no('tx_payee_mismatch');
    if (t.amount !== a.amount) no('tx_amount_mismatch');
    if (t.asset !== a.asset) no('tx_asset_mismatch');
    if (h.sponsor.account === t.payTo || h.sponsor.account === h.sender) no('tx_sponsor_is_party');
    const nowS = Number(nowMs / 1000n);
    if (h.expiry <= nowS || h.expiry > nowS + MAX_EXPIRY_S) no('tx_expiry_window');
    if (BigInt(h.expiry) * 1000n > a.expiresAt) no('tx_outlives_authorization');
    if (purposeHash(resourceUrl, requirements) !== a.purposeHash) no('purpose_mismatch');
    // The agent must already have signed exactly this transaction.
    const digest = signingDigest(tx);
    const agentSig = tx.signatures?.sender?.[0]?.[0];
    if (!agentSig || !verifyDigest(this.agentPublicKey, digest, agentSig)) no('agent_signature_invalid');

    try {
      this.guard.commitPayment(this.account, { id: authId, digest });
    } catch (e) {
      if (e instanceof GuardError) no(`commit_${e.code}`);
      throw e;
    }
    return signDigest(this.keyPair.privateKey, digest);
  }

  /**
   * Cancel an authorisation the co-signer refused (it is still `Approved`, so provably never
   * co-signed) to release its budget. Returns false when it is no longer cancellable.
   */
  release(authId) {
    try {
      this.guard.cancel(this.account, authId);
      return true;
    } catch (e) {
      if (e instanceof GuardError) return false;
      throw e;
    }
  }
}
