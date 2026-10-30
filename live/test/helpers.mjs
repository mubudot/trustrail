// Offline fixtures for the live adapters: fake gRPC nonce source, fake guard, test accounts.
import { SequenceNumber } from '@concordium/web-sdk';
import { newEd25519 } from '../src/keys.mjs';

// Real-format testnet addresses (from live/state/testnet.json; any valid base58 works offline).
export const A = {
  owner: '4quNUwSZDXiz2zb6jGQ8ytj6UX3ASqwyoBt4owTc5k9h6mMnMU',
  agent: '2ysDtPL5obhzoKQgys9uYqWo9wb4CZ182k5xEGHUVsVpdZm62W',
  wallet: '44e2e4v332fXTACRszqVBwJRg2SuhTLAaBQ5iPPcK7N7XH8doo',
  cosigner: '4p8CXk9yRxQT2w6KTREEB9Au6htSbUMV2yAE6zh4pcM94nshVG',
  seller: '3joCzai3rDHSPbqH6FnsDs4ZwCiVcErjdpRvdEavojrzu2Pn7H',
  facilitator: '4oLVfUMjdgtMT8GjRqWv3NfjeSxHZyKCqPpzpakdV9cureUbuu',
};

export const fakeGrpc = { getNextAccountNonce: async () => ({ nonce: SequenceNumber.create(7n) }) };

export const requirements = (amount = '4000000') => ({
  scheme: 'exact', network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27', amount, asset: 'CCD', payTo: A.seller,
  maxTimeoutSeconds: 300, extra: { payeeBadge: 'JyP9XrG4oGaYgXpdugBc5', feePayer: A.facilitator },
});

export function walletKeys() { return { agent: newEd25519(), cosigner: newEd25519() }; }

/** Minimal stand-in for GuardClient with schema-JSON-shaped views. */
export class FakeGuard {
  constructor({ auth, record, paused = false }) {
    this.address = { index: 13037n, subindex: 0n };
    this.grpc = {};
    this._auth = auth; this._record = record; this._paused = paused; this.sent = [];
  }
  async authorization() { return this._auth ? { auth: this._auth, expired: false } : null; }
  async agent() { return this._record ? { record: this._record, spent_today_now: 0n } : null; }
  async view() { return { paused: this._paused }; }
  async send(entry, value) {
    this.sent.push({ entry, value });
    if (this.failCommit && entry === 'commitPayment') { const e = new Error('rejected'); e.code = -21; throw e; }
    return { txHash: 'c0'.repeat(32) };
  }
}

export function record(over = {}) {
  return {
    wallet: A.wallet, allowlist: [A.seller], paused: false, generation: 1n, day: 0n, spent_today: 0n,
    policy: { asset: { Ccd: [] }, per_tx_cap: 5_000_000n, daily_cap: 12_000_000n, approval_threshold: 2_000_000n, auth_ttl_ms: 900_000n },
    ...over,
  };
}

export function auth(over = {}) {
  return {
    agent: A.agent, generation: 1n, payee: A.seller, asset: { Ccd: [] }, amount: 4_000_000n, mode: { X402: [] },
    purpose_hash: '00'.repeat(32), status: { Approved: [] }, expires_at: new Date(Date.now() + 600_000).toISOString(),
    human_proof: { Some: ['11'.repeat(32)] }, commitment: { None: [] }, settlement: { None: [] },
    ...over,
  };
}
