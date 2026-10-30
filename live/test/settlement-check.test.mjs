import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementMatchesCommitment } from '../src/settlement-check.mjs';
import { signDigestWithKey } from '../src/keys.mjs';
import { walletKeys } from './helpers.mjs';

const TX = 'ab'.repeat(32);
const BLOCK = 'cd'.repeat(32);
const D = '11'.repeat(32);

function fakeGrpc({ txHash = TX, sigs, status = 'finalized' }) {
  const sigMap = Object.fromEntries(Object.entries(sigs).map(([k, v]) => [k, { value: Buffer.from(v, 'hex') }]));
  return {
    getBlockItemStatus: async () => ({ status, outcome: { blockHash: { buffer: Buffer.from(BLOCK, 'hex') } } }),
    client: {
      getBlockItems: () => ({
        responses: (async function* () {
          yield { hash: { value: Buffer.from('ef'.repeat(32), 'hex') }, blockItem: { oneofKind: 'accountTransactionV1', accountTransactionV1: {} } };
          yield {
            hash: { value: Buffer.from(txHash, 'hex') },
            blockItem: { oneofKind: 'accountTransactionV1', accountTransactionV1: { signatures: { senderSignatures: { signatures: { 0: { signatures: sigMap } } } } } },
          };
        })(),
      }),
    },
  };
}

test('settled transaction matches the commitment only when both wallet keys signed that digest', async () => {
  const k = walletKeys();
  const pub = { agentKey0: k.agent.publicKey, cosignerKey1: k.cosigner.publicKey };
  const check = (grpc, commitment = D) => settlementMatchesCommitment(grpc, { txHash: TX, commitment, walletPublicKeys: pub });
  const good = { 0: signDigestWithKey(k.agent.privateKey, D), 1: signDigestWithKey(k.cosigner.privateKey, D) };
  assert.equal(await check(fakeGrpc({ sigs: good })), true);
  // a same-looking transfer, but signed over another digest
  const other = '22'.repeat(32);
  const wrong = { 0: signDigestWithKey(k.agent.privateKey, other), 1: signDigestWithKey(k.cosigner.privateKey, other) };
  assert.equal(await check(fakeGrpc({ sigs: wrong })), false);
  // keys swapped / one signature missing / not finalized / no commitment / tx not in the block
  assert.equal(await check(fakeGrpc({ sigs: { 0: good[1], 1: good[0] } })), false);
  assert.equal(await check(fakeGrpc({ sigs: { 0: good[0] } })), false);
  assert.equal(await check(fakeGrpc({ sigs: good, status: 'committed' })), false);
  assert.equal(await check(fakeGrpc({ sigs: good }), null), false);
  assert.equal(await check(fakeGrpc({ sigs: good, txHash: '99'.repeat(32) })), false);
});
