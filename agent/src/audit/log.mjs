// Hash-chained, append-only audit log (JSON lines). Each entry carries the SHA-256 of the previous
// one, so deleting or editing an entry breaks the chain. Entries link to the on-chain record
// (authorisation id, settlement tx hash) — supports EU AI Act Art. 12 style record keeping:
// what the agent was asked, what it tried, what the policy decided, who approved, what settled.
import { appendFileSync } from 'node:fs';
import { canonical, sha256Hex } from '../util/canonical.mjs';

const GENESIS = '0'.repeat(64);

export class AuditLog {
  constructor({ file = null, clock = () => Date.now() } = {}) {
    this.file = file;
    this.clock = clock;
    this.entries = [];
  }

  append(event, data = {}) {
    const prev = this.entries.at(-1)?.hash ?? GENESIS;
    const body = { seq: this.entries.length, at: new Date(this.clock()).toISOString(), event, data, prev };
    const entry = { ...body, hash: sha256Hex(canonical(body)) };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  static verify(entries) {
    let prev = GENESIS;
    for (const [i, e] of entries.entries()) {
      const { hash, ...body } = e;
      if (e.seq !== i || e.prev !== prev || sha256Hex(canonical(body)) !== hash) return { ok: false, brokenAt: i };
      prev = hash;
    }
    return { ok: true };
  }
}
