// In-memory stand-in for the deployed agent_spend_guard contract, with the same entrypoints,
// error names and state transitions as contract/src/{admin,spend,views}.rs. Used for the mock
// demo and the client tests; a live testnet adapter (planned, @concordium/web-sdk) will expose the same API.
import { evaluate, dayOf, spentOn } from '../policy/engine.mjs';
import { GuardError } from '../policy/errors.mjs';

const SETTLE_GRACE_MS = 10n * 60_000n;

export class MockGuardChain {
  /** @param {{owner: string, cosigner?: string, clock?: () => number, escrowBalance?: bigint}} opts */
  constructor({ owner, cosigner = null, clock = () => Date.now(), escrowBalance = 0n }) {
    this.owner = owner;
    this.cosigner = cosigner;
    this.clock = clock;
    this.paused = false;
    this.agents = new Map();
    this.generations = new Map();
    this.auths = new Map();
    this.nextAuthId = 0n;
    this.escrowBalance = escrowBalance;
    this.escrowReserved = 0n;
    this.events = []; // audit trail, like contract events
    this.transfers = []; // escrow payouts
  }

  #now() { return BigInt(this.clock()); }
  #emit(type, data) { this.events.push({ type, at: Number(this.#now()), ...data }); }
  #owner(sender) { if (sender !== this.owner) throw new GuardError('NotOwner'); }
  #auth(id) {
    const a = this.auths.get(BigInt(id));
    if (!a) throw new GuardError('UnknownAuthorization');
    return a;
  }
  #release(auth) {
    const rec = this.agents.get(auth.agent);
    if (rec && rec.generation === auth.generation && rec.day === auth.day) {
      rec.spentToday -= auth.amount;
      rec.total -= auth.amount;
    }
  }

  // ----------------------------------------------------------------- owner administration
  registerAgent(sender, { agent, badge = null, policy, allowlist }) {
    this.#owner(sender);
    if (this.agents.has(agent)) throw new GuardError('AlreadyRegistered');
    if (policy.perTxCap <= 0n || policy.dailyCap < policy.perTxCap) throw new GuardError('InvalidPolicy');
    if (new Set(allowlist).size !== allowlist.length) throw new GuardError('InvalidPolicy');
    if (allowlist.length > 32) throw new GuardError('AllowlistTooLong');
    const generation = (this.generations.get(agent) ?? 0n) + 1n;
    this.generations.set(agent, generation);
    this.agents.set(agent, {
      badge, policy: { ...policy }, allowlist: [...allowlist], paused: false, generation,
      day: dayOf(this.#now()), spentToday: 0n, total: 0n,
    });
    this.#emit('AgentRegistered', { agent, generation, badge });
  }

  setAllowlist(sender, { agent, allowlist }) {
    this.#owner(sender);
    const rec = this.agents.get(agent);
    if (!rec) throw new GuardError('NotAgent');
    rec.allowlist = [...allowlist];
    this.#emit('AllowlistUpdated', { agent, allowlist });
  }

  setAgentPaused(sender, { agent, paused }) {
    const rec = this.agents.get(agent);
    if (!rec) throw new GuardError('NotAgent');
    if (!(sender === this.owner || (sender === agent && paused))) throw new GuardError('NotOwner');
    rec.paused = paused;
    this.#emit('AgentPausedSet', { agent, paused });
  }

  setPaused(sender, paused) {
    this.#owner(sender);
    this.paused = paused;
    this.#emit('ContractPausedSet', { paused });
  }

  // ----------------------------------------------------------------- spending flow
  authorize(sender, { payee, asset, amount, mode = 'X402', purposeHash }) {
    const now = this.#now();
    const today = dayOf(now);
    const rec = this.agents.get(sender);
    const r = evaluate({ contractPaused: this.paused, agent: rec, payee, asset, amount, mode, today });
    if (!r.ok) throw new GuardError(r.error);
    if (mode === 'Escrow' && this.escrowBalance - this.escrowReserved < amount) {
      throw new GuardError('InsufficientFunds');
    }
    const status = r.decision === 'NeedsApproval' ? 'Pending' : mode === 'Escrow' ? 'Settled' : 'Approved';
    rec.spentToday = spentOn(rec, today) + amount;
    rec.day = today;
    rec.total += amount;
    const id = this.nextAuthId++;
    const auth = {
      id, agent: sender, generation: rec.generation, payee, asset, amount, mode, purposeHash,
      status, createdAt: now, expiresAt: now + rec.policy.authTtlMs, day: today, settlement: null,
    };
    this.auths.set(id, auth);
    if (status === 'Pending' && mode === 'Escrow') this.escrowReserved += amount;
    this.#emit(status === 'Pending' ? 'PendingApproval' : 'Authorized', { id, agent: sender, payee, amount, mode, purposeHash });
    if (status === 'Settled') this.#payEscrow(auth);
    return { id, status, expiresAt: auth.expiresAt };
  }

  approve(sender, id) {
    this.#owner(sender);
    if (this.paused) throw new GuardError('Paused');
    const auth = this.#auth(id);
    if (auth.status !== 'Pending') throw new GuardError('WrongStatus');
    if (this.#now() >= auth.expiresAt) throw new GuardError('Expired');
    const rec = this.agents.get(auth.agent);
    if (!rec || rec.generation !== auth.generation) throw new GuardError('StaleGeneration');
    if (rec.paused) throw new GuardError('AgentPaused');
    if (!rec.allowlist.includes(auth.payee)) throw new GuardError('NotAllowlisted');
    if (auth.mode === 'Escrow') {
      this.escrowReserved -= auth.amount;
      auth.status = 'Settled';
      this.#emit('Approved', { id: auth.id });
      this.#payEscrow(auth);
    } else {
      auth.status = 'Approved';
      this.#emit('Approved', { id: auth.id });
    }
  }

  reject(sender, id) {
    this.#owner(sender);
    const auth = this.#auth(id);
    if (auth.status !== 'Pending') throw new GuardError('WrongStatus');
    auth.status = 'Rejected';
    if (auth.mode === 'Escrow') this.escrowReserved -= auth.amount;
    this.#release(auth);
    this.#emit('Rejected', { id: auth.id });
  }

  cancel(sender, id) {
    const auth = this.#auth(id);
    if (sender !== this.owner && sender !== auth.agent) throw new GuardError('NotPermitted');
    if (auth.status !== 'Pending' && auth.status !== 'Approved') throw new GuardError('WrongStatus');
    if (auth.status === 'Pending' && auth.mode === 'Escrow') this.escrowReserved -= auth.amount;
    auth.status = 'Cancelled';
    this.#release(auth);
    this.#emit('Cancelled', { id: auth.id, by: sender });
  }

  recordSettlement(sender, { id, txHash }) {
    const auth = this.#auth(id);
    if (sender !== auth.agent && sender !== this.cosigner) throw new GuardError('NotPermitted');
    if (auth.mode !== 'X402' || auth.status !== 'Approved') throw new GuardError('WrongStatus');
    if (this.#now() >= auth.expiresAt + SETTLE_GRACE_MS) throw new GuardError('Expired');
    if (this.agents.get(auth.agent)?.generation !== auth.generation) throw new GuardError('StaleGeneration');
    auth.status = 'Settled';
    auth.settlement = txHash;
    this.#emit('Settled', { id: auth.id, txHash });
  }

  #payEscrow(auth) {
    this.escrowBalance -= auth.amount;
    this.transfers.push({ to: auth.payee, amount: auth.amount, authId: auth.id });
    this.#emit('Settled', { id: auth.id, txHash: null });
  }

  // ----------------------------------------------------------------- views
  agent(address) {
    const rec = this.agents.get(address);
    if (!rec) return null;
    return { record: structuredClone(rec), spentTodayNow: spentOn(rec, dayOf(this.#now())) };
  }

  authorization(id) {
    const a = this.auths.get(BigInt(id));
    if (!a) return null;
    const open = a.status === 'Pending' || a.status === 'Approved';
    return { auth: { ...a }, expired: open && this.#now() >= a.expiresAt };
  }

  view() {
    return { owner: this.owner, cosigner: this.cosigner, paused: this.paused, nextAuthId: this.nextAuthId };
  }
}
