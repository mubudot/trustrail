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
