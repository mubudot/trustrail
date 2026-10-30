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
    const tx = buildAgentSignedTx({
      agentAccount: this.account, agentKey: this.agentKey, nonce: this.nonceOf(this.account),
      requirements, nowS: Math.floor(this.clock() / 1000), notAfterS: Number(auth.expiresAt / 1000n),
    });
    try {
      tx.signatures.sender[0][1] = this.cosigner.cosign({ authId, tx, resourceUrl: url, requirements });
    } catch (e) {
      if (!(e instanceof CosignRefused)) throw e;
      this.guard.cancel(this.account, authId);
      return this.#refuse('cosigner', e.reason, { authId });
    }
    const { res, settlement } = await submitPayment({ fetchImpl: this.fetchImpl, url, requirements, tx });
    if (res.status !== 200 || !settlement?.success) {
      this.guard.cancel(this.account, authId);
      return this.#refuse('facilitator', res.json?.error ?? 'settlement_failed', { authId });
    }
    this.guard.recordSettlement(this.account, { id: authId, txHash: settlement.transaction });
    this.audit.append('settled', { authId, txHash: settlement.transaction, amount: BigInt(requirements.amount), payTo: requirements.payTo });
    return { status: 'paid', authId, txHash: settlement.transaction, data: res.json };
  }
}
