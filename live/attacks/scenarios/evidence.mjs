import assert from 'node:assert/strict';
import { AccountAddress, BlockHash } from '@concordium/web-sdk';
import { AuditLog } from '../../../agent/src/audit/log.mjs';
import { checkAuditAnchor, ANCHOR_EVENT_LEN } from '../../src/audit-anchor.mjs';
import { settlementMatchesCommitment } from '../../src/settlement-check.mjs';
import { signDigestWithKey } from '../../src/keys.mjs';
import { paymentFixture, A } from '../fixtures.mjs';
import { attack, control } from '../reporter.mjs';

const TX = 'ab'.repeat(32);
const ANCHOR = 'cd'.repeat(32);
const BLOCK = BlockHash.fromHexString('ef'.repeat(32));

export async function evidenceFixture() {
  const s = await paymentFixture({ amount: 500_000n, human: false });
  const cosig = await s.cos.cosign(s.input);
  s.chain.recordSettlement(A.agent, { id: 5n, txHash: TX });
  const digest = s.chain.authorization(5n).auth.commitment;
  const log = new AuditLog();
  for (let id = 0; id < 5; id++) {
    log.append('authorized', { authId: id }); log.append('refused', { authId: id });
  }
  log.append('authorized', { authId: 5 }); log.append('cosigned', { authId: 5 });
  log.append('settled', { authId: 5, txHash: TX });
  const anchor = Buffer.alloc(ANCHOR_EVENT_LEN);
  anchor[0] = 18;
  Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(A.owner))).copy(anchor, 1);
  Buffer.from(log.entries.at(-1).hash, 'hex').copy(anchor, 33);
  anchor.writeBigUInt64LE(BigInt(log.entries.length), 65);
  let sigs = { 0: s.input.signableJSON.signatures.sender[0][0], 1: cosig };
  const grpc = {
    getBlockItemStatus: async () => ({ status: 'finalized', outcome: { blockHash: BLOCK,
      summary: { events: [{ address: s.guard.address, events: [anchor.toString('hex')] }] } } }),
    getBlockInfo: async () => ({ blockHeight: 100n }),
    client: { getBlockItems: () => ({ responses: (async function* () {
      yield { hash: { value: Buffer.from(TX, 'hex') }, blockItem: {
        oneofKind: 'accountTransactionV1', accountTransactionV1: { signatures: { senderSignatures: {
          signatures: { 0: { signatures: Object.fromEntries(Object.entries(sigs).map(([k, value]) =>
            [k, { value: Buffer.from(value, 'hex') }])) } },
        } } },
      } };
    })() }) },
  };
  return { s, log, anchor,
    checkAnchor: (entries = log.entries) => checkAuditAnchor({ grpc, guard: s.guard,
      anchorTxHash: ANCHOR, entries, allowedSenders: [A.owner] }),
    checkSettlement: () => settlementMatchesCommitment(grpc, { txHash: TX, commitment: digest,
      walletPublicKeys: { agentKey0: s.keys.agent.publicKey, cosignerKey1: s.keys.cosigner.publicKey } }),
    wrongSettlement: () => {
      const other = '33'.repeat(32);
      sigs = { 0: signDigestWithKey(s.keys.agent.privateKey, other),
        1: signDigestWithKey(s.keys.cosigner.privateKey, other) };
    },
  };
}

export const evidenceScenarios = [
  control('31', 'settled signatures and anchored audit log verify', async () => {
    const f = await evidenceFixture();
    assert.equal(await f.checkSettlement(), true);
    assert.deepEqual((await f.checkAnchor()).reasons, []);
    return 'PASS';
  }),
  attack('32', 'rewrite audit log and recompute its hash chain', 'audit anchor verifier',
    'anchor head is not the hash of the last log entry', async () => {
      const f = await evidenceFixture();
      const rewritten = new AuditLog();
      for (const e of f.log.entries) rewritten.append(e.event, { ...e.data, injected: true });
      assert.equal(AuditLog.verify(rewritten.entries).ok, true, 'attacker supplied a valid replacement hash chain');
      const result = await f.checkAnchor(rewritten.entries);
      assert.equal(result.ok, false);
      return result.reasons[0];
    }),
  attack('33', 'record a settlement signed over a different digest', 'settlement verifier',
    'settlement_not_signed_over_commitment', async () => {
      const f = await evidenceFixture(); f.wrongSettlement();
      // settlementMatchesCommitment returns a boolean (no reason code); name its refusal for the report.
      const ok = await f.checkSettlement();
      return ok === false ? 'settlement_not_signed_over_commitment' : `unexpected:${ok}`;
    }),
];
