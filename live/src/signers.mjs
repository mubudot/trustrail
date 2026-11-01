// Account signers built from the local secret store (never logged).
import { AccountAddress, buildBasicAccountSigner, buildAccountSigner } from '@concordium/web-sdk';
import { readFileSync } from 'node:fs';
import { readSecret } from './secrets.mjs';

export function loadAccounts() {
  const a = readSecret('accounts');
  if (!a) throw new Error('no testnet accounts (run tools/create-accounts.mjs)');
  return a;
}

/** Remote buyers read a separately provisioned file, never the demo's all-roles secret store. */
export function loadBuyerAccounts(file) {
  if (!file) throw new Error('TRUSTRAIL_BUYER_CONFIG is required for a remote co-signer');
  const accounts = JSON.parse(readFileSync(file, 'utf8'));
  if (Object.keys(accounts).sort().join(',') !== 'agent,wallet') throw new Error('buyer config permits only agent and wallet');
  for (const role of ['agent', 'wallet']) {
    const acc = accounts[role];
    if (!acc || Object.keys(acc).some(k => !['address', 'keys', 'threshold'].includes(k))
      || Object.keys(acc.keys ?? {}).join(',') !== '0'
      || Object.keys(acc.keys[0] ?? {}).sort().join(',') !== 'privateKey,publicKey'
      || !/^[0-9a-f]{64}$/.test(acc.keys[0].privateKey) || !/^[0-9a-f]{64}$/.test(acc.keys[0].publicKey)) {
      throw new Error('buyer config permits key 0 only');
    }
    AccountAddress.fromBase58(acc.address);
  }
  return accounts;
}

export function address(acc) { return AccountAddress.fromBase58(acc.address); }

/** Single-key signer for a role (key 0). */
export function roleSigner(acc) { return buildBasicAccountSigner(acc.keys[0].privateKey); }

/** Signer holding every key of an account (testing only; the real wallet is split). */
export function fullSigner(acc) {
  return buildAccountSigner({ type: 'genesis', ...{} } && {
    keys: { 0: { keys: Object.fromEntries(Object.entries(acc.keys).map(([i, k]) => [i, { signKey: k.privateKey, verifyKey: k.publicKey }])), threshold: acc.threshold } },
    threshold: 1,
  });
}
