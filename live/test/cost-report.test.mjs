import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAddress, CcdAmount, Energy, ReceiveName, TransactionHash } from '@concordium/web-sdk';
import { collectTransactions, classifyTransaction, measuredTransaction, aggregateTransactions, median,
  ratio, deriveFlows, payerLabels, renderCostReport, ccdCost, decimal, REQUEST_ANCHOR, APPROVAL_ANCHOR, COST_NOTE } from '../src/cost-report.mjs';
import { A } from './helpers.mjs';

const h = (n) => n.toString(16).padStart(64, '0');
const ref = (n, authIds = []) => ({ hash: h(n), sources: ['fixture'], authIds });
const summary = (over = {}) => ({ hash: TransactionHash.fromHexString(h(1)), sender: AccountAddress.fromBase58(A.agent),
  cost: 1_000_001n, energyCost: Energy.create(101n), transactionType: 'update',
  events: [{ receiveName: ReceiveName.fromString('agent_spend_guard.authorize') }], ...over });
const finalized = (s) => ({ status: 'finalized', outcome: { summary: s } });
const measured = (n, kind, microCcd, authIds = ['0']) => ({ ...ref(n, authIds), kind, energy: BigInt(microCcd), microCcd: BigInt(microCcd),
  outcome: 'success', sender: A.agent, charges: [{ payer: A.agent, microCcd: BigInt(microCcd) }] });

test('collects nested public transaction fields, status keys and Markdown links, deduplicating case and sources', () => {
  const documents = [
    { source: 'state.json', data: { guard: { deployTx: h(1).toUpperCase(), moduleRef: h(90) }, steps: [{ authId: '0', txHash: h(1), commitTx: h(2), anchorHash: h(91), head: h(92) }] } },
    { source: 'live/state/approvals/auth-1.json', data: { requestTx: h(3), anchorTx: h(4), request: { transactionRef: h(3) }, record: { hash: h(93) } } },
    { source: 'audit.jsonl', data: [{ hash: h(94), prev: h(95), data: { authId: '0', recordTx: h(5), txHash: h(1) } }] },
    { source: 'fixture.json', data: { statuses: { [h(3)]: { blockHash: h(96) } }, genesis: h(97) } },
    { source: 'doc.md', data: `https://ccdexplorer.io/testnet/transaction/${h(6)} https://ccdexplorer.io/mainnet/transaction/${h(98)}` },
  ];
  const refs = collectTransactions(documents);
  assert.deepEqual(refs.map((r) => r.hash), [1, 2, 3, 4, 5, 6].map(h));
  assert.deepEqual(refs[0].authIds, ['0']);
  assert.deepEqual(refs[2].authIds, ['1']);
  assert.equal(refs[0].sources.length, 3);
  assert.equal(refs[2].sources.length, 3);
});

test('invalid transaction fields fail instead of silently disappearing from the report', () => {
  assert.throws(() => collectTransactions([{ source: 'bad.json', data: { txHash: 'broken' } }]), /invalid transaction hash at bad.json:txHash/);
  assert.deepEqual(collectTransactions([{ source: 'empty.json', data: { txHash: null, cancelTx: '' } }]), []);
});

test('classifies guard entrypoints, setup, admin and rejected calls from finalized summaries', () => {
  for (const entry of ['authorize', 'approve', 'commitPayment', 'recordSettlement', 'anchorAudit']) {
    assert.equal(classifyTransaction(summary({ events: [{ receiveName: `agent_spend_guard.${entry}` }] })), entry);
  }
  assert.equal(classifyTransaction(summary({ transactionType: 'failed', failedTransactionType: 'update', events: [],
    rejectReason: { receiveName: ReceiveName.fromString('agent_spend_guard.authorize') } })), 'authorize');
  for (const [transactionType, kind] of [['deployModule', 'deploy'], ['initContract', 'init'], ['transfer', 'other']]) {
    assert.equal(classifyTransaction(summary({ transactionType, events: [] })), kind);
  }
  assert.equal(classifyTransaction(summary({ events: [{ receiveName: 'agent_spend_guard.registerAgent' }] })), 'admin');
  assert.equal(classifyTransaction(summary({ events: [{ receiveName: 'another_contract.approve' }] })), 'admin');
});

test('RegisterData anchors use the on-chain CBOR type, never a local filename or digest', () => {
  for (const [tag, kind] of [['CCDVRA', REQUEST_ANCHOR], ['CCDVAA', APPROVAL_ANCHOR], ['OTHER!', 'RegisterData (other)']]) {
    const s = summary({ transactionType: 'registerData', events: [], dataRegistered: { data: Buffer.from(`dtypef${tag}`).toString('hex') } });
    assert.equal(classifyTransaction(s), kind);
    s.dataRegistered.data = Buffer.from(`dtypef${tag}`);
    assert.equal(classifyTransaction(s), kind);
  }
});

test('only recorded or wallet-bound sponsored transfers are classified as x402 settlements', () => {
  const s = summary({ transactionType: 'transfer', events: [], sender: AccountAddress.fromBase58(A.wallet),
    sponsor: { sponsor: AccountAddress.fromBase58(A.facilitator), cost: CcdAmount.fromMicroCcd(5_628_107n) } });
  assert.equal(classifyTransaction(s, { wallet: A.wallet }), 'x402 settlement');
  assert.equal(classifyTransaction(s, { settlementHashes: [h(1)] }), 'x402 settlement');
  assert.equal(classifyTransaction(s, { wallet: A.seller }), 'other');
  assert.equal(classifyTransaction({ ...s, sponsor: undefined }, { wallet: A.wallet }), 'other');
});

test('counts sponsor fees even when sender pays zero, with exact integers above Number precision', () => {
  const tx = measuredTransaction(ref(1), finalized(summary({ cost: 0n, sponsor: {
    sponsor: AccountAddress.fromBase58(A.facilitator), cost: CcdAmount.fromMicroCcd(9_007_199_254_740_993n),
  } })));
  assert.equal(tx.energy, 101n);
  assert.equal(tx.microCcd, 9_007_199_254_740_993n);
  assert.deepEqual(tx.charges, [{ payer: A.agent, microCcd: 0n }, { payer: A.facilitator, microCcd: 9_007_199_254_740_993n }]);
  assert.equal(ccdCost(1_000_001n), '1.000001000');
  assert.equal(ccdCost(tx.microCcd), '9007199254.740993000');
});

test('missing finalization, measurements and negative costs never become zero-cost successes', () => {
  for (const status of [undefined, { status: 'committed' }, { status: 'finalized' }]) assert.throws(() => measuredTransaction(ref(1), status), /not finalized/);
  assert.throws(() => measuredTransaction(ref(1), finalized(summary({ cost: undefined }))), /missing measured/);
  assert.throws(() => measuredTransaction(ref(1), finalized(summary({ energyCost: undefined }))), /missing measured/);
  assert.throws(() => measuredTransaction(ref(1), finalized(summary({ cost: -1n }))), /negative/);
});

test('median is exact for unsorted odd, even, empty and large integer samples without mutation', () => {
  const values = [8n, 1n, 2n, 3n];
  assert.deepEqual(median(values), ratio(5n, 2n));
  assert.deepEqual(values, [8n, 1n, 2n, 3n]);
  assert.deepEqual(median([50n, 1n, 2n]), ratio(2n));
  assert.deepEqual(median([9_007_199_254_740_993n, 9_007_199_254_740_994n]), ratio(18_014_398_509_481_987n, 2n));
  assert.equal(median([]), null);
  assert.equal(ccdCost(ratio(1n, 2n)), '0.000000500');
  assert.equal(decimal(ratio(1n, 3n)), '≈0.333333');
});

test('aggregates actual charges per kind and payer, retaining failed transaction fees and zero sender fees', () => {
  const a = measuredTransaction(ref(1), finalized(summary()));
  const b = measuredTransaction(ref(2), finalized(summary({ cost: 0n, sponsor: { sponsor: A.facilitator, cost: 2n } })));
  const c = measuredTransaction(ref(3), finalized(summary({ transactionType: 'failed', failedTransactionType: 'update', cost: 3n,
    rejectReason: { tag: 'RejectedReceive', receiveName: 'agent_spend_guard.authorize' } })));
  const totals = aggregateTransactions([a, b, c]);
  assert.equal(totals.microCcd, 1_000_006n);
  assert.equal(totals.energy, 303n);
  assert.equal(totals.byKind[0].count, 3);
  assert.equal(totals.byPayer.find((p) => p.payer === A.agent).microCcd, 1_000_004n);
  assert.equal(totals.byPayer.find((p) => p.payer === A.facilitator).microCcd, 2n);
});

function flowFixture() {
  const run = { steps: [{ step: 'small', authId: '0', status: 'paid', txHash: h(3) },
    { step: 'big-pay', authId: '1', status: 'paid', txHash: h(13) }, { step: 'anchor', count: 2, txHash: h(20) }] };
  const entries = [{ event: 'settled', data: { authId: '0' } }, { event: 'paid', data: { authId: '1' } }];
  const kinds = ['authorize', 'commitPayment', 'x402 settlement', 'recordSettlement'];
  const transactions = kinds.flatMap((kind, i) => [measured(i + 1, kind, 10, ['0']), measured(i + 11, kind, 11, ['1'])]);
  transactions.push(measured(15, REQUEST_ANCHOR, 20, ['1']), measured(16, APPROVAL_ANCHOR, 30, ['1']), measured(17, 'approve', 40, ['1']), measured(20, 'anchorAudit', 9, []));
  transactions.push(measured(21, 'approve', 999, ['2']), { ...measured(22, 'authorize', 999, ['0']), outcome: 'rejected (RejectedReceive)' });
  return { run, entries, transactions };
}

test('flow formulas use successful purchase medians, exclude attacks, and amortise by covered paid purchases', () => {
  const { run, entries, transactions } = flowFixture();
  const flows = deriveFlows(transactions, run, entries);
  assert.equal(flows.batchSize, 2);
  assert.deepEqual(flows.small.microCcd, ratio(93n, 2n)); // 4 * 10.5 + 9/2
  assert.deepEqual(flows.large.microCcd, ratio(273n, 2n));
  assert.equal(flows.components.find((c) => c.kind === 'approve').count, 1);
  assert.deepEqual(flows.components.find((c) => c.kind === 'authorize').hashes, [h(1), h(11)]);
  const incomplete = deriveFlows(transactions.filter((tx) => tx.kind !== REQUEST_ANCHOR), run, entries);
  assert.deepEqual(incomplete.large.missing, [REQUEST_ANCHOR]);
  assert.ok(deriveFlows(transactions, run, []).small.missing.includes('audit batch size'));
});

test('role labels include owner/deployer sharing an account and facilitator from the offer', () => {
  const labels = payerLabels({ guard: { owner: A.owner, wallet: A.wallet, cosigner: A.cosigner } },
    { pending: { offer: { extra: { feePayer: A.facilitator } } } }, [{ kind: 'deploy', sender: A.owner }]);
  assert.deepEqual(labels[A.owner], ['owner', 'deployer']);
  assert.deepEqual(labels[A.wallet], ['agent wallet']);
  assert.deepEqual(labels[A.cosigner], ['co-signer']);
  assert.deepEqual(labels[A.facilitator], ['facilitator (sponsor)']);
});

test('Markdown states measured provenance and exact fees; EUR appears only with read parameters', () => {
  const { run, entries, transactions } = flowFixture();
  const base = { generatedAt: '2026-11-01T00:00:00.000Z', sources: ['fixture.json'], transactions,
    totals: aggregateTransactions(transactions), labels: {}, flows: deriveFlows(transactions, run, entries) };
  const md = renderCostReport(base);
  assert.ok(md.includes(COST_NOTE));
  assert.match(md, /network=testnet/);
  assert.match(md, /--write/);
  assert.match(md, /small authorisation #0/);
  assert.match(md, /batch_size = 2/);
  assert.match(md, /93\/2/);
  assert.doesNotMatch(md, /EUR estimate/);
  const rates = { readAt: 'now', blockHash: h(99), blockTime: 'now', euroPerEnergy: ratio(1n, 50_000n), microCcdPerEuro: ratio(400_000_000n) };
  const flows = deriveFlows(transactions, run, entries, rates);
  assert.deepEqual(flows.small.eur, ratio(93n, 100_000n));
  assert.deepEqual(flows.small.currentMicroCcd, ratio(372_000n));
  assert.match(renderCostReport({ ...base, flows, rates }), /EUR estimate from testnet parameters/);
  assert.match(renderCostReport({ ...base, errors: [{ hash: h(99), error: 'not finalized' }] }), /Incomplete reads — no generated file written/);
});
