// Offline by default. Importing this module never starts a network client or loads a key store.
import { scenarios } from './scenarios/index.mjs';
import { evaluateScenario, summary } from './reporter.mjs';

const args = process.argv.slice(2);
if (args.some((a) => !['--json', '--testnet'].includes(a))) {
  console.error('Usage: npm run attacks -- [--json] [--testnet]');
  process.exitCode = 1;
} else {
  const results = [];
  for (const s of args.includes('--testnet') ? [] : scenarios) {
    const result = await evaluateScenario(s);
    results.push(result);
    if (!args.includes('--json')) printResult(result);
  }
  if (args.includes('--testnet')) {
    const { testnetScenarios } = await import('./testnet.mjs');
    for (const result of await testnetScenarios()) {
      results.push(result);
      if (!args.includes('--json')) printResult(result);
    }
  }
  const counts = summary(results);
  if (args.includes('--json')) console.log(JSON.stringify({ results, summary: counts }));
  else console.log(`\n${counts.blocked} attacks BLOCKED, ${counts.passed} controls PASS, ${counts.unexpected} unexpected`);
  process.exitCode = counts.unexpected ? 1 : 0;
}

function printResult(r) {
  const label = `${r.id} ${r.label}`;
  console.log(`[${r.status}]`.padEnd(13) + label.padEnd(65, '.') + ` ${r.actual}`
    + (r.status === 'UNEXPECTED' ? ` (expected ${r.expected})` : ''));
}
