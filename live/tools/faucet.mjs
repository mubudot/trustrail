// Request free TESTNET CCD from the wallet-proxy faucet (one drop per fresh account).
import { TransactionHash, AccountAddress } from '@concordium/web-sdk';
import { readSecret } from '../src/secrets.mjs';
import { TESTNET, testnetClient } from '../src/net.mjs';

const roles = process.argv.slice(2);
const accounts = readSecret('accounts');
const client = testnetClient();
for (const role of roles) {
  const addr = accounts[role].address;
  const r = await fetch(`${TESTNET.walletProxy}/v0/testnetGTUDrop/${addr}`, { method: 'PUT' });
  const body = await r.text();
  console.log(role, r.status, body.slice(0, 200));
  try {
    const { submissionId } = JSON.parse(body);
    if (submissionId) await client.waitForTransactionFinalization(TransactionHash.fromHexString(submissionId), 90000);
  } catch (e) { console.log('wait', e.message); }
  const info = await client.getAccountInfo(AccountAddress.fromBase58(addr));
  console.log(role, 'balance CCD', Number(info.accountAmount.microCcdAmount) / 1e6);
}
