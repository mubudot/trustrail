// Account signers built from the local secret store (never logged).
import { AccountAddress, buildBasicAccountSigner, buildAccountSigner } from '@concordium/web-sdk';
import { readSecret } from './secrets.mjs';

export function loadAccounts() {
  const a = readSecret('accounts');
  if (!a) throw new Error('no testnet accounts (run tools/create-accounts.mjs)');
  return a;
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
