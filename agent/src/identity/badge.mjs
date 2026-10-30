// Counterparty check: before paying, the agent requires that the payee presents a valid
// "Verified by Concordium" badge (CIS-8004 agent NFT, Active, card hash matches) AND that the badge's
// payment wallet (`agentWallet`) or owner is the account being paid. A badge for someone else's
// agent does not make an arbitrary payTo trustworthy.
export const HOSTED_MCP = 'https://agent-registry-mcp.concordium.com';

/** Resolved badge facts: { valid: boolean, active: boolean, owner?: string, agentWallet?: string } */
export class FixtureBadgeResolver {
  constructor(entries = {}) { this.entries = entries; }
  async resolve(badge) { return this.entries[badge] ?? { valid: false, active: false }; }
}

/**
 * Live resolver against the hosted Agent Registry REST endpoints (no keys needed).
 * Offline tests use response fixtures; no live requests are made by the test suite.
 */
export class HostedBadgeResolver {
  constructor({ baseUrl = HOSTED_MCP, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }
  async resolve(badge) {
    const res = await this.fetch(`${this.baseUrl}/v1/check-badge/${encodeURIComponent(badge)}`);
    if (!res.ok) return { valid: false, active: false };
    const j = await res.json();
    const rec = j.on_chain ?? j.agent ?? j.record ?? j.results?.[0] ?? {};
    return {
      valid: j.badge_valid === true,
      active: rec.status === 'Active',
      owner: rec.owner_account ?? rec.owner,
      agentWallet: rec.agent_wallet ?? rec.agentWallet,
    };
  }
}

/** Returns null when the payee is acceptable, else a refusal reason. */
export async function checkPayee({ resolver, badge, payTo, required }) {
  if (!badge) return required ? 'payee_has_no_badge' : null;
  const r = await resolver.resolve(badge);
  if (!r.valid) return 'payee_badge_invalid';
  if (!r.active) return 'payee_badge_revoked';
  if (r.agentWallet !== payTo && r.owner !== payTo) return 'payee_not_bound_to_badge';
  return null;
}
