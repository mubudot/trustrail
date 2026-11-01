// Transport-independent purchasing boundary. Only the buyer pipeline can pay; the caller cannot
// approve, administer policy, replace a quote, or supply an approval record.
import { purposeHash } from '../../../agent/src/util/canonical.mjs';

const idSchema = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 20 };
export const PURCHASE_TOOLS = [
  {
    name: 'buy_resource',
    description: 'Buy an x402 resource under the configured policy. Returns purchased data and a receipt, or pending/refused. Reference URLs: https://data.example/weather and /dataset.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri', maxLength: 2048 }, intent: { type: 'string', maxLength: 2000 } }, required: ['url', 'intent'], additionalProperties: false },
  },
  {
    name: 'purchase_status', description: 'Read a purchase in this server session. An approval recorded on chain is re-verified only when resumed.',
    inputSchema: { type: 'object', properties: { authId: idSchema }, required: ['authId'], additionalProperties: false },
  },
  {
    name: 'resume_purchase', description: 'Complete a pending purchase using its original quote, only after a valid owner approval exists. Cannot supply approval or change payment details.',
    inputSchema: { type: 'object', properties: { authId: idSchema }, required: ['authId'], additionalProperties: false },
  },
];

const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_key, x) => typeof x === 'bigint' ? String(x) : x));
const tag = (v) => typeof v === 'string' ? v : Object.keys(v ?? {})[0];
const refused = (reason, authId) => ({ status: 'refused', reason, ...(authId === undefined ? {} : { authId: String(authId) }) });

function validArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'buy_resource') {
    if (Object.keys(args).some(k => !['url', 'intent'].includes(k))) return false;
    if (typeof args.url !== 'string' || args.url.length > 2048 || typeof args.intent !== 'string' || args.intent.length > 2000) return false;
    try { const u = new URL(args.url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  }
  return Object.keys(args).length === 1 && typeof args.authId === 'string'
    && /^(0|[1-9][0-9]{0,19})$/.test(args.authId) && BigInt(args.authId) <= 18446744073709551615n;
}

export class PurchaseTools {
  constructor({ agent, guard, fixture = false }) {
    Object.assign(this, { agent, guard, fixture });
    this.purchases = new Map();
    this.requests = new Map();
    this.lock = Promise.resolve();
  }

  // Serialize calls so two resumes cannot race the saved result or discard pending state.
  call(name, args) {
    const run = this.lock.then(() => this.#call(name, args));
    this.lock = run.catch(() => {});
    return run.then(jsonSafe);
  }

  async #call(name, args) {
    if (!PURCHASE_TOOLS.some(t => t.name === name)) return refused('unknown_tool');
    if (!validArgs(name, args)) return refused('invalid_arguments');
    if (name === 'buy_resource') {
      const key = JSON.stringify([args.url, args.intent]);
      const previous = this.requests.get(key);
      // Reuse the original request while pending as well as after payment, so retries cannot
      // create competing approvals or replace the cache entry for a later successful resume.
      if (previous && ['paid', 'pending'].includes(previous.result.status)) return previous.result;
      const result = await this.agent.buy(args.url, { intent: args.intent });
      const normalized = this.#normalize(result);
      if (result.authId !== undefined) {
        const pending = this.agent.pending.get(String(result.authId));
        const purchase = {
          result: normalized,
          // A private snapshot, independent of the buyer's mutable pending map.
          quote: pending ? structuredClone(pending) : null,
        };
        this.purchases.set(String(result.authId), purchase);
        this.requests.set(key, purchase);
      }
      return normalized;
    }
    const purchase = this.purchases.get(args.authId);
    if (!purchase) return refused('unknown_purchase', args.authId);
    if (purchase.result.status !== 'pending' || !purchase.quote) return purchase.result;
    const view = await this.guard.authorization(BigInt(args.authId));
    if (!view) return refused('unknown_authorization', args.authId);
    const a = view.auth;
    if (view.expired) {
      purchase.result = refused('authorization_expired', args.authId);
      return purchase.result;
    }
    const state = tag(a.status);
    if (state === 'Pending') return { status: 'pending', reason: 'owner_approval_required', authId: args.authId };
    if (state !== 'Approved') {
      purchase.result = refused(`status_${state}`, args.authId);
      return purchase.result;
    }
    if (name === 'purchase_status') return { status: 'pending', reason: 'approval_recorded_resume_to_verify', authId: args.authId };

    const q = purchase.quote;
    const pending = this.agent.pending.get(args.authId);
    const originalHash = purposeHash(q.url, q.requirements);
    if (!pending || purposeHash(pending.url, pending.requirements) !== originalHash
      || (a.purposeHash ?? a.purpose_hash) !== originalHash
      || a.payee !== q.requirements.payTo || BigInt(a.amount) !== BigInt(q.requirements.amount)) {
      purchase.result = refused('quote_binding_changed', args.authId);
      return purchase.result;
    }
    // Never fetch a new quote or accept caller-supplied payment/approval fields here.
    purchase.result = this.#normalize(await this.agent.resume(BigInt(args.authId)));
    purchase.quote = null;
    return purchase.result;
  }

  #normalize(out) {
    const authId = out.authId === undefined ? undefined : String(out.authId);
    if (['paid', 'paid_unrecorded'].includes(out.status)) {
      // The buyer already has the committed digest. No enrichment RPC may stand between
      // a confirmed payment and saving its receipt/content in the session cache.
      return { status: 'paid', reason: out.status === 'paid' ? 'payment_settled' : 'settlement_record_pending', authId,
        receipt: { transactionHash: out.txHash, digest: out.digest, fixture: this.fixture,
          ...(out.commitTx ? { commitTransactionHash: out.commitTx } : {}),
          ...(out.recordTx ? { recordTransactionHash: out.recordTx } : {}) }, data: out.data };
    }
    if (['pending_approval', 'settlement_unknown'].includes(out.status)) {
      return { status: 'pending', reason: out.status === 'pending_approval' ? 'owner_approval_required' : 'settlement_unknown_do_not_retry', authId };
    }
    // A free endpoint has no payment receipt, so it is outside this purchasing tool's contract.
    return refused(out.status === 'free' ? 'resource_does_not_require_payment' : out.reason ?? 'purchase_refused', authId);
  }
}
