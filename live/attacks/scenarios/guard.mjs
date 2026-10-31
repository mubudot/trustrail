import assert from 'node:assert/strict';
import { paymentFixture, A } from '../fixtures.mjs';
import { attack, refusal } from '../reporter.mjs';

export const guardScenarios = [
  ...[
    ['25', 'skip client checks: over per-tx cap', 'PerTxCap', (s) => s.chain.authorize(A.agent, { ...s.request, amount: 5_000_001n })],
    ['26', 'skip client checks: over daily cap', 'DailyCap', (s) => {
      s.chain.authorize(A.agent, s.request); s.chain.authorize(A.agent, s.request);
      s.chain.authorize(A.agent, { ...s.request, amount: 1n });
    }],
    ['27', 'skip client checks: payee not allowlisted', 'NotAllowlisted', (s) => s.chain.authorize(A.agent, { ...s.request, payee: A.owner })],
    ['28', 'replace committed digest', 'WrongStatus', (s) => s.chain.commitPayment(A.cosigner, { id: 5n, digest: 'ee'.repeat(32) })],
    ['29', 'approve committed authorisation again', 'WrongStatus', (s) => s.chain.approve(A.owner, 5n, 'aa'.repeat(32))],
    ['30', 'cancel committed auth to reclaim budget', 'WrongStatus', (s) => s.chain.cancel(A.owner, 5n)],
  ].map(([id, label, reason, action]) => attack(id, label, 'mock guard (contract mirror)', reason, async () => {
    const s = await paymentFixture();
    if (Number(id) >= 28) await s.cos.cosign(s.input);
    const before = s.chain.authorization(5n).auth;
    const result = await refusal(() => action(s));
    assert.deepEqual(s.chain.authorization(5n).auth, before);
    return result;
  })),
];
