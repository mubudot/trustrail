import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HostedBadgeResolver, checkPayee } from '../../../agent/src/identity/badge.mjs';
import { readState } from '../../src/state.mjs';
import { A } from '../fixtures.mjs';
import { attack, control } from '../reporter.mjs';

const badge = readState().badges.seller;
const card = readFileSync(new URL('../../agent-cards/978.json', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Registry API response fixtures; the resolver and payee check are the production modules.
export const badgeResponse = (patch = {}) => ({ badge_valid: true, card_sha256: sha256(card),
  on_chain: { status: 'Active', owner_account: A.seller, metadata_hash_hex: badge.cardSha256 }, ...patch });
export const checkBadge = (body, payTo = A.seller, badgeId = badge.tokenAddress) => checkPayee({
  resolver: new HostedBadgeResolver({ fetchImpl: async () => ({ ok: true, json: async () => body }) }),
  badge: badgeId, payTo, required: true,
});

export const badgeScenarios = [
  control('19', 'active badge with original pinned card and bound payee', async () =>
    await checkBadge(badgeResponse()) === null ? 'PASS' : 'REFUSED'),
  attack('20', 'stolen badge with attacker payTo', 'client badge check', 'payee_not_bound_to_badge', () => checkBadge(badgeResponse(), A.owner)),
  attack('21', 'nonexistent badge id', 'client badge check', 'payee_badge_invalid', () =>
    checkBadge({ badge_valid: false, on_chain: {} }, A.seller, 'nonexistent-demo-badge')),
  ...['Revoked', 'Expired'].map((status, i) => attack(String(22 + i), `${status.toLowerCase()} badge reported by registry`,
    'client badge check', 'payee_badge_revoked', () => checkBadge(badgeResponse({ on_chain: {
      status, owner_account: A.seller, metadata_hash_hex: badge.cardSha256,
    } })))),
  attack('24', 'Agent Card altered after hash pinned on chain', 'client badge check', 'payee_card_hash_mismatch', () => {
    const altered = JSON.parse(card); altered.name = 'Tampered demo agent';
    // Simulate the hosted service returning the fetched bytes' SHA-256. No decision here.
    return checkBadge(badgeResponse({ card_sha256: sha256(JSON.stringify(altered)) }));
  }),
];
