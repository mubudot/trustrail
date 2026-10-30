import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/audit/log.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hash chain detects edits and deletions', () => {
  const log = new AuditLog({ clock: () => 0 });
  log.append('request', { url: 'x' });
  log.append('authorized', { authId: 1n });
  log.append('settled', { txHash: 'ab' });
  assert.ok(AuditLog.verify(log.entries).ok);
  const edited = structuredClone(log.entries);
  edited[1].data.authId = '2';
  assert.equal(AuditLog.verify(edited).brokenAt, 1);
  assert.equal(AuditLog.verify([log.entries[0], log.entries[2]]).ok, false);
});

test('file audit accepts BigInt, snapshots data and continues its chain after restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trustrail-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'audit.jsonl');
  const log = new AuditLog({ file, clock: () => 0 });
  const data = { authId: 1n, amount: 500_000n };
  log.append('settled', data);
  data.amount = 0n;
  const resumed = new AuditLog({ file, clock: () => 1 });
  resumed.append('request', { url: 'https://data.example/weather' });
  const disk = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(disk[0].data.amount, '500000');
  assert.deepEqual(disk, resumed.entries);
  assert.deepEqual(AuditLog.verify(disk), { ok: true });
  disk[0].data.amount = '0';
  writeFileSync(file, disk.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  assert.throws(() => new AuditLog({ file }), /invalid_audit_log/);
});

test('failed file write does not advance the in-memory audit chain', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trustrail-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new AuditLog({ file: join(dir, 'missing', 'audit.jsonl') });
  assert.throws(() => log.append('request', {}), /ENOENT/);
  assert.equal(log.entries.length, 0);
});
