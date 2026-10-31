import { GuardError } from '../../agent/src/policy/errors.mjs';

export const attack = (id, label, layer, expected, run) => ({ id, label, layer, expected, run, kind: 'attack' });
export const control = (id, label, run) => ({ id, label, layer: 'control', expected: 'PASS', run, kind: 'control' });

export async function refusal(fn) {
  try { await fn(); return 'ACCEPTED'; }
  catch (e) {
    // Only recognised production refusals count; fixture errors must become UNEXPECTED.
    if (typeof e.reason === 'string') return e.reason;
    if (e instanceof GuardError) return e.code;
    throw e;
  }
}

export async function evaluateScenario(scenario, { propagateErrors = false } = {}) {
  let actual;
  try { actual = await scenario.run(); }
  catch (e) {
    if (propagateErrors) throw e;
    actual = `error:${e.name}`;
  }
  const { run, ...details } = scenario;
  return { ...details, actual, status: actual !== scenario.expected ? 'UNEXPECTED'
    : scenario.kind === 'attack' ? 'BLOCKED' : 'PASS' };
}

export function summary(results) {
  return { blocked: results.filter((r) => r.status === 'BLOCKED').length,
    passed: results.filter((r) => r.status === 'PASS').length,
    unexpected: results.filter((r) => r.status === 'UNEXPECTED').length };
}
