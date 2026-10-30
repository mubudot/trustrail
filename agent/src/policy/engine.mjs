// The spending policy, mirrored 1:1 from contract/src/policy.rs (`evaluate`). The agent runs it as
// a free, local preflight; the contract re-runs it on chain, which is what actually binds.
// Assets: 'CCD' or 'PLT:<tokenId>'. Amounts: BigInt atomic units.
export const DAY_MS = 86_400_000n;

export const dayOf = (ms) => BigInt(ms) / DAY_MS;

export function spentOn(agent, today) {
  return agent.day === today ? agent.spentToday : 0n;
}

/**
 * @returns {{ok: true, decision: 'Approve'|'NeedsApproval'} | {ok: false, error: string}}
 */
export function evaluate({ contractPaused = false, agent, payee, asset, amount, mode = 'X402', today }) {
  const fail = (error) => ({ ok: false, error });
  if (contractPaused) return fail('Paused');
  if (!agent) return fail('NotAgent');
  if (agent.paused) return fail('AgentPaused');
  if (asset !== agent.policy.asset) return fail('AssetMismatch');
  if (mode !== 'X402' && asset !== 'CCD') return fail('EscrowOnlyCcd');
  if (amount <= 0n) return fail('ZeroAmount');
  if (!agent.allowlist.includes(payee)) return fail('NotAllowlisted');
  if (amount > agent.policy.perTxCap) return fail('PerTxCap');
  const after = spentOn(agent, today) + amount;
  if (after > 0xffff_ffff_ffff_ffffn) return fail('Overflow');
  if (after > agent.policy.dailyCap) return fail('DailyCap');
  return { ok: true, decision: amount > agent.policy.approvalThreshold ? 'NeedsApproval' : 'Approve' };
}

export const MAX_ALLOWLIST = 32;
export const MIN_TTL_MS = 1_000n;
export const MAX_TTL_MS = DAY_MS;

/** Mirror of contract `validate_policy`: returns an error name or null. */
export function validatePolicy(policy, allowlist) {
  if (policy.perTxCap <= 0n || policy.dailyCap < policy.perTxCap) return 'InvalidPolicy';
  if (policy.authTtlMs < MIN_TTL_MS || policy.authTtlMs > MAX_TTL_MS) return 'InvalidPolicy';
  if (policy.asset !== 'CCD') {
    const id = policy.asset.startsWith('PLT:') ? policy.asset.slice(4) : '';
    if (id.length === 0 || id.length > 64) return 'InvalidPolicy';
  }
  if (allowlist.length > MAX_ALLOWLIST) return 'AllowlistTooLong';
  if (new Set(allowlist).size !== allowlist.length) return 'InvalidPolicy';
  return null;
}
