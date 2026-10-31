import test from 'node:test';
import assert from 'node:assert/strict';
import { TransactionHash } from '@concordium/web-sdk';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { renderAuditReport, resolveTxInfo, entryTxs, groupUses, useOutcome, useApproval, uniqueTxs, ccd, cell } from '../src/audit-report.mjs';
import { A } from './helpers.mjs';

const h = (i) => i.toString(16).padStart(64, '0');
const EXPLORER = 'https://ccdexplorer.io/testnet/transaction/';

function sampleLog() {
  const log = new AuditLog({ clock: () => Date.UTC(2026, 9, 30, 18, 50) });
  log.append('request', { intent: 'check the weather', url: 'http://127.0.0.1:4402/weather' });
  log.append('quote', { amount: '500000', asset: 'CCD', badge: 'JyP9XrG4oGaYgXpdugBc5', payTo: A.seller, url: 'http://127.0.0.1:4402/weather' });
  log.append('authorized', { authId: '0', status: 'Approved', txHash: h(1) });
  log.append('cosigned', { authId: '0', commitTx: h(2) });
  log.append('paid', { authId: '0', amount: '500000', payTo: A.seller, txHash: h(3) });
  log.append('settled', { authId: '0', recordTx: h(4), txHash: h(3) });
  log.append('request', { intent: 'buy a | piped dataset', url: 'http://127.0.0.1:4402/dataset' });
  log.append('quote', { amount: '4000000', asset: 'CCD', badge: 'JyP9XrG4oGaYgXpdugBc5', payTo: A.seller, url: 'http://127.0.0.1:4402/dataset' });
  log.append('authorized', { authId: '1', status: 'Pending', txHash: h(5) });
  log.append('human_approved', { authId: '1', requestTx: h(6), anchorTx: h(7), approveTx: h(8), anchorHash: h(99) });
  log.append('request', { intent: 'export everything', url: 'http://127.0.0.1:4402/bulk' });
  log.append('refused', { amount: '9000000', payTo: A.seller, reason: 'PerTxCap', stage: 'preflight' });
  return log.entries;
}
const state = {
  guard: { address: { index: '13037', subindex: '0' }, owner: A.owner, agent: A.agent, cosigner: A.cosigner, policy: { approval_threshold: '2000000' } },
};
const runFor = (entries) => ({ steps: [
  { step: 'hijacked', txHash: h(20) },
  { step: 'anchor', head: entries.at(-1).hash, count: entries.length, txHash: h(21) },
] });

test('ccd() formats microCCD exactly, and cell() escapes table syntax', () => {
  assert.equal(ccd('500000'), '0.5 CCD');
  assert.equal(ccd('4000000'), '4 CCD');
  assert.equal(ccd('1'), '0.000001 CCD');
  assert.equal(ccd('12345678'), '12.345678 CCD');
  assert.equal(cell('a|b\nc'), 'a\\|b c');
});

test('every transaction-hash field of an entry gets a labelled CCDExplorer link', () => {
  const e = { event: 'human_approved', data: { authId: '1', requestTx: h(6), anchorTx: h(7), approveTx: h(8), anchorHash: h(99) } };
  assert.deepEqual(entryTxs(e).map((t) => [t.field, t.label]).sort(), [['anchorTx', 'approval record anchor'], ['approveTx', 'approve(id, proof)'], ['requestTx', 'verification request anchor']]);
  const md = renderAuditReport({ entries: sampleLog(), chain: { ok: true }, state, run: runFor(sampleLog()) });
  for (let i = 1; i <= 8; i++) assert.ok(md.includes(`${EXPLORER}${h(i)}`), `tx ${i} linked`);
  assert.ok(md.includes(`${EXPLORER}${h(20)}`), 'run.json-only transaction (hijacked) listed');
  assert.ok(!md.includes(`${EXPLORER}${h(99)}`), 'the approval record hash is not a transaction and is not linked as one');
  assert.ok(md.includes('buy a \\| piped dataset'), 'pipes in user input cannot break the table');
});

test('uses: grouped per request, outcome and approver in words, settlement listed once', () => {
  const uses = groupUses(sampleLog());
  assert.equal(uses.length, 3);
  assert.equal(useOutcome(uses[0]), 'paid and recorded');
  assert.match(useApproval(uses[0], '2000000'), /at or below the 2 CCD threshold/);
  assert.equal(useApproval(uses[1], '2000000'), 'verified human (ZK proof, anchored)');
  assert.match(useOutcome(uses[1]), /authorised \(Pending\)/);
  assert.match(useOutcome(uses[2]), /preflight: `PerTxCap`/);
  const txs = uniqueTxs(uses[0].entries.flatMap(entryTxs));
  assert.equal(txs.filter((t) => t.hash === h(3)).length, 1);
});

test('integrity section: intact chain + covering anchor; a broken chain and a stale anchor are called out', () => {
  const entries = sampleLog();
  const ok = renderAuditReport({ entries, chain: AuditLog.verify(entries), state, run: runFor(entries) });
  assert.match(ok, /Hash chain: \*\*intact\*\* \(12 entries/);
  assert.match(ok, /It covers the whole log\./);
  assert.match(ok, /Chain check: not run \(offline\)/);

  const tampered = entries.map((e) => ({ ...e, data: { ...e.data } }));
  tampered[4].data.amount = '5000000';
  const bad = renderAuditReport({ entries: tampered, chain: AuditLog.verify(tampered), state, run: runFor(entries) });
  assert.match(bad, /\*\*BROKEN at entry 4\*\*/);

  const longer = [...entries, { ...entries.at(-1), seq: entries.length, hash: h(77) }];
  const stale = renderAuditReport({ entries: longer, chain: { ok: true }, state, run: runFor(entries) });
  assert.match(stale, /\*\*It does not cover the whole log\*\*/);

  const failed = renderAuditReport({ entries, chain: { ok: true }, state, run: runFor(entries), anchorCheck: { ok: false, reasons: ['anchor covers 11 entries, log has 12'] }, readAt: '2026-10-31T00:00:00.000Z' });
  assert.match(failed, /\*\*FAIL\*\*: anchor covers 11 entries, log has 12/);
});

test('resolveTxInfo: block time + outcome for finalized txs, "not found" is reported, other read errors propagate', async () => {
  const blocks = { b1: { blockHeight: 10n, blockSlotTime: new Date(Date.UTC(2026, 9, 30, 18, 51, 2)) } };
  const grpc = {
    getBlockItemStatus: async (th) => {
      const x = TransactionHash.toHexString(th);
      if (x.endsWith('01')) return { status: 'finalized', outcome: { blockHash: 'b1', summary: { transactionType: 'update' } } };
      if (x.endsWith('02')) return { status: 'finalized', outcome: { blockHash: 'b1', summary: { transactionType: 'failed', rejectReason: { tag: 'RejectedReceive' } } } };
      if (x.endsWith('03')) throw new Error('NOT_FOUND: transaction not found');
      throw Object.assign(new Error('UNAVAILABLE'), { code: 'UNAVAILABLE' });
    },
    getBlockInfo: async () => blocks.b1,
  };
  // BlockHash.fromHexString would reject 'b1'; resolveTxInfo passes non-string hashes through, so hand it an object.
  grpc.getBlockItemStatus = ((orig) => async (th) => { const r = await orig(th); if (r?.outcome) r.outcome.blockHash = { fake: true }; return r; })(grpc.getBlockItemStatus);
  const info = await resolveTxInfo(grpc, [h(1), h(2), h(3), 'zz']);
  assert.deepEqual(info.get(h(1)), { finalized: true, blockHeight: 10n, blockTime: '2026-10-30T18:51:02.000Z', outcome: 'success' });
  assert.equal(info.get(h(2)).outcome, 'rejected (RejectedReceive)');
  assert.deepEqual(info.get(h(3)), { finalized: false });
  assert.equal(info.get('zz').invalid, true);
  await assert.rejects(resolveTxInfo(grpc, [h(4)]), /UNAVAILABLE/);
});
