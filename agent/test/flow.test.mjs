import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, ACCOUNTS, CCD } from '../src/mock/world.mjs';
import { AuditLog } from '../src/audit/log.mjs';

test('small purchase from a verified, allowlisted seller is paid and recorded on chain', async () => {
  const w = createWorld();
  const before = w.ledger.account(ACCOUNTS.dataSeller)?.balance ?? 0n;
  const r = await w.agent.buy('https://data.example/weather', { intent: 'weather for Tokyo' });
  assert.equal(r.status, 'paid');
  assert.deepEqual(r.data, { tokyo: '18C, clear' });
  assert.equal(w.ledger.account(ACCOUNTS.dataSeller).balance - before, CCD / 2n);
  const a = w.guard.authorization(r.authId).auth;
  assert.equal(a.status, 'Settled');
  assert.equal(a.settlement, r.txHash);
  assert.ok(AuditLog.verify(w.audit.entries).ok);
});

test('stolen badge string: payee not bound to the badge -> refused before any chain call', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://attacker.example/refund');
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'payee_not_bound_to_badge');
  assert.equal(w.guard.view().nextAuthId, 0n);
});

test('unverified seller refused when verified payees are required', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://shady.example/cheap-data');
  assert.equal(r.reason, 'payee_has_no_badge');
  // Relaxing only the buyer is not enough: the co-signer enforces its own verified-payee policy.
  w.agent.requireVerifiedPayee = false;
  const viaBuyerOnly = await w.agent.buy('https://shady.example/cheap-data');
  assert.equal(viaBuyerOnly.stage, 'cosigner');
  assert.equal(viaBuyerOnly.reason, 'payee_has_no_badge');
  w.cosigner.requireVerifiedPayee = false;
  assert.equal((await w.agent.buy('https://shady.example/cheap-data')).status, 'paid');
});

test('verified but not allowlisted seller refused by preflight', async () => {
  const w = createWorld();
  w.guard.setAllowlist(ACCOUNTS.owner, { agent: ACCOUNTS.agent, allowlist: [] });
  const r = await w.agent.buy('https://data.example/weather');
  assert.equal(r.stage, 'preflight');
  assert.equal(r.reason, 'NotAllowlisted');
});

test('above the approval threshold: pending until the owner approves, then paid', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://data.example/dataset');
  assert.equal(r.status, 'pending_approval');
  // the co-signer will not sign a pending authorisation, even if the agent tries
  assert.equal((await w.agent.resume(r.authId)).reason, 'status_Pending');
  const r2 = await w.agent.buy('https://data.example/dataset');
  w.humanApprove(r2.authId);
  const paid = await w.agent.resume(r2.authId);
  assert.equal(paid.status, 'paid');
});

test('owner approval without a valid human proof is not enough: co-signer refuses and releases', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://data.example/dataset');
  w.guard.approve(ACCOUNTS.owner, r.authId, 'ab'.repeat(32)); // owner key alone, made-up proof
  const out = await w.agent.resume(r.authId);
  assert.equal(out.status, 'refused');
  assert.equal(out.reason, 'human_approval_invalid');
  assert.equal(w.guard.authorization(r.authId).auth.status, 'Cancelled');
});

test('a valid proof for another authorisation does not transfer (replay)', async () => {
  const w = createWorld();
  const a = await w.agent.buy('https://data.example/dataset');
  const proofA = w.humanApprove(a.authId);
  const b = await w.agent.buy('https://data.example/dataset');
  w.guard.approve(ACCOUNTS.owner, b.authId, proofA);
  assert.equal((await w.agent.resume(b.authId)).reason, 'human_approval_invalid');
  assert.equal((await w.agent.resume(a.authId)).status, 'paid');
});

test('audit head can be anchored on chain by accountable parties only', () => {
  const w = createWorld();
  w.guard.anchorAudit(ACCOUNTS.agent, { head: 'cd'.repeat(32), count: 3 });
  assert.equal(w.guard.events.at(-1).type, 'AuditAnchored');
  assert.throws(() => w.guard.anchorAudit('stranger', { head: 'cd'.repeat(32), count: 3 }), /NotPermitted/);
});

test('daily cap stops a loop of small payments', async () => {
  const w = createWorld();
  const results = [];
  for (let i = 0; i < 30; i++) results.push((await w.agent.buy('https://data.example/weather')).status);
  assert.equal(results.filter((s) => s === 'paid').length, 24); // 12 CCD / 0.5 CCD
  assert.equal(results.at(-1), 'refused');
  w.advance(86_400_000);
  assert.equal((await w.agent.buy('https://data.example/weather')).status, 'paid');
});

test('owner pause stops spending immediately', async () => {
  const w = createWorld();
  w.guard.setPaused(ACCOUNTS.owner, true);
  const r = await w.agent.buy('https://data.example/weather');
  assert.equal(r.reason, 'Paused');
});

test('settlement failure after commit keeps the budget booked and is logged for reconciliation', async () => {
  const w = createWorld();
  const realFetch = w.agent.fetchImpl;
  w.agent.fetchImpl = async (url, init) => {
    if (init?.headers?.['PAYMENT-SIGNATURE']) throw new Error('connection reset');
    return realFetch(url, init);
  };
  const r = await w.agent.buy('https://data.example/weather');
  assert.equal(r.status, 'settlement_unknown');
  assert.equal(w.guard.authorization(r.authId).auth.status, 'Committed');
  assert.equal(w.guard.agent(ACCOUNTS.agent).spentTodayNow, CCD / 2n);
  assert.equal(w.audit.entries.at(-1).event, 'settlement_unknown');
});

test('mock guard validates policy and wallet like the contract', () => {
  const w = createWorld();
  const base = { asset: 'CCD', perTxCap: 10n, dailyCap: 10n, approvalThreshold: 5n, authTtlMs: 60_000n };
  const reg = (patch, allowlist = ['p'], wallet = 'w2') => () => w.guard.registerAgent(ACCOUNTS.owner, { agent: 'a2', wallet, policy: { ...base, ...patch }, allowlist });
  assert.throws(reg({ authTtlMs: 0n }), /InvalidPolicy/);
  assert.throws(reg({ asset: 'PLT:' }), /InvalidPolicy/);
  assert.throws(reg({}, ['p', 'p']), /InvalidPolicy/);
  assert.throws(reg({}, Array.from({ length: 33 }, (_, i) => `p${i}`)), /AllowlistTooLong/);
  assert.throws(reg({}, ['p'], 'a2'), /InvalidWallet/);
  assert.throws(reg({}, ['w2'], 'w2'), /InvalidWallet/);
  assert.throws(() => w.guard.setAllowlist(ACCOUNTS.owner, { agent: ACCOUNTS.agent, allowlist: [ACCOUNTS.wallet] }), /InvalidWallet/);
});

test('payee badge revoked or card changed while waiting for approval: resume refuses and releases', async () => {
  for (const [change, reason] of [[(e) => { e.active = false; }, 'payee_badge_revoked'],
    [(e) => { e.issue = 'payee_card_hash_mismatch'; }, 'payee_card_hash_mismatch']]) {
    const w = createWorld();
    const r = await w.agent.buy('https://data.example/dataset');
    assert.equal(r.status, 'pending_approval');
    change(w.cosigner.resolver.entries.BadgeDataSeller); // the registry changes after the quote
    w.humanApprove(r.authId);
    const out = await w.agent.resume(r.authId);
    assert.equal(out.status, 'refused');
    assert.equal(out.stage, 'identity');
    assert.equal(out.reason, reason);
    assert.equal(w.guard.authorization(r.authId).auth.status, 'Cancelled');
    assert.equal(w.ledger.account(ACCOUNTS.dataSeller)?.balance ?? 0n, 0n);
  }
});

test('co-signer re-checks the payee badge itself, even when the buyer skips its check', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://data.example/dataset');
  w.agent.resolver = { resolve: async () => ({ valid: true, active: true, agentWallet: ACCOUNTS.dataSeller }) }; // buyer misled
  w.cosigner.resolver.entries.BadgeDataSeller.active = false;
  w.humanApprove(r.authId);
  const out = await w.agent.resume(r.authId);
  assert.equal(out.stage, 'cosigner');
  assert.equal(out.reason, 'payee_badge_revoked');
  assert.equal(out.released, true);
  assert.equal(w.ledger.account(ACCOUNTS.dataSeller)?.balance ?? 0n, 0n);
});

test('concurrent purchases from one wallet are serialised (async co-signer): both paid, nonces in order', async () => {
  const w = createWorld();
  const [a, b] = await Promise.all([w.agent.buy('https://data.example/weather'), w.agent.buy('https://data.example/weather')]);
  assert.deepEqual([a.status, b.status], ['paid', 'paid']);
});

test('registry unreachable during resume or co-signing: stable refusal and the authorisation is released', async () => {
  const w = createWorld();
  const r = await w.agent.buy('https://data.example/dataset');
  w.humanApprove(r.authId);
  const down = { resolve: async () => { throw new Error('fetch failed'); } };
  w.agent.resolver = down;
  w.cosigner.resolver = down;
  const out = await w.agent.resume(r.authId);
  assert.deepEqual([out.status, out.stage, out.reason, out.released], ['refused', 'identity', 'payee_badge_unavailable', true]);
  assert.equal(w.guard.authorization(r.authId).auth.status, 'Cancelled');
  const r2 = await w.agent.buy('https://data.example/dataset');
  assert.equal(r2.reason, 'payee_badge_unavailable');
});
