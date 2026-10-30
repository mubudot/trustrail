// Owner funds role accounts with test CCD (testnet only). Usage: node tools/fund.mjs role=CCD ...
import { testnetClient, explorerTx } from '../src/net.mjs';
import { transferCcd } from '../src/chain.mjs';
import { loadAccounts, roleSigner } from '../src/signers.mjs';

const acc = loadAccounts();
const grpc = testnetClient();
for (const arg of process.argv.slice(2)) {
  const [role, ccd] = arg.split('=');
  const r = await transferCcd(grpc, { sender: acc.owner.address, signer: roleSigner(acc.owner), to: acc[role].address, microCcd: BigInt(ccd) * 1_000_000n });
  console.log(`owner -> ${role} ${ccd} CCD`, explorerTx(r.txHash));
}
process.exit(0);
