// TrustedAgent: the accountable buyer. The model (or script) driving it only says *what* to buy;
// every payment goes through the same deterministic path:
//   badge check -> local preflight -> on-chain authorize -> (owner approval) -> co-signed x402 payment
//   -> on-chain settlement record, with a hash-chained audit entry at every step.
import { dayOf, evaluate } from './policy/engine.mjs';
import { GuardError } from './policy/errors.mjs';
import { purposeHash } from './util/canonical.mjs';
import { checkPayee } from './identity/badge.mjs';
import { CosignRefused } from './cosigner/cosigner.mjs';
import { buildAgentSignedTx, parsePaymentRequired, selectRequirements, submitPayment } from './payments/x402-client.mjs';

export class TrustedAgent {
  constructor({ account, agentKey, guard, cosigner, resolver, audit, fetchImpl, nonceOf, network, clock = () => Date.now(), requireVerifiedPayee = true }) {
    Object.assign(this, { account, agentKey, guard, cosigner, resolver, audit, fetchImpl, nonceOf, network, clock, requireVerifiedPayee });
    this.pending = new Map(); // authId -> {url, requirements}
  }

  #refuse(stage, reason, extra = {}) {
    this.audit.append('refused', { stage, reason, ...extra });
    return { status: 'refused', stage, reason, ...extra };
  }

  async buy(url, { intent = '' } = {}) {
    this.audit.append('request', { url, intent });
    const first = await this.fetchImpl(url);
    if (first.status === 200) return { status: 'free', data: first.json };
    const pr = parsePaymentRequired(first);
    if (!pr) return this.#refuse('x402', `unexpected_status_${first.status}`);

    const me = this.guard.agent(this.account);
    if (!me) return this.#refuse('preflight', 'NotAgent');
    const req = selectRequirements(pr, { network: this.network, asset: me.record.policy.asset });
    if (!req) return this.#refuse('x402', 'no_acceptable_offer');
    const amount = BigInt(req.amount);
    this.audit.append('quote', { url, payTo: req.payTo, amount, asset: req.asset });

    const badgeIssue = await checkPayee({ resolver: this.resolver, badge: req.extra?.payeeBadge, payTo: req.payTo, required: this.requireVerifiedPayee });
    if (badgeIssue) return this.#refuse('identity', badgeIssue, { payTo: req.payTo });

    const pre = evaluate({ agent: me.record, payee: req.payTo, asset: req.asset, amount, today: dayOf(this.clock()) });
    if (!pre.ok) return this.#refuse('preflight', pre.error, { payTo: req.payTo, amount });

    let out;
    try {
      out = this.guard.authorize(this.account, { payee: req.payTo, asset: req.asset, amount, mode: 'X402', purposeHash: purposeHash(url, req) });
    } catch (e) {
      if (e instanceof GuardError) return this.#refuse('contract', e.code);
      throw e;
    }
    this.audit.append('authorized', { authId: out.id, status: out.status });
    if (out.status === 'Pending') {
      this.pending.set(String(out.id), { url, requirements: req });
      return { status: 'pending_approval', authId: out.id };
    }
    return this.#pay(out.id, url, req);
  }

  /** Continue a purchase after the owner approved it on chain. */
  async resume(authId) {
    const p = this.pending.get(String(authId));
    if (!p) return this.#refuse('resume', 'unknown_pending');
    this.pending.delete(String(authId));
    return this.#pay(authId, p.url, p.requirements);
  }

  async #pay(authId, url, requirements) {
    const auth = this.guard.authorization(authId)?.auth;
    if (!auth) return this.#refuse('pay', 'unknown_authorization', { authId });
    const wallet = this.guard.agent(this.account)?.record.wallet;
    if (!wallet) return this.#refuse('pay', 'NotAgent', { authId });
    const tx = buildAgentSignedTx({
      agentAccount: wallet, agentKey: this.agentKey, nonce: this.nonceOf(wallet),
      requirements, nowS: Math.floor(this.clock() / 1000), notAfterS: Number(auth.expiresAt / 1000n),
    });
    try {
      tx.signatures.sender[0][1] = this.cosigner.cosign({ authId, tx, resourceUrl: url, requirements });
    } catch (e) {
      if (!(e instanceof CosignRefused)) throw e;
      // Refused before commitPayment, so the authorisation was never co-signed: release its budget.
      const released = this.cosigner.release(authId);
      return this.#refuse('cosigner', e.reason, { authId, released });
    }
    // From here the authorisation is Committed on chain and its budget stays booked: the transfer
    // may be finalised even if the HTTP round-trip fails, so nothing is cancelled. Unknown
    // outcomes are logged for reconciliation against the chain (committed digest -> finalised tx).
    let res;
    let settlement;
    try {
      ({ res, settlement } = await submitPayment({ fetchImpl: this.fetchImpl, url, requirements, tx }));
    } catch (e) {
      this.audit.append('settlement_unknown', { authId, error: String(e?.message ?? e) });
      return { status: 'settlement_unknown', authId };
    }
    if (res.status !== 200 || !settlement?.success) {
      this.audit.append('settlement_unknown', { authId, httpStatus: res.status, error: res.json?.error ?? 'settlement_failed' });
      return { status: 'settlement_unknown', authId, reason: res.json?.error ?? 'settlement_failed' };
    }
    try {
      this.guard.recordSettlement(this.account, { id: authId, txHash: settlement.transaction });
    } catch (e) {
      if (!(e instanceof GuardError)) throw e;
      this.audit.append('settlement_record_failed', { authId, txHash: settlement.transaction, reason: e.code });
      return { status: 'paid_unrecorded', authId, txHash: settlement.transaction, reason: e.code, data: res.json };
    }
    this.audit.append('settled', { authId, txHash: settlement.transaction, amount: BigInt(requirements.amount), payTo: requirements.payTo });
    return { status: 'paid', authId, txHash: settlement.transaction, data: res.json };
  }
}
