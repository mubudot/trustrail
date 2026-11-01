import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scenarios } from '../attacks/scenarios/index.mjs';
import { evaluateScenario } from '../attacks/reporter.mjs';
import { assertTestnet, testnetScenarios } from '../attacks/testnet.mjs';
import { TESTNET_GENESIS } from '../attacks/proof-chain.mjs';
import { BlockHash } from '@concordium/web-sdk';

for (const scenario of scenarios) {
  test(`attack suite ${scenario.id}: ${scenario.label}`, async () => {
    const result = await evaluateScenario(scenario);
    assert.equal(result.actual, scenario.expected);
    assert.equal(result.status, scenario.kind === 'attack' ? 'BLOCKED' : 'PASS');
  });
}

test('attack CLI succeeds offline, emits only JSON with --json, and reports every scenario', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--import', new URL('./offline-only.mjs', import.meta.url).href,
      new URL('../attacks/run.mjs', import.meta.url).pathname, '--json'], { timeout: 180_000 });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.results.length, scenarios.length);
  assert.equal(result.summary.unexpected, 0);
  assert.equal(result.summary.blocked, scenarios.filter((s) => s.kind === 'attack').length);
  assert.equal(result.summary.passed, scenarios.filter((s) => s.kind === 'control').length);
});

test('read-only testnet checks hard-refuse a different genesis or network before reading deployment', () => {
  assert.doesNotThrow(() => assertTestnet(TESTNET_GENESIS));
  assert.throws(() => assertTestnet('00'.repeat(32)), { message: 'refusing_non_testnet' });
  assert.throws(() => assertTestnet(TESTNET_GENESIS, 'ccd:other'), { message: 'refusing_non_testnet' });
});

test('testnet workflow refuses another genesis without reading guard state', async () => {
  let reads = 0;
  const results = await testnetScenarios({ grpc: {
    getConsensusStatus: async () => ({ genesisBlock: BlockHash.fromHexString('00'.repeat(32)) }),
    invokeContract: async () => { reads++; throw new Error('must not read wrong network'); },
  } });
  assert.equal(reads, 0);
  assert.equal(results[0].status, 'UNEXPECTED');
  assert.equal(results[0].actual, 'refusing_non_testnet');
});

test('unreachable testnet node is SKIPPED without touching the guard', async () => {
  for (const code of ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 4, 14]) {
    const results = await testnetScenarios({ grpc: {
      getConsensusStatus: async () => { const error = new Error('offline'); error.code = code; throw error; },
    } });
    assert.equal(results[0].status, 'SKIPPED');
    assert.equal(results[0].actual, 'testnet_node_unreachable');
  }
});
