import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, ACCOUNTS, CCD } from '../src/mock/world.mjs';
import { Cosigner, CosignRefused } from '../src/cosigner/cosigner.mjs';
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
    return buildAgentSignedTx({ agentAccount: ACCOUNTS.wallet, agentKey: w.agentKeys.privateKey, nonce: 1, requirements: r, nowS: Math.floor(w.clock() / 1000), notAfterS: Number(out.expiresAt / 1000n) });
  };
  const reason = (fn) => { try { fn(); return 'signed'; } catch (e) { assert.ok(e instanceof CosignRefused); return e.reason; } };
  return { w, req, out, mk, reason };
}

test('signs exactly the authorised transfer, once — enforced on chain, survives restart', async () => {
  const { w, req, out, mk, reason } = await setup();
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), 'signed');
  assert.equal(w.guard.authorization(out.id).auth.status, 'Committed');
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), 'status_Committed');
  // a fresh co-signer instance (restart / second replica) cannot sign it again either
  const restarted = new Cosigner({ guard: w.guard, account: ACCOUNTS.cosigner, keyPair: w.cosignerKeys, agentAccount: ACCOUNTS.agent, agentPublicKey: w.agentKeys.publicKey, clock: w.clock });
  assert.equal(reason(() => restarted.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), 'status_Committed');
  // and a committed authorisation cannot be cancelled to win back budget
  assert.throws(() => w.guard.cancel(ACCOUNTS.agent, out.id), /WrongStatus/);
  assert.equal(w.guard.agent(ACCOUNTS.agent).spentTodayNow, BigInt(req.amount));
});

test('a refused authorisation is released by the co-signer (never signed => refundable)', async () => {
  const { w, req, out, mk, reason } = await setup();
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk({ payTo: ACCOUNTS.attacker }), resourceUrl: URL1, requirements: req })), 'tx_payee_mismatch');
  assert.equal(w.cosigner.release(out.id), true);
  assert.equal(w.guard.authorization(out.id).auth.status, 'Cancelled');
  assert.equal(w.guard.agent(ACCOUNTS.agent).spentTodayNow, 0n);
});

test('transfer must come from the registered wallet, not the agent control account', async () => {
  const { w, req, out, reason } = await setup();
  const tx = buildAgentSignedTx({ agentAccount: ACCOUNTS.agent, agentKey: w.agentKeys.privateKey, nonce: 1, requirements: req, nowS: Math.floor(w.clock() / 1000), notAfterS: Number(out.expiresAt / 1000n) });
  assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx, resourceUrl: URL1, requirements: req })), 'tx_sender_not_agent_wallet');
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
  const v = w.facilitator.verify({ signedTransaction: tx, sender: ACCOUNTS.wallet }, req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'invalid_sender_signature');
});

test('co-signer rechecks pause, registration generation and allowlist before signing', async () => {
  const cases = [
    ['guard_paused', (w) => w.guard.setPaused(ACCOUNTS.owner, true)],
    ['agent_paused', (w) => w.guard.setAgentPaused(ACCOUNTS.owner, { agent: ACCOUNTS.agent, paused: true })],
    ['payee_not_allowlisted', (w) => w.guard.setAllowlist(ACCOUNTS.owner, { agent: ACCOUNTS.agent, allowlist: [] })],
    // The mock has no remove/re-register entrypoints; model their resulting state directly.
    ['stale_generation', (w) => w.guard.agents.delete(ACCOUNTS.agent)],
    ['stale_generation', (w) => { w.guard.agents.get(ACCOUNTS.agent).generation++; }],
  ];
  for (const [expected, change] of cases) {
    const { w, req, out, mk, reason } = await setup();
    change(w);
    assert.equal(reason(() => w.cosigner.cosign({ authId: out.id, tx: mk(), resourceUrl: URL1, requirements: req })), expected);
    assert.equal(w.guard.authorization(out.id).auth.status, 'Approved');
  }
});

test('facilitator and ledger reject replay without a second debit', async () => {
  const { w, req, out, mk } = await setup();
  const tx = mk();
  tx.signatures.sender[0][1] = w.cosigner.cosign({ authId: out.id, tx, resourceUrl: URL1, requirements: req });
  const payload = { signedTransaction: tx, sender: ACCOUNTS.wallet };
  const first = w.facilitator.settle(payload, req);
  assert.equal(first.success, true);
  const balance = w.ledger.account(ACCOUNTS.wallet).balance;
  assert.deepEqual(w.facilitator.settle(payload, req), { success: false, errorReason: 'preflight_nonce_mismatch' });
  assert.throws(() => w.ledger.apply(first.transaction, {
    from: ACCOUNTS.wallet, to: req.payTo, amount: BigInt(req.amount), nonce: 2,
  }), /duplicate_transaction/);
  assert.throws(() => w.ledger.apply('another-hash', {
    from: ACCOUNTS.wallet, to: req.payTo, amount: BigInt(req.amount), nonce: 1,
  }), /nonce_mismatch/);
  assert.equal(w.ledger.account(ACCOUNTS.wallet).balance, balance);
  assert.equal(w.ledger.account(req.payTo).balance, BigInt(req.amount));
  assert.equal(w.ledger.txs.size, 1);
});
