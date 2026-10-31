// Schema-only adapter around the production mock guard. All decisions and state transitions
// stay in MockGuardChain; LiveCosigner receives exactly the view shape of GuardClient.
import { SequenceNumber } from '@concordium/web-sdk';
import { MockGuardChain } from '../../agent/src/chain/mock-guard.mjs';
import { purposeHash } from '../../agent/src/util/canonical.mjs';
import { newEd25519 } from '../src/keys.mjs';
import { LiveCosigner } from '../src/cosigner-live.mjs';
import { buildTransfer, signAsKey, toJSON } from '../src/x402-buyer.mjs';
import { readState } from '../src/state.mjs';
import { approval, proofChain } from './proof-chain.mjs';

const state = readState();
export const A = { owner: state.guard.owner, agent: state.guard.agent, wallet: state.guard.wallet,
  cosigner: state.guard.cosigner, seller: state.badges.seller.holder,
  facilitator: '4oLVfUMjdgtMT8GjRqWv3NfjeSxHZyKCqPpzpakdV9cureUbuu' };
export const RESOURCE = 'http://127.0.0.1:4402/dataset';
export const policy = { asset: 'CCD', perTxCap: 5_000_000n, dailyCap: 12_000_000n,
  approvalThreshold: 2_000_000n, authTtlMs: 900_000n };
const opt = (v) => v === null ? { None: [] } : { Some: [v] };
const tag = (v) => ({ [v]: [] });

export class GuardAdapter {
  constructor(chain, grpc) {
    this.chain = chain; this.grpc = grpc;
    this.address = { index: 13037n, subindex: 0n };
    this.sent = [];
  }
  async view() { return { paused: this.chain.view().paused, next_auth_id: this.chain.view().nextAuthId }; }
  async agent(address) {
    const r = this.chain.agent(address)?.record;
    if (!r) return null;
    return { record: { wallet: r.wallet, generation: r.generation, paused: r.paused, allowlist: r.allowlist,
      policy: { approval_threshold: r.policy.approvalThreshold } } };
  }
  async authorization(id) {
    const v = this.chain.authorization(id);
    if (!v) return null;
    const a = v.auth;
    return { expired: v.expired, auth: { agent: a.agent, generation: a.generation, payee: a.payee,
      amount: a.amount, asset: tag('Ccd'), mode: tag(a.mode), status: tag(a.status),
      expires_at: new Date(Number(a.expiresAt)).toISOString(), purpose_hash: a.purposeHash,
      human_proof: opt(a.humanProof), commitment: opt(a.commitment), settlement: opt(a.settlement) } };
  }
  async send(entry, value, { sender }) {
    // There is no network send here. The real mock guard enforces the transition atomically.
    if (entry === 'commitPayment') this.chain.commitPayment(sender, value);
    else if (entry === 'cancel') this.chain.cancel(sender, value);
    else throw new Error('fixture_unsupported_entry');
    this.sent.push({ entry, value });
    return { txHash: 'c0'.repeat(32) };
  }
}

export async function paymentFixture({ amount = 4_000_000n, human = true, approvalRecord = approval,
  humanProof = approval.anchorHash, registeredPolicy = policy } = {}) {
  let now = Date.now();
  const clock = () => now;
  const req = { scheme: 'exact', network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    amount: String(amount), asset: 'CCD', payTo: A.seller, maxTimeoutSeconds: 300,
    extra: { payeeBadge: state.badges.seller.tokenAddress, feePayer: A.facilitator } };
  const chain = new MockGuardChain({ owner: A.owner, cosigner: A.cosigner, clock });
  const registration = { agent: A.agent, wallet: A.wallet, policy: registeredPolicy, allowlist: [A.seller] };
  chain.registerAgent(A.owner, registration);
  // Match the public proof's auth id using legitimate earlier reservations, then cancellations.
  const request = { payee: A.seller, amount, asset: 'CCD', mode: 'X402', purposeHash: purposeHash(RESOURCE, req) };
  for (let i = 0; i < 5; i++) {
    const a = chain.authorize(A.agent, { ...request, amount: 1n });
    chain.cancel(A.agent, a.id);
  }
  const out = chain.authorize(A.agent, request);
  if (human) chain.approve(A.owner, out.id, humanProof);
  const grpc = { ...proofChain(), getNextAccountNonce: async () => ({ nonce: SequenceNumber.create(7n) }) };
  const guard = new GuardAdapter(chain, grpc);
  const keys = { agent: newEd25519(), cosigner: newEd25519() };
  const cosigner = () => new LiveCosigner({ guard, account: { address: A.cosigner, signer: null },
    walletKey: keys.cosigner.privateKey, agentPublicKey: keys.agent.publicKey,
    agentAccount: A.agent, owner: A.owner, clock, humanProofAbove: 2_000_000n,
    approvals: async () => approvalRecord });
  const cos = cosigner();
  const transaction = async (patch = {}) => toJSON(signAsKey(await buildTransfer(grpc,
    { sender: A.wallet, requirements: { ...req, ...patch } }), 0, keys.agent.privateKey));
  const input = { authId: out.id, signableJSON: await transaction(), resourceUrl: RESOURCE, requirements: req };
  return { chain, guard, keys, cos, cosigner, input, transaction, registration, request,
    advance: (ms) => { now += ms; } };
}
