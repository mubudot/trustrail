// Runtime-only service config. It is provisioned independently of the buyer's config; no fallback
// to loadAccounts(). Approval records are public verifier evidence, not caller-provided proofs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GuardClient } from './guard-client.mjs';
import { TESTNET, testnetClient } from './net.mjs';
import { roleSigner } from './signers.mjs';
import { HostedBadgeResolver } from '../../agent/src/identity/badge.mjs';

export function loadCosignerConfig(file) {
  if (!file) throw new Error('TRUSTRAIL_COSIGNER_CONFIG is required');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const fields = ['network', 'guard', 'owner', 'agent', 'humanProofAbove', 'agentPublicKey', 'walletKey', 'account', 'approvalsDir', 'nonceStateFile'];
  if (Object.keys(c).sort().join(',') !== fields.sort().join(',')) throw new Error('unexpected service config fields');
  if (c.network !== TESTNET.x402Network) throw new Error('service supports testnet only');
  if (c.guard?.index === undefined || c.guard.subindex === undefined || !c.owner || !c.agent
    || !c.account?.address || !c.approvalsDir || typeof c.nonceStateFile !== 'string' || !c.nonceStateFile
    || c.humanProofAbove === undefined) throw new Error('incomplete pinned service config');
  if (!/^[0-9a-f]{64}$/.test(c.walletKey) || !/^[0-9a-f]{64}$/.test(c.agentPublicKey)
    || Object.keys(c.account.keys ?? {}).join(',') !== '0'
    || !/^[0-9a-f]{64}$/.test(c.account.keys[0]?.privateKey)
    || !/^[0-9a-f]{64}$/.test(c.account.keys[0]?.publicKey)) throw new Error('invalid service key configuration');
  const grpc = testnetClient();
  const guard = new GuardClient({ grpc, address: { index: BigInt(c.guard.index), subindex: BigInt(c.guard.subindex) } });
  const approvalsDir = path.resolve(path.dirname(file), c.approvalsDir);
  return {
    guard, network: c.network, owner: c.owner, agentAccount: c.agent,
    account: { address: c.account.address, signer: roleSigner(c.account) },
    walletKey: c.walletKey, agentPublicKey: c.agentPublicKey, humanProofAbove: BigInt(c.humanProofAbove),
    resolver: new HostedBadgeResolver(),
    nonceStateFile: path.resolve(path.dirname(file), c.nonceStateFile),
    approvals: async (id) => {
      try { return JSON.parse(readFileSync(path.join(approvalsDir, `auth-${BigInt(id)}.json`), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
  };
}
