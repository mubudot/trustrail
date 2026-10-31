import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedBadgeResolver, checkPayee } from '../src/identity/badge.mjs';

const resolve = async (body) => checkPayee({
  resolver: new HostedBadgeResolver({ fetchImpl: async () => ({ ok: true, json: async () => body }) }),
  badge: 'demo-badge', payTo: 'demo-seller', required: true,
});

test('badge client refuses contradictory valid verdict when fetched card hash differs from pin', async () => {
  const base = { badge_valid: true, card_sha256: 'aa'.repeat(32),
    on_chain: { status: 'Active', owner_account: 'demo-seller', metadata_hash_hex: 'aa'.repeat(32) } };
  assert.equal(await resolve(base), null);
  assert.equal(await resolve({ ...base, card_sha256: 'bb'.repeat(32) }), 'payee_card_hash_mismatch');
});

test('badge client honours explicit card hash failure even with valid verdict and matching digests', async () => {
  assert.equal(await resolve({ badge_valid: true, card_sha256: 'aa'.repeat(32),
    on_chain: { status: 'Active', owner_account: 'demo-seller', metadata_hash_hex: 'aa'.repeat(32) },
    checks: { hash_matches_on_chain: false } }), 'payee_card_hash_mismatch');
});
