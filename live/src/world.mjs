// Wires the live testnet world from live/.secrets + live/state: guard client, buyer agent,
// co-signer, a local x402 seller (real facilitator, real settlement) and the audit log.
import fs from 'node:fs';
import path from 'node:path';
import { testnetClient, TESTNET } from './net.mjs';
import { deployedGuard } from './guard-instance.mjs';
import { loadAccounts, roleSigner } from './signers.mjs';
import { readState, STATE_FILE } from './state.mjs';
import { LiveCosigner } from './cosigner-live.mjs';
import { LiveAgent } from './live-agent.mjs';
import { createFacilitator, createSellerApp, listen } from './x402-seller.mjs';
import { AuditLog } from '../../agent/src/audit/log.mjs';
import { HostedBadgeResolver } from '../../agent/src/identity/badge.mjs';

export const STATE_DIR = path.dirname(STATE_FILE);
export const APPROVALS_DIR = path.join(STATE_DIR, 'approvals');
export const AUDIT_FILE = path.join(STATE_DIR, 'audit.jsonl');

export const ITEMS = {
  '/weather': { microCcd: 500_000n, description: 'Hourly weather feed (0.5 CCD)', body: { tokyo: '18C, clear' } },
  '/dataset': { microCcd: 4_000_000n, description: 'Labelled dataset, 1k rows (4 CCD)', body: { rows: 1000 } },
  '/bulk': { microCcd: 9_000_000n, description: 'Bulk export (9 CCD)', body: { rows: 100000 } },
};

export const approvalFile = (id) => path.join(APPROVALS_DIR, `auth-${id}.json`);
export function loadApproval(id) {
  const f = approvalFile(id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export async function createLiveWorld() {
  const grpc = testnetClient();
  const st = readState();
  const acc = loadAccounts();
  const guard = deployedGuard(grpc);
  const cosigner = new LiveCosigner({
    guard, account: { address: acc.cosigner.address, signer: roleSigner(acc.cosigner) },
    walletKey: acc.wallet.keys[1].privateKey, agentPublicKey: acc.wallet.keys[0].publicKey,
    agentAccount: acc.agent.address, owner: acc.owner.address,
    approvals: async (id) => loadApproval(id),
  });
  const audit = new AuditLog({ file: AUDIT_FILE });
  const facilitator = createFacilitator({ address: acc.facilitator.address, privateKey: acc.facilitator.keys[0].privateKey });
  // Fixed ports: the purpose hash binds the resource URL, and pending purchases resume in a later run.
  const seller = await listen(createSellerApp({ payTo: acc.seller.address, badge: st.badges.seller.tokenAddress, facilitator, items: ITEMS }), 4402);
  // A look-alike seller that presents the real seller's badge string but asks to be paid elsewhere.
  const impostor = await listen(createSellerApp({ payTo: acc.cosigner.address, badge: st.badges.seller.tokenAddress, facilitator, items: { '/refund': ITEMS['/weather'] } }), 4403);
  const agent = new LiveAgent({
    grpc, guard, agent: { address: acc.agent.address, signer: roleSigner(acc.agent) }, walletKey0: acc.wallet.keys[0].privateKey,
    cosigner, resolver: new HostedBadgeResolver(), audit, network: TESTNET.x402Network,
  });
  const close = () => { seller.srv.close(); impostor.srv.close(); };
  return { grpc, st, acc, guard, cosigner, audit, agent, seller, impostor, close };
}
