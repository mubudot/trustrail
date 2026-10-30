import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransfer, signAsKey, addSig, signingDigest, toJSON, fromJSON, selectRequirements } from '../src/x402-buyer.mjs';
import { signDigestWithKey, verifyDigestWithKey } from '../src/keys.mjs';
import { A, fakeGrpc, requirements, walletKeys } from './helpers.mjs';

test('builds the sponsored V1 transfer the facilitator expects, declared 2-of-2', async () => {
  const tx = await buildTransfer(fakeGrpc, { sender: A.wallet, requirements: requirements() });
  const j = toJSON(tx);
  assert.equal(j.version, 1);
  assert.equal(j.header.sender, A.wallet);
  assert.equal(j.header.numSignatures, 2);
  assert.equal(j.header.sponsor.account, A.facilitator);
  assert.deepEqual(j.payload, { type: 'transfer', toAddress: A.seller, amount: '4000000' });
  const nowS = Math.floor(Date.now() / 1000);
  assert.ok(j.header.expiry > nowS && j.header.expiry <= nowS + 300);
});

test('expiry never outlives the authorisation', async () => {
  const notAfterS = Math.floor(Date.now() / 1000) + 30;
  const tx = await buildTransfer(fakeGrpc, { sender: A.wallet, requirements: requirements(), notAfterS });
  assert.ok(toJSON(tx).header.expiry <= notAfterS);
});

test('JSON round trip keeps the sign-hash; agent key 0 + co-signer key 1 both verify', async () => {
  const k = walletKeys();
  let tx = await buildTransfer(fakeGrpc, { sender: A.wallet, requirements: requirements() });
  tx = signAsKey(tx, 0, k.agent.privateKey);
  const j = toJSON(tx);
  const back = fromJSON(j);
  const digest = signingDigest(back);
  assert.equal(digest, signingDigest(tx));
  assert.ok(verifyDigestWithKey(k.agent.publicKey, digest, j.signatures.sender[0][0]));
  const both = toJSON(addSig(back, 1, signDigestWithKey(k.cosigner.privateKey, digest)));
  assert.deepEqual(Object.keys(both.signatures.sender[0]).sort(), ['0', '1']);
  assert.ok(verifyDigestWithKey(k.cosigner.publicKey, digest, both.signatures.sender[0][1]));
});

test('selectRequirements only takes exact CCD offers on our network', () => {
  const pr = { accepts: [{ ...requirements(), network: 'ccd:other' }, { ...requirements(), scheme: 'upto' }, requirements('1')] };
  assert.equal(selectRequirements(pr, { network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27' }).amount, '1');
  assert.equal(selectRequirements({ accepts: [] }, { network: 'x' }), null);
});
