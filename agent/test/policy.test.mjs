// The JS preflight must agree with the contract on every shared vector (spec/policy_vectors.json,
// also run by contract/src/unit_tests.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/policy/engine.mjs';
import { ERRORS, codeOf, nameOf } from '../src/policy/errors.mjs';

const doc = JSON.parse(readFileSync(new URL('../../spec/policy_vectors.json', import.meta.url)));
const acct = (i) => `acct-${i}`;
const asset = (s) => s ?? 'CCD';

test('shared policy vectors', () => {
  for (const v of doc.vectors) {
    const a = { ...doc.base_agent, ...(v.agent_patch ?? {}) };
    const agent = v.agent === null ? null : {
      paused: a.paused, allowlist: a.allowlist.map(acct), day: BigInt(a.day), spentToday: BigInt(a.spent_today),
      policy: { asset: a.asset, perTxCap: BigInt(a.per_tx_cap), dailyCap: BigInt(a.daily_cap), approvalThreshold: BigInt(a.approval_threshold) },
    };
    const r = evaluate({
      contractPaused: v.contract_paused ?? false, agent, payee: acct(v.payee), asset: asset(v.asset),
      amount: BigInt(v.amount), mode: v.mode ?? 'X402', today: BigInt(v.today ?? 10),
    });
    assert.equal(r.ok ? r.decision : r.error, v.expect, v.name);
  }
});

test('error codes match the contract enum order', () => {
  assert.equal(codeOf('ParseParams'), -1);
  assert.equal(codeOf('NotOwner'), -4);
  assert.equal(codeOf('ContractSender'), -29);
  assert.equal(nameOf(-12), 'DailyCap');
  assert.equal(ERRORS.length, 29);
});
