// Minimal account ledger for mock mode: balances, per-account keys + signature threshold, nonces.
// Mirrors what the x402 facilitator reads from a Concordium node (account credentials, nonce).
export class MockLedger {
  constructor() { this.accounts = new Map(); this.txs = new Map(); }

  open(address, { keys, threshold = keys.length, balance = 0n }) {
    this.accounts.set(address, { keys, threshold, balance, nonce: 1 });
  }

  account(address) { return this.accounts.get(address) ?? null; }

  /** Apply a finalised transfer (already verified). */
  apply(txHash, { from, to, amount }) {
    const a = this.accounts.get(from);
    const b = this.accounts.get(to) ?? (this.open(to, { keys: [] }), this.accounts.get(to));
    if (a.balance < amount) throw new Error('insufficient_balance');
    a.balance -= amount;
    b.balance += amount;
    a.nonce += 1;
    this.txs.set(txHash, { from, to, amount, status: 'finalized' });
  }
}
