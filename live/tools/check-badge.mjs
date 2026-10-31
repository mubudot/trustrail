// Check "Verified by Concordium" badges through the hosted Agent Registry MCP (`check_badge` tool).
// Read-only, no keys. Defaults to both TrustRail badges from live/state/testnet.json.
//   node tools/check-badge.mjs [tokenAddress ...]
import { callTool } from '../src/registry-mcp.mjs';
import { readState } from '../src/state.mjs';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.values(readState().badges ?? {}).map((b) => b.tokenAddress);
if (!ids.length) { console.error('usage: node tools/check-badge.mjs <badge token address> ...'); process.exit(2); }
let bad = 0;
for (const id of ids) {
  const r = await callTool('check_badge', { id, network: 'testnet' });
  const v = typeof r === 'string' ? JSON.parse(r) : r;
  const failed = Object.entries(v.checks ?? {}).filter(([, ok]) => ok === false).map(([k]) => k);
  console.log(`${v.badge_valid ? 'VALID  ' : 'INVALID'} ${id} = CIS-8004 token #${v.token_id ?? '?'}, ${v.on_chain?.status ?? 'not found'}, owner ${v.on_chain?.owner_account ?? '?'}, card ${v.agent_uri ?? '-'} (card hash ${v.checks?.hash_matches_on_chain ? 'matches on chain' : 'MISMATCH'})`);
  if (failed.length || v.issues?.length) console.log('        failed checks:', failed.join(', ') || '-', '| issues:', JSON.stringify(v.issues ?? []));
  if (!v.badge_valid) bad++;
}
process.exit(bad ? 1 : 0);
