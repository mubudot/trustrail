// Owner registers the buyer agent in the guard: binds it to the owner's CIS-8004 badge (the
// contract checks on chain that the owner holds the NFT), sets the spend policy and allowlist.
import { TESTNET, explorerTx } from '../src/net.mjs';
import { loadAccounts, roleSigner } from '../src/signers.mjs';
import { deployedGuard } from '../src/guard-instance.mjs';
import { some } from '../src/guard-client.mjs';
import { readState, writeState } from '../src/state.mjs';

export const POLICY = {
  asset: { Ccd: [] },
  per_tx_cap: 5_000_000n,          // 5 CCD
  daily_cap: 12_000_000n,          // 12 CCD per UTC day
  approval_threshold: 2_000_000n,  // above 2 CCD a verified human must approve
  auth_ttl_ms: 900_000n,           // 15 min to approve and pay
};

const st = readState();
const acc = loadAccounts();
const guard = deployedGuard();
// verify-testnet checks the 2-of-2 wallet's keys and the settlement signatures against these (public keys only).
st.guard.walletPublicKeys = { agentKey0: acc.wallet.keys[0].publicKey, cosignerKey1: acc.wallet.keys[1].publicKey };
writeState(st);
if (await guard.agent(acc.agent.address)) { console.log('already registered'); process.exit(0); }
const r = await guard.send('registerAgent', {
  agent: acc.agent.address,
  wallet: acc.wallet.address,
  badge: some({ registry: { index: TESTNET.agentRegistry.index, subindex: TESTNET.agentRegistry.subindex }, token_id: BigInt(st.badges.buyer.tokenId) }),
  policy: POLICY,
  allowlist: [acc.seller.address],
}, { sender: acc.owner.address, signer: roleSigner(acc.owner), energy: 20_000n });
st.guard.registerTx = r.txHash;
st.guard.agent = acc.agent.address;
st.guard.wallet = acc.wallet.address;
st.guard.policy = POLICY;
writeState(st);
console.log('registered', explorerTx(r.txHash));
console.log(JSON.stringify(await guard.agent(acc.agent.address), (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
process.exit(0);
