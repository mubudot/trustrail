// Public read-only testnet responses captured while checkApproval verified auth-5 on 2026-10-31.
// Replay data, never verification results: the SDK still verifies the ZK proof and both anchors.
// blockSlotTime is the slot time of the block that finalized the auth-5 request anchor (read from testnet).
import { readFileSync } from 'node:fs';
import { AccountAddress, BlockHash, TransactionHash } from '@concordium/web-sdk';

export const TESTNET_GENESIS = '4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796';
export const approval = JSON.parse(readFileSync(new URL('../state/approvals/auth-5.json', import.meta.url)));
const chain = JSON.parse(readFileSync(new URL('./fixtures/approval-chain.json', import.meta.url)));
if (chain.genesis !== TESTNET_GENESIS) throw new Error('fixture_not_testnet');

export function proofChain() {
  const credentialId = Object.values(chain.accountCredentials)[0].value.contents.credId;
  return {
    getCryptographicParameters: async () => structuredClone(chain.cryptoParams),
    getAccountInfo: async (account) => {
      if (String(account) !== credentialId && String(account) !== '4quNUwSZDXiz2zb6jGQ8ytj6UX3ASqwyoBt4owTc5k9h6mMnMU') throw new Error('fixture_account_not_found');
      return { accountCredentials: structuredClone(chain.accountCredentials) };
    },
    getBlockInfo: async () => ({ blockSlotTime: new Date(chain.blockSlotTime) }),
    getBlockItemStatus: async (hash) => {
      const s = chain.statuses[TransactionHash.toHexString(hash)];
      if (!s) throw new Error('fixture_transaction_not_found');
      return { status: s.status, outcome: {
        blockHash: BlockHash.fromHexString(s.blockHash),
        summary: { ...structuredClone(s.summary), sender: AccountAddress.fromBase58(s.summary.sender) },
      } };
    },
  };
}
