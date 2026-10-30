import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, ACCOUNTS, CCD } from '../src/mock/world.mjs';
import { CosignRefused } from '../src/cosigner/cosigner.mjs';
import { buildAgentSignedTx } from '../src/payments/x402-client.mjs';
import { purposeHash } from '../src/util/canonical.mjs';
import { signDigest, signingDigest } from '../src/payments/tx.mjs';

const URL1 = 'https://data.example/weather';

async function setup() {
  const w = createWorld();
  const res = await w.fetchImpl(URL1);
  const pr = JSON.parse(Buffer.from(res.headers['PAYMENT-REQUIRED'], 'base64').toString());
  const req = pr.accepts[0];
  const out = w.guard.authorize(ACCOUNTS.agent, { payee: req.payTo, asset: 'CCD', amount: BigInt(req.amount), mode: 'X402', purposeHash: purposeHash(URL1, req) });
  const mk = (patch = {}) => {
    const r = { ...req, ...patch };
    return buildAgentSignedTx({ agentAccount: ACCOUNTS.agent, agentKey: w.agentKeys.privateKey, nonce: 1, requirements: r, nowS: Math.floor(w.clock() / 1000), notAfterS: Number(out.expiresAt / 1000n) });
  };
  const reason = (fn) => { try { fn(); return 'signed'; } catch (e) { assert.ok(e instanceof CosignRefused); return e.reason; } };
  return { w, req, out, mk, reason };
}

test('signs exactly the authorised transfer, once', async () => {
  const { w, req, out, mk, reason } = await setup();
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), 'signed');
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), 'authorization_already_used');
});

test('refuses tampered payee, amount, purpose, signature, expiry', async () => {
  const { w, req, out, mk, reason } = await setup();
  const c = (tx, r = req, url = URL1) => reason(() => w.cosigner.cosign({ authId: out.id, tx, resourceUrl: url, requirements: r }));
  assert.equal(c(mk({ payTo: ACCOUNTS.attacker })), 'tx_payee_mismatch');
  assert.equal(c(mk({ amount: (CCD).toString() })), 'tx_amount_mismatch');
  assert.equal(c(mk(), req, 'https://data.example/other'), 'purpose_mismatch');
  const forged = mk();
  forged.signatures.sender[0][0] = signDigest(w.cosignerKeys.privateKey, signingDigest(forged));
  assert.equal(c(forged), 'agent_signature_invalid');
  const late = mk();
  late.header.expiry += 3600;
  assert.equal(c(late), 'tx_expiry_window');
  w.advance(121_000);
  assert.equal(c(mk()), 'authorization_expired');
});

test('facilitator rejects a transfer carrying only the agent signature (threshold 2)', async () => {
  const { w, req, mk } = await setup();
  const tx = mk();
  const v = w.facilitator.verify({ signedTransaction: tx, sender: ACCOUNTS.agent }, req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'invalid_sender_signature');
});
