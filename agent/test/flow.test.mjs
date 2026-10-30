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
  w.agent.requireVerifiedPayee = false;
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
  w.guard.approve(ACCOUNTS.owner, r2.authId);
  const paid = await w.agent.resume(r2.authId);
  assert.equal(paid.status, 'paid');
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
