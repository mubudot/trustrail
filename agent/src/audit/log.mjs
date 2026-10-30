// Hash-chained, append-only audit log (JSON lines). Each entry carries the SHA-256 of the previous
// one, so deleting or editing an entry breaks the chain. Entries link to the on-chain record
// (authorisation id, settlement tx hash) — supports EU AI Act Art. 12 style record keeping:
// what the agent was asked, what it tried, what the policy decided, who approved, what settled.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { canonical, sha256Hex } from '../util/canonical.mjs';

const GENESIS = '0'.repeat(64);

export class AuditLog {
  constructor({ file = null, clock = () => Date.now() } = {}) {
    this.file = file;
    this.clock = clock;
    this.entries = [];
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (!AuditLog.verify(this.entries).ok) throw new Error('invalid_audit_log');
    }
  }

  append(event, data = {}) {
    const prev = this.entries.at(-1)?.hash ?? GENESIS;
    const body = { seq: this.entries.length, at: new Date(this.clock()).toISOString(), event, data, prev };
    // Persist and retain the same detached JSON snapshot (including BigInt atomic units).
    const entry = JSON.parse(canonical({ ...body, hash: sha256Hex(canonical(body)) }));
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
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
