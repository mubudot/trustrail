// TrustRail buyer agent, live on Concordium testnet. Same pipeline as the offline TrustedAgent:
//   402 quote -> payee badge (hosted Agent Registry) -> local preflight -> on-chain authorize ->
//   (verified-human approval) -> agent signs key 0 -> co-signer checks + commits + signs key 1 ->
//   real x402 settlement via facilitator -> recordSettlement on chain -> hash-chained audit entry.
import { evaluate, dayOf } from '../../agent/src/policy/engine.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { checkPayee } from '../../agent/src/identity/badge.mjs';
import { nameOf } from '../../agent/src/policy/errors.mjs';
import { getPaymentRequired, selectRequirements, buildTransfer, signAsKey, addSig, toJSON, payWith } from './x402-buyer.mjs';
import { CosignRefused } from './cosigner-live.mjs';
import { authorizeOutcome } from './guard-events.mjs';
import { randomUUID } from 'node:crypto';
import { enumTag } from './guard-client.mjs';

/** Contract AgentView JSON -> the shape the shared JS policy engine uses. */
export function engineRecord(view) {
  const r = view.record;
  const asset = enumTag(r.policy.asset) === 'Ccd' ? 'CCD' : `PLT:${r.policy.asset.Plt[0]}`;
  return {
    paused: r.paused, allowlist: r.allowlist, day: BigInt(r.day), spentToday: BigInt(r.spent_today),
    policy: { asset, perTxCap: BigInt(r.policy.per_tx_cap), dailyCap: BigInt(r.policy.daily_cap), approvalThreshold: BigInt(r.policy.approval_threshold) },
  };
}

export class LiveAgent {
  constructor({ grpc, guard, agent, walletKey0, cosigner, resolver, audit, network, fetchImpl = fetch, requireVerifiedPayee = true }) {
    Object.assign(this, { grpc, guard, agent, walletKey0, cosigner, resolver, audit, network, fetchImpl, requireVerifiedPayee });
    this.pending = new Map();
    this.walletLock = Promise.resolve(); // one payment per wallet at a time (nonce allocation -> settlement)
  }

  #refuse(stage, reason, extra = {}) {
    this.audit.append('refused', { stage, reason, ...extra });
    return { status: 'refused', stage, reason, ...extra };
  }

  async buy(url, { intent = '' } = {}) {
    // A per-purchase id on every entry of this purchase, so concurrent purchases stay apart in the audit record.
    const request = randomUUID();
    this.audit.append('request', { request, url, intent });
    const q = await getPaymentRequired(url, this.fetchImpl);
    if (q.free) return { status: 'free', data: q.body };
    if (q.error) return this.#refuse('x402', q.error, { request });
    const req = selectRequirements(q.paymentRequired, { network: this.network });
    if (!req) return this.#refuse('x402', 'no_acceptable_offer', { request });
    const amount = BigInt(req.amount);
    this.audit.append('quote', { request, url, payTo: req.payTo, amount, asset: req.asset, badge: req.extra?.payeeBadge ?? null });

    const badgeIssue = await checkPayee({ resolver: this.resolver, badge: req.extra?.payeeBadge, payTo: req.payTo, required: this.requireVerifiedPayee });
    if (badgeIssue) return this.#refuse('identity', badgeIssue, { request, payTo: req.payTo });

    const me = await this.guard.agent(this.agent.address);
    if (!me) return this.#refuse('preflight', 'NotAgent', { request });
    const pre = evaluate({ agent: engineRecord(me), payee: req.payTo, asset: 'CCD', amount, today: dayOf(Date.now()) });
    if (!pre.ok) return this.#refuse('preflight', pre.error, { request, payTo: req.payTo, amount });

    const out = await this.authorize(req, url);
    if (out.refused) return this.#refuse('contract', out.code, { request, txHash: out.txHash });
    this.audit.append('authorized', { request, authId: out.id, status: out.status, txHash: out.txHash });
    if (out.status === 'Pending') {
      this.pending.set(String(out.id), { url, requirements: req });
      return { status: 'pending_approval', authId: out.id, txHash: out.txHash };
    }
    return this.pay(out.id, url, req);
  }

  /** On-chain authorize (also used directly by the demo to show the chain refusing). */
  async authorize(req, url) {
    try {
      const r = await this.guard.send('authorize', {
        payee: req.payTo, asset: { Ccd: [] }, amount: BigInt(req.amount), mode: { X402: [] }, purpose_hash: purposeHash(url, req),
      }, { sender: this.agent.address, signer: this.agent.signer });
      return { ...authorizeOutcome(r.summary, this.guard.address.index), txHash: r.txHash };
    } catch (e) {
      if (e.code !== undefined) return { refused: true, code: nameOf(Number(e.code)), txHash: e.txHash };
      throw e;
    }
  }

  async resume(authId) {
    const p = this.pending.get(String(authId));
    if (!p) return this.#refuse('resume', 'unknown_pending', { authId: String(authId) });
    this.pending.delete(String(authId));
    // The badge may have been revoked or the card changed while this waited for approval.
    const badgeIssue = await checkPayee({ resolver: this.resolver, badge: p.requirements.extra?.payeeBadge, payTo: p.requirements.payTo, required: this.requireVerifiedPayee });
    if (badgeIssue) {
      const released = await this.cosigner.release(BigInt(authId));
      return this.#refuse('identity', badgeIssue, { authId: String(authId), payTo: p.requirements.payTo, released, cancelTx: this.cosigner.lastCancelTx });
    }
    return this.pay(BigInt(authId), p.url, p.requirements);
  }

  /** Serialises payments from the wallet: build (nonce) -> co-sign -> settle cannot interleave. */
  pay(authId, url, requirements) {
    const run = this.walletLock.then(() => this.#payNow(authId, url, requirements));
    this.walletLock = run.catch(() => {});
    return run;
  }

  async #payNow(authId, url, requirements) {
    const view = await this.guard.authorization(authId);
    if (!view) return this.#refuse('pay', 'unknown_authorization', { authId });
    const me = await this.guard.agent(this.agent.address);
    const notAfterS = Math.floor(Date.parse(view.auth.expires_at) / 1000);
    let tx = await buildTransfer(this.grpc, { sender: me.record.wallet, requirements, notAfterS });
    tx = signAsKey(tx, 0, this.walletKey0);
    let cosig;
    try {
      cosig = await this.cosigner.cosign({ authId, signableJSON: toJSON(tx), resourceUrl: url, requirements });
    } catch (e) {
      if (!(e instanceof CosignRefused)) throw e;
      const released = await this.cosigner.release(authId);
      return this.#refuse('cosigner', e.reason, { authId, released, cancelTx: this.cosigner.lastCancelTx });
    }
    this.audit.append('cosigned', { authId, commitTx: this.cosigner.lastCommitTx });
    tx = addSig(tx, 1, cosig);
    let res;
    try {
      res = await payWith(url, requirements, tx, this.fetchImpl);
    } catch (e) {
      this.audit.append('settlement_unknown', { authId, error: String(e?.message ?? e) });
      return { status: 'settlement_unknown', authId };
    }
    if (res.status !== 200 || !res.settlement?.success) {
      // Keep any transaction hash the facilitator reported: it is the reconciliation key.
      const txHash = res.settlement?.transaction || null;
      this.audit.append('settlement_unknown', { authId, txHash, httpStatus: res.status, error: res.settlement?.errorReason ?? res.body?.error ?? 'settlement_failed' });
      return { status: 'settlement_unknown', authId, txHash, reason: res.settlement?.errorReason ?? res.body?.error };
    }
    const txHash = res.settlement.transaction;
    // Evidence first: the payment is final on chain whether or not the guard record succeeds.
    this.audit.append('paid', { authId, txHash, amount: BigInt(requirements.amount), payTo: requirements.payTo });
    let rec;
    try {
      rec = await this.guard.send('recordSettlement', { id: BigInt(authId), tx_hash: txHash }, { sender: this.agent.address, signer: this.agent.signer });
    } catch (e) {
      this.audit.append('settlement_record_failed', { authId, txHash, error: String(e?.code ?? e?.message ?? e) });
      return { status: 'paid_unrecorded', authId, txHash, commitTx: this.cosigner.lastCommitTx, data: res.body };
    }
    this.audit.append('settled', { authId, txHash, recordTx: rec.txHash });
    return { status: 'paid', authId, txHash, recordTx: rec.txHash, commitTx: this.cosigner.lastCommitTx, data: res.body };
  }
}
