// The deterministic co-signer. It holds key 1 of the agent's 2-of-2 paying account and signs a
// transfer ONLY when it matches an `Approved`, unexpired, unconsumed on-chain authorisation.
// No model, no prompts, no discretion: every refusal has a stable reason code.
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
   * @param {{guard: object, keyPair: {privateKey: import('node:crypto').KeyObject},
   *          agentAccount: string, agentPublicKey: string, clock?: () => number}} opts
   */
  constructor({ guard, keyPair, agentAccount, agentPublicKey, clock = () => Date.now() }) {
    this.guard = guard;
    this.keyPair = keyPair;
    this.agentAccount = agentAccount;
    this.agentPublicKey = agentPublicKey;
    this.clock = clock;
    this.consumed = new Set();
  }

  /** Returns the co-signature (hex) or throws CosignRefused. */
  cosign({ authId, tx, resourceUrl, requirements }) {
    const no = (r) => { throw new CosignRefused(r); };
    const view = this.guard.authorization(authId);
    if (!view) no('unknown_authorization');
    const a = view.auth;
    const nowMs = BigInt(this.clock());
    if (a.status !== 'Approved' || a.mode !== 'X402') no(`status_${a.status}`);
    if (nowMs >= a.expiresAt) no('authorization_expired');
    if (this.consumed.has(String(authId))) no('authorization_already_used');
    if (a.agent !== this.agentAccount) no('authorization_for_other_agent');

    if (tx?.version !== 1) no('tx_version');
    const h = tx.header ?? {};
    if (h.sender !== this.agentAccount) no('tx_sender');
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

    this.consumed.add(String(authId));
    return signDigest(this.keyPair.privateKey, digest);
  }
}
