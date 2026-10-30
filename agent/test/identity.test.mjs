import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostedBadgeResolver, checkPayee } from '../src/identity/badge.mjs';

const resolverFor = (body) => new HostedBadgeResolver({
  fetchImpl: async () => ({ ok: true, json: async () => body }),
});

test('hosted badge response binds the payee to on_chain.owner_account', async () => {
  const resolver = resolverFor({ badge_valid: true, on_chain: { status: 'Active', owner_account: 'seller-owner' } });
  assert.equal(await checkPayee({ resolver, badge: 'fixture', payTo: 'seller-owner', required: true }), null);
  assert.equal(await checkPayee({ resolver, badge: 'fixture', payTo: 'attacker', required: true }), 'payee_not_bound_to_badge');
});

test('hosted badge requires explicit active status', async () => {
  for (const status of [undefined, 'Revoked']) {
    const resolver = resolverFor({ badge_valid: true, on_chain: { status, owner_account: 'seller-owner' } });
    assert.equal(await checkPayee({ resolver, badge: 'fixture', payTo: 'seller-owner', required: true }), 'payee_badge_revoked');
  }
});

test('hosted badge resolver still accepts an explicitly supplied agent wallet', async () => {
  const resolver = resolverFor({ badge_valid: true, on_chain: { status: 'Active', owner_account: 'seller-owner', agentWallet: 'seller-wallet' } });
  assert.equal(await checkPayee({ resolver, badge: 'fixture', payTo: 'seller-wallet', required: true }), null);
});
