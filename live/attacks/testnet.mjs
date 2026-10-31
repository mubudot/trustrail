// Optional READ-ONLY testnet checks. No world/signers/secrets imports, transaction creation,
// signatures or sends. A hard genesis check precedes every deployment/proof/card lookup.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BlockHash } from '@concordium/web-sdk';
import { testnetClient, TESTNET } from '../src/net.mjs';
import { NETWORK, checkApproval, approvalResourceId, approvalContextString } from '../src/human-approval.mjs';
import { deployedGuard } from '../src/guard-instance.mjs';
import { unOpt } from '../src/guard-client.mjs';
import { readState } from '../src/state.mjs';
import { HostedBadgeResolver, checkPayee } from '../../agent/src/identity/badge.mjs';
import { TESTNET_GENESIS } from './proof-chain.mjs';
import { attack, control, evaluateScenario } from './reporter.mjs';

export function assertTestnet(genesis, network = TESTNET.x402Network) {
  if (genesis !== TESTNET_GENESIS || network !== `ccd:${TESTNET_GENESIS.slice(0, 32)}` || NETWORK !== 'Testnet') {
    throw new Error('refusing_non_testnet');
  }
}

const unreachable = (e) => [4, 14].includes(e.code)
  || /UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed/.test(`${e.code ?? ''} ${e.message ?? ''}`);

async function registryBadge(tokenAddress) {
  const res = await fetch(`https://agent-registry-mcp.concordium.com/v1/check-badge/${tokenAddress}`,
    { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error('registry_unavailable');
  const body = await res.json();
  if (body.network !== 'testnet' || !body.on_chain?.metadata_hash_hex) throw new Error('registry_not_testnet_or_missing_pin');
  return body;
}

export async function testnetScenarios({ grpc = testnetClient() } = {}) {
  try {
    let consensus;
    try { consensus = await grpc.getConsensusStatus(); }
    catch (e) {
      if (!unreachable(e)) throw e;
      return [{ id: 'T0', label: 'read-only testnet node', status: 'SKIPPED', actual: 'testnet_node_unreachable' }];
    }
    assertTestnet(BlockHash.toHexString(consensus.genesisBlock));
    const st = readState();
    const guard = deployedGuard(grpc);
    const ap5 = JSON.parse(readFileSync(new URL('../state/approvals/auth-5.json', import.meta.url)));
    const ap3 = JSON.parse(readFileSync(new URL('../state/approvals/auth-3.json', import.meta.url)));
    const a = (await guard.authorization(5n)).auth;
    const args = { grpc, recordJSON: ap5.record, anchorTx: ap5.anchorTx, ownerAddress: st.guard.owner,
      resourceId: approvalResourceId(guard.address, 5n), contextString: approvalContextString(a),
      expectedAnchorHash: unOpt(a.human_proof), trustedVerifiers: [st.guard.cosigner] };
    const checks = [
      control('T1', 'real auth-5 ZK approval and anchors verify on testnet', async () =>
        await checkApproval(args) === true ? 'PASS' : 'REFUSED'),
      attack('T2', 'real auth-3 record vs auth-5 on-chain human_proof', 'human approval', 'approval_hash_mismatch', async () => {
        try { await checkApproval({ ...args, recordJSON: ap3.record, anchorTx: ap3.anchorTx }); return 'ACCEPTED'; }
        catch (e) { return e.message.split(':')[0]; }
      }),
      control('T3', 'real registry response for badge #977 passes the payee check', async () => {
        const b = st.badges.buyer;
        const body = await registryBadge(b.tokenAddress);
        const resolver = new HostedBadgeResolver({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
        return await checkPayee({ resolver, badge: b.tokenAddress, payTo: b.holder, required: true }) === null ? 'PASS' : 'REFUSED';
      }),
      attack('T4', 'alter local Agent Card vs registry on-chain pinned hash', 'client badge check', 'payee_card_hash_mismatch', async () => {
        const b = st.badges.buyer;
        const body = await registryBadge(b.tokenAddress);
        const card = JSON.parse(readFileSync(new URL('../agent-cards/977.json', import.meta.url)));
        card.name = 'Tampered demo agent';
        body.card_sha256 = createHash('sha256').update(JSON.stringify(card)).digest('hex');
        const resolver = new HostedBadgeResolver({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
        return checkPayee({ resolver, badge: b.tokenAddress, payTo: b.holder, required: true });
      }),
    ];
    const results = [];
    for (const s of checks) results.push(await evaluateScenario(s, { propagateErrors: true }));
    return results;
  } catch (e) {
    if (unreachable(e)) return [{ id: 'T0', label: 'read-only testnet node', status: 'SKIPPED', actual: 'testnet_node_unreachable' }];
    return [{ id: 'T0', label: 'read-only testnet safety / deployment check', status: 'UNEXPECTED', actual: e.message.split(':')[0] }];
  }
}
