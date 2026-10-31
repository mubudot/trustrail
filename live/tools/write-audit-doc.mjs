// Regenerates ../docs/AUDIT_LOG.md: the agent's hash-chained audit log as an Art. 12-style record
// with CCDExplorer links, block times and an on-chain anchor check. Read-only, needs NO keys.
//   node tools/write-audit-doc.mjs            # reads testnet (block times + anchor check)
//   node tools/write-audit-doc.mjs --offline  # no network: links only
import fs from 'node:fs';
import { readOnlyTestnetClient } from '../src/net.mjs';
import { deployedGuard } from '../src/guard-instance.mjs';
import { readState } from '../src/state.mjs';
import { AUDIT_FILE } from '../src/world.mjs';
import { checkAuditAnchor, txHashesIn, txHashesInLog } from '../src/audit-anchor.mjs';
import { renderAuditReport, resolveTxInfo } from '../src/audit-report.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';

const offline = process.argv.includes('--offline');
const state = readState();
const run = JSON.parse(fs.readFileSync(new URL('../state/run.json', import.meta.url), 'utf8'));
// Read the raw lines (not via the AuditLog constructor, which refuses a broken chain): a broken log is reported, not hidden.
const entries = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chain = AuditLog.verify(entries);

let txInfo; let anchorCheck; let readAt;
if (!offline) {
  const grpc = readOnlyTestnetClient();
  readAt = new Date().toISOString();
  txInfo = await resolveTxInfo(grpc, [...txHashesInLog(entries), ...txHashesIn(run.steps ?? [])]);
  const anchor = (run.steps ?? []).filter((s) => s.step === 'anchor').at(-1);
  if (!anchor) anchorCheck = { ok: false, reasons: ['no anchor recorded in live/state/run.json'] };
  else {
    const g = state.guard;
    anchorCheck = await checkAuditAnchor({ grpc, guard: deployedGuard(grpc), anchorTxHash: anchor.txHash, entries,
      allowedSenders: [g.owner, g.agent, g.cosigner], coveredTxHashes: txHashesIn(run.steps) });
  }
}
fs.writeFileSync(new URL('../../docs/AUDIT_LOG.md', import.meta.url), renderAuditReport({ entries, chain, state, run, txInfo, anchorCheck, readAt }));
const anchorOk = chain.ok && anchorCheck?.ok;
console.log(`wrote docs/AUDIT_LOG.md (${entries.length} entries, chain ${chain.ok ? 'intact' : `broken at ${chain.brokenAt}`}, anchor ${offline ? 'not checked (offline)' : anchorOk ? 'PASS' : 'FAIL'})`);
// Offline output is unverified: exit 0 only for an intact chain. Online: intact chain AND a passing anchor check.
process.exit(chain.ok && (offline || anchorOk) ? 0 : 1);
