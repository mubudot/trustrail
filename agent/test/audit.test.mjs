import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/audit/log.mjs';

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
