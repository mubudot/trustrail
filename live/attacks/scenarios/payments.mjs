import assert from 'node:assert/strict';
import { paymentFixture, policy, A } from '../fixtures.mjs';
import { attack, control, refusal } from '../reporter.mjs';

export const paymentScenarios = [
  control('07', 'legitimate 0.5 CCD auto-approved payment co-signed', async () => {
    const s = await paymentFixture({ amount: 500_000n, human: false });
    assert.match(await s.cos.cosign(s.input), /^[0-9a-f]{128}$/);
    return 'PASS';
  }),
  ...[['08', 'payee', { payTo: A.owner }, 'tx_payee_mismatch'],
    ['09', 'amount', { amount: '4000001' }, 'tx_amount_mismatch']].map(([id, label, patch, reason]) =>
    attack(id, `transfer changes approved ${label}`, 'co-signer', reason, async () => {
      const s = await paymentFixture();
      const result = await refusal(async () => s.cos.cosign({ ...s.input, signableJSON: await s.transaction(patch) }));
      assert.equal(s.guard.sent.length, 0);
      return result;
    })),
  ...[
    ['10', 'owner pauses agent after approval', 'agent_paused', (s) => s.chain.setAgentPaused(A.owner, { agent: A.agent, paused: true })],
    ['11', 'owner pauses guard after approval', 'guard_paused', (s) => s.chain.setPaused(A.owner, true)],
    ['12', 'owner re-registers agent after approval', 'stale_generation', (s) => {
      s.chain.removeAgent(A.owner, A.agent); s.chain.registerAgent(A.owner, s.registration);
    }],
    ['13', 'payee removed from allowlist after approval', 'payee_not_allowlisted', (s) => s.chain.setAllowlist(A.owner, { agent: A.agent, allowlist: [] })],
    ['14', 'approval expires at its TTL boundary', 'authorization_expired', (s) => s.advance(900_000)],
  ].map(([id, label, reason, change]) => attack(id, label, 'co-signer', reason, async () => {
    const s = await paymentFixture(); change(s);
    const result = await refusal(() => s.cos.cosign(s.input));
    assert.equal(s.chain.authorization(5n).auth.commitment, null);
    return result;
  })),
  attack('15', 'transfer expiry exceeds authorisation TTL', 'co-signer', 'tx_outlives_authorization', async () => {
    const s = await paymentFixture({ registeredPolicy: { ...policy, authTtlMs: 60_000n } });
    return refusal(() => s.cos.cosign(s.input));
  }),
  ...[['16', false], ['17', true]].map(([id, restart]) =>
    attack(id, `double co-sign${restart ? ' across co-signer restart' : ''}`, 'co-signer + mock guard', 'status_Committed', async () => {
      const s = await paymentFixture();
      await s.cos.cosign(s.input);
      const result = await refusal(() => (restart ? s.cosigner() : s.cos).cosign(s.input));
      assert.equal(s.guard.sent.length, 1);
      assert.equal(s.chain.agent(A.agent).spentTodayNow, 4_000_000n);
      return result;
    })),
  attack('18', 'owner raises threshold to bypass human', 'co-signer', 'human_approval_missing_pinned_threshold', async () => {
    // Register with the resulting owner policy (the mock has no updatePolicy entrypoint).
    const s = await paymentFixture({ human: false, registeredPolicy: { ...policy, approvalThreshold: 10_000_000n } });
    const result = await refusal(() => s.cos.cosign(s.input));
    assert.equal(s.guard.sent.length, 0);
    return result;
  }),
  attack('35', 'two co-signer replicas race to consume one approval', 'co-signer + mock guard', 'commit_WrongStatus', async () => {
    const s = await paymentFixture();
    const results = await Promise.allSettled([s.cos.cosign(s.input), s.cosigner().cosign(s.input)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(s.guard.sent.length, 1);
    assert.equal(s.chain.agent(A.agent).spentTodayNow, 4_000_000n);
    return results.find((r) => r.status === 'rejected').reason.reason;
  }),
];
