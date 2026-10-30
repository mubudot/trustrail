// Canonical JSON (sorted keys, no whitespace) and SHA-256 helpers. Used for purpose hashes,
// the mock transaction digest and the audit chain, so every party hashes the same bytes.
import { createHash } from 'node:crypto';

export function canonical(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** SHA-256 of the canonical x402 PaymentRequirements + resource: the on-chain `purpose_hash`. */
export function purposeHash(resourceUrl, requirements) {
  return sha256Hex(canonical({ resource: resourceUrl, requirements }));
}
