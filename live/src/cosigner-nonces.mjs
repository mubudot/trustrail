// Single-service wallet coordination. The optional journal contains only public reservation
// evidence, written before commitPayment. It survives restarts; it is not a shared replica lock.
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';
import { AccountAddress } from '@concordium/web-sdk';
import { CosignRefused } from './cosigner-live.mjs';
import { enumTag } from './guard-client.mjs';

const key = (r) => JSON.stringify([r.wallet, r.nonce]);
const idOK = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;

export class WalletNonces {
  constructor({ guard, file = null, scope }) {
    Object.assign(this, { guard, file, scope });
    this.locks = new Map();
    this.reservations = new Map();
    if (!file) return; // In-memory fixtures only; the service config requires a journal path.
    let saved;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw new Error('invalid_wallet_nonce_journal'); }
    // V1 has no signed transfer expiry; an authorization deadline cannot safely replace it.
    if (saved?.version === 1) throw new Error('unsupported_wallet_nonce_journal_version');
    if (saved?.version !== 2 || saved.scope !== scope || !Array.isArray(saved.reservations)) throw new Error('invalid_wallet_nonce_journal');
    for (const r of saved.reservations) {
      if (!r || typeof r.wallet !== 'string' || !idOK(r.nonce) || !idOK(r.authId) || !idOK(r.notAfterS)
        || typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest)
        || this.reservations.has(key(r))) throw new Error('invalid_wallet_nonce_journal');
      AccountAddress.fromBase58(r.wallet);
      this.reservations.set(key(r), r);
    }
  }

  run(wallet, action) {
    const run = (this.locks.get(wallet) ?? Promise.resolve()).then(action);
    const tail = run.catch(() => {});
    this.locks.set(wallet, tail);
    return run.finally(() => { if (this.locks.get(wallet) === tail) this.locks.delete(wallet); });
  }

  #save(next) {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ version: 2, scope: this.scope, reservations: [...next.values()] }) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, this.file);
    }
    this.reservations = next;
  }

  // Only node evidence or a precommit cancellation can free a nonce; failed reads retain it.
  async reconcile(wallet) {
    const outstanding = [...this.reservations.values()].filter(r => r.wallet === wallet);
    if (!outstanding.length) return;
    // The SDK's getBlockInfo() without a hash selects lastFinal, never the local/buyer clock.
    const [{ nonce, allFinal }, { blockSlotTime }] = await Promise.all([
      this.guard.grpc.getNextAccountNonce(AccountAddress.fromBase58(wallet)),
      this.guard.grpc.getBlockInfo(),
    ]);
    // The next-nonce estimate counts non-finalized transfers; only allFinal makes it consumption
    // evidence. Otherwise the reservation waits for finality or for the signed expiry.
    const nextNonce = allFinal === true ? BigInt(nonce.value ?? nonce) : null;
    const finalizedMs = blockSlotTime instanceof Date ? blockSlotTime.getTime() : NaN;
    if (!Number.isSafeInteger(finalizedMs) || finalizedMs < 0) throw new Error('invalid_finalized_block_time');
    const next = new Map(this.reservations);
    for (const r of outstanding) {
      if ((nextNonce !== null && nextNonce > BigInt(r.nonce)) || BigInt(finalizedMs) > BigInt(r.notAfterS) * 1000n) {
        next.delete(key(r));
        continue;
      }
      const view = await this.guard.authorization(BigInt(r.authId));
      // contract/src/spend.rs cancel accepts only Pending/Approved; signing requires a successful
      // commitPayment first, so a Cancelled authorization cannot have a released signature.
      // Settled is buyer-writable via recordSettlement and proves no wallet nonce consumption.
      if (view && enumTag(view.auth.status) === 'Cancelled') next.delete(key(r));
    }
    if (next.size !== this.reservations.size) this.#save(next);
  }

  // Called under the wallet lock, after all signing checks and BEFORE the chain commit.
  async reserve({ wallet, nonce, authId, digest, notAfterS }) {
    await this.reconcile(wallet);
    const r = { wallet, nonce: String(nonce), authId: String(authId), digest, notAfterS: String(notAfterS) };
    if (!idOK(r.notAfterS)) throw new Error('invalid_wallet_nonce_expiry');
    const existing = this.reservations.get(key(r));
    if (existing && (existing.authId !== r.authId || existing.digest !== digest || existing.notAfterS !== r.notAfterS)) throw new CosignRefused('wallet_nonce_in_use');
    const next = new Map(this.reservations);
    next.set(key(r), r);
    this.#save(next);
  }
}
