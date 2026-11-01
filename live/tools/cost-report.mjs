// Read-only node queries; --write writes docs/COSTS.md locally. No signer or secret imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockHash, TransactionHash } from '@concordium/web-sdk';
import { readOnlyTestnetClient, TESTNET, withRetry } from '../src/net.mjs';
import { collectTransactions, measuredTransaction, payerLabels, ratio, aggregateTransactions, deriveFlows, renderCostReport } from '../src/cost-report.mjs';

const args = process.argv.slice(2);
if (args.some((a) => !['--json', '--write', '--help'].includes(a))) throw new Error('usage: npm run costs -- [--json] [--write]');
if (args.includes('--help')) {
  console.log('npm run costs -- [--json] [--write]\nReads public state, captured fixtures and Markdown explorer links; queries finalized testnet costs.\nNo keys or transactions. --write writes local docs/COSTS.md only (all transactions must resolve).');
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const documents = [];
  const read = (relative) => {
    const content = fs.readFileSync(path.join(root, relative), 'utf8');
    const data = relative.endsWith('.jsonl') ? content.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : relative.endsWith('.json') ? JSON.parse(content) : content;
    documents.push({ source: relative, data });
  };
  const scan = (dir, extensions) => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${dir}/${entry.name}`;
      if (entry.name.startsWith('.') || entry.name.endsWith('.local.json') || relative === 'docs/COSTS.md') continue;
      if (entry.isDirectory()) scan(relative, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) read(relative); // never follow symlinks
    }
  };
  scan('live/state', ['.json', '.jsonl']);
  scan('live/attacks/fixtures', ['.json']);
  scan('docs', ['.md']);
  for (const file of ['README.md', 'DESIGN.md', 'STATUS.md']) if (fs.existsSync(path.join(root, file))) read(file);
  const refs = collectTransactions(documents);
  if (!refs.length) throw new Error('no recorded transactions found');
  const state = documents.find((d) => d.source === 'live/state/testnet.json')?.data ?? {};
  const run = documents.find((d) => d.source === 'live/state/run.json')?.data ?? {};
  const entries = documents.find((d) => d.source === 'live/state/audit.jsonl')?.data ?? [];
  const grpc = readOnlyTestnetClient();
  const consensus = await grpc.getConsensusStatus();
  const genesis = BlockHash.toHexString(consensus.genesisBlock);
  if (!genesis.startsWith(TESTNET.x402Network.slice(4))) throw new Error('refusing_non_testnet');
  const transactions = []; const errors = [];
  // Four independent reads at a time; never send, sign or wait for a transaction.
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      try {
        const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(ref.hash));
        transactions.push(measuredTransaction(ref, status, { wallet: state.guard?.wallet,
          settlementHashes: (run.steps ?? []).filter((s) => s.status === 'paid').map((s) => s.txHash) }));
      } catch (e) { errors.push({ hash: ref.hash, error: String(e?.message ?? e) }); }
    }
  }));
  transactions.sort((a, b) => a.hash.localeCompare(b.hash));
  errors.sort((a, b) => a.hash.localeCompare(b.hash));
  let rates;
  try {
    const blockHash = consensus.lastFinalizedBlock;
    const [parameters, block] = await Promise.all([withRetry(() => grpc.getBlockChainParameters(blockHash)), grpc.getBlockInfo(blockHash)]);
    const rate = (r) => ratio(BigInt(r.numerator), BigInt(r.denominator));
    rates = { readAt: new Date().toISOString(), blockHash: BlockHash.toHexString(blockHash), blockTime: block.blockSlotTime.toISOString(),
      euroPerEnergy: rate(parameters.euroPerEnergy), microCcdPerEuro: rate(parameters.microGTUPerEuro) };
  } catch (e) { console.error(`Chain parameters unavailable; omitting EUR estimates: ${e.message}`); }
  const report = { generatedAt: new Date().toISOString(), network: 'testnet', genesis,
    sources: documents.filter((d) => refs.some((ref) => ref.sources.some((s) => s.startsWith(`${d.source}:`)))).map((d) => d.source),
    transactions, errors, labels: payerLabels(state, run, transactions), totals: aggregateTransactions(transactions),
    flows: deriveFlows(transactions, run, entries, rates), ...(rates ? { rates } : {}) };
  const markdown = renderCostReport(report);
  if (args.includes('--write')) {
    if (errors.length) console.error('Incomplete transaction reads; docs/COSTS.md was not written.');
    else fs.writeFileSync(path.join(root, 'docs/COSTS.md'), markdown);
  }
  console.log(args.includes('--json') ? JSON.stringify(report, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) : markdown);
  process.exitCode = errors.length ? 1 : 0;
}
