import { CosignRefused } from './cosigner-live.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex = (v, size) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(v);

// Transport failure is deliberately distinct from a deterministic refusal: a commit may already
// have finalized. The buyer must reconcile, never assume it is safe to cancel/retry.
export class CosignerUnavailable extends Error {
  constructor() { super('cosigner_outcome_unknown'); }
}

export class CosignerClient {
  constructor({ url, token, fetchImpl = fetch, timeoutMs = 120_000 }) {
    const base = new URL(url);
    if (base.username || base.password || base.search || base.hash
      || !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('cosigner URL requires HTTPS or loopback HTTP');
    }
    if (typeof token !== 'string' || token.length < 32) throw new Error('cosigner bearer token must have at least 32 characters');
    Object.assign(this, { url: base.href.replace(/\/$/, ''), token, fetchImpl, timeoutMs });
  }

  async #request(endpoint, input) {
    let response, out;
    try {
      response = await this.fetchImpl(`${this.url}/${endpoint}`, { method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input, (_k, v) => typeof v === 'bigint' ? String(v) : v),
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      out = await response.json();
    } catch { throw new CosignerUnavailable(); }
    if (!object(out)) throw new CosignerUnavailable();
    if (response.status === 401) {
      if (out.authId === null && out.status === 'refused' && out.reason === 'unauthenticated') throw new CosignRefused('unauthenticated');
      throw new CosignerUnavailable();
    }
    if (out.authId !== String(input.authId)) throw new CosignerUnavailable();
    if (response.status === 422 && out.status === 'refused' && typeof out.reason === 'string' && out.reason.trim()) throw new CosignRefused(out.reason);
    if (!response.ok) throw new CosignerUnavailable();
    return out;
  }

  async cosignWithReceipt(input) {
    const out = await this.#request('cosign', input);
    if (out.status !== 'signed' || !hex(out.signature, 128) || !object(out.receipt)
      || !hex(out.receipt.commitTx, 64) || !hex(out.receipt.digest, 64)) throw new CosignerUnavailable();
    return { signature: out.signature, commitTx: out.receipt.commitTx, digest: out.receipt.digest };
  }

  async cosign(input) {
    this.lastCommitTx = null;
    const out = await this.cosignWithReceipt(input);
    this.lastCommitTx = out.commitTx;
    return out.signature;
  }

  async releaseWithReceipt(authId) {
    const out = await this.#request('release', { authId });
    if (out.status !== 'released' || typeof out.released !== 'boolean' || !object(out.receipt)
      || (out.released ? !hex(out.receipt.cancelTx, 64) : out.receipt.cancelTx !== null)) throw new CosignerUnavailable();
    return { released: out.released, cancelTx: out.receipt.cancelTx };
  }

  async release(authId) {
    this.lastCancelTx = null;
    try {
      const out = await this.releaseWithReceipt(authId);
      this.lastCancelTx = out.cancelTx;
      return out.released;
    } catch (e) {
      if (e instanceof CosignRefused || e instanceof CosignerUnavailable) return false;
      throw e;
    }
  }
}
