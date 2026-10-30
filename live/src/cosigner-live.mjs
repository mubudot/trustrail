// The deterministic co-signer, live on testnet. It holds key 1 of the agent's 2-of-2 wallet and
// releases a signature ONLY for a transfer that exactly matches an Approved, unexpired guard
// authorisation — and, when a human approval was required, only after re-verifying the
// zero-knowledge "verified human approved this" record against the chain. Before signing it
// commits the transfer's sign-hash on chain (commitPayment: Approved -> Committed, atomic), so an
// authorisation is co-signed at most once. Every refusal has a stable reason code.
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { fromJSON, signingDigest } from './x402-buyer.mjs';
import { signDigestWithKey, verifyDigestWithKey } from './keys.mjs';
import { AccountAddress } from '@concordium/web-sdk';
import { checkApproval as checkApprovalOnChain, approvalResourceId, approvalContextString } from './human-approval.mjs';
import { enumTag, unOpt } from './guard-client.mjs';

export const MAX_EXPIRY_S = 600;
/** Execution energy of a simple CCD transfer (what @x402/concordium and our buyer set). */
export const TRANSFER_ENERGY = 300n;

const same = (a, b) => AccountAddress.isAlias(AccountAddress.fromBase58(a), AccountAddress.fromBase58(b));

export class CosignRefused extends Error {
  constructor(reason) { super(`co-signer refused: ${reason}`); this.reason = reason; }
}

export class LiveCosigner {
  /**
   * @param {object} o
   * @param o.guard GuardClient
   * @param o.account {address, signer} the co-signer's own account (the guard's `cosigner`)
   * @param o.walletKey private key hex of key 1 of the agent wallet
   * @param o.agentPublicKey public key hex of key 0 of the agent wallet
   * @param o.agentAccount the agent's control account
   * @param o.owner the guard owner account
   * @param o.approvals (authId) => {record, anchorTx} | null   — where approval records are kept
   * @param o.humanProofAbove (bigint, optional) the co-signer's OWN pinned approval threshold. Above
   *   it a verified-human proof is required even if the owner has raised the on-chain threshold with
   *   updatePolicy: the owner key alone cannot switch the human check off.
   */
  constructor(o) { Object.assign(this, { clock: () => Date.now(), checkApproval: checkApprovalOnChain, ...o }); }

  async cosign({ authId, signableJSON, resourceUrl, requirements }) {
    const no = (r) => { throw new CosignRefused(r); };
    const view = await this.guard.authorization(authId);
    if (!view) no('unknown_authorization');
    const a = view.auth;
    const now = BigInt(this.clock());
    if (enumTag(a.mode) !== 'X402' || enumTag(a.status) !== 'Approved') no(`status_${enumTag(a.status)}`);
    const expiresAt = BigInt(Date.parse(a.expires_at));
    if (view.expired || now >= expiresAt) no('authorization_expired');
    if (a.agent !== this.agentAccount) no('authorization_for_other_agent');
    if ((await this.guard.view()).paused) no('guard_paused');
    const rec = (await this.guard.agent(a.agent))?.record;
    if (!rec || BigInt(rec.generation) !== BigInt(a.generation)) no('stale_generation');
    if (rec.paused) no('agent_paused');
    if (!rec.allowlist.includes(a.payee)) no('payee_not_allowlisted');

    // Human approval: required for every authorisation above the threshold (those went through
    // Pending -> approve, which stores the anchor hash). Verify the record, not just its presence.
    const humanProof = unOpt(a.human_proof);
    const amount = BigInt(a.amount);
    const abovePinned = this.humanProofAbove !== undefined && amount > BigInt(this.humanProofAbove);
    const needsHuman = amount > BigInt(rec.policy.approval_threshold) || abovePinned;
    if (needsHuman && !humanProof) no(abovePinned && amount <= BigInt(rec.policy.approval_threshold) ? 'human_approval_missing_pinned_threshold' : 'human_approval_missing');
    if (humanProof) {
      const ap = await this.approvals(authId);
      if (!ap) no('human_approval_record_unavailable');
      try {
        await this.checkApproval({ grpc: this.guard.grpc, recordJSON: ap.record, anchorTx: ap.anchorTx, ownerAddress: this.owner, resourceId: approvalResourceId(this.guard.address, authId), contextString: approvalContextString(a), expectedAnchorHash: humanProof, trustedVerifiers: [this.account.address] });
      } catch (e) { no(e.message.split(':')[0].replace(/\s+/g, '_')); }
    }

    let tx;
    try { tx = fromJSON(signableJSON); } catch { no('tx_unparseable'); }
    if (tx.version !== 1) no('tx_version');
    const h = tx.header;
    if (h.sender.address !== rec.wallet) no('tx_sender_not_agent_wallet');
    if (Number(h.numSignatures) !== 2) no('tx_num_signatures');
    if (!h.sponsor?.account) no('tx_no_sponsor');
    if (tx.payload.type !== 3 /* Transfer */) no('tx_not_a_simple_transfer');
    const payTo = tx.payload.toAddress.address;
    if (payTo !== a.payee) no('tx_payee_mismatch');
    if (tx.payload.amount.microCcdAmount !== BigInt(a.amount)) no('tx_amount_mismatch');
    if (enumTag(a.asset) !== 'Ccd') no('tx_asset_mismatch');
    const sponsor = h.sponsor.account.address;
    // Aliases are the same account: a wallet alias as sponsor would let these signatures also pay
    // the fees from the wallet. The sponsor must be exactly the facilitator named in the offer
    // (bound by the purpose hash) and must not be any alias of the wallet or the payee.
    if (same(sponsor, payTo) || same(sponsor, h.sender.address)) no('tx_sponsor_is_party');
    if (sponsor !== requirements?.extra?.feePayer) no('tx_sponsor_not_offer_fee_payer');
    if (Number(h.sponsor.numSignatures ?? 1) !== 1) no('tx_sponsor_signatures');
    if (BigInt(h.executionEnergyAmount?.value ?? h.executionEnergyAmount) !== TRANSFER_ENERGY) no('tx_energy');
    // A transfer with a stale or future nonce can never settle, but its commitment would book the
    // budget for good: only commit to the wallet's next nonce.
    if (this.guard.grpc?.getNextAccountNonce) {
      const { nonce } = await this.guard.grpc.getNextAccountNonce(AccountAddress.fromBase58(rec.wallet));
      if (BigInt(h.nonce.value ?? h.nonce) !== BigInt(nonce.value ?? nonce)) no('tx_nonce_not_next');
    }
    const expS = BigInt(h.expiry.expiryEpochSeconds ?? h.expiry);
    const nowS = now / 1000n;
    if (expS <= nowS || expS > nowS + BigInt(MAX_EXPIRY_S)) no('tx_expiry_window');
    if (expS * 1000n > expiresAt) no('tx_outlives_authorization');
    if (purposeHash(resourceUrl, requirements) !== a.purpose_hash) no('purpose_mismatch');
    const digest = signingDigest(tx);
    const agentSig = signableJSON.signatures?.sender?.[0]?.[0];
    if (!agentSig || !verifyDigestWithKey(this.agentPublicKey, digest, agentSig)) no('agent_signature_invalid');

    try {
      const c = await this.guard.send('commitPayment', { id: BigInt(authId), digest }, { sender: this.account.address, signer: this.account.signer });
      this.lastCommitTx = c.txHash;
    } catch (e) { no(`commit_${e.code ?? 'failed'}`); }
    return signDigestWithKey(this.walletKey, digest);
  }

  /** Cancel an authorisation the co-signer refused before committing (frees its budget). */
  async release(authId) {
    try {
      const r = await this.guard.send('cancel', BigInt(authId), { sender: this.account.address, signer: this.account.signer });
      this.lastCancelTx = r.txHash;
      return true;
    } catch { return false; }
  }
}
