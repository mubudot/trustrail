// Step 3: deploy one TESTNET account per role from the throwaway test identity, then ask the
// wallet-proxy faucet for test CCD (testnet only; worthless). Keys stay in live/.secrets.
// Roles: owner, agent (control), wallet (2-of-2: agent key 0 + co-signer key 1), cosigner,
// seller (payee), facilitator (fee sponsor).
import { TransactionExpiry, TransactionHash, AttributesKeys } from '@concordium/web-sdk';
import {
  createCredentialPayloadNoSeed, signCredentialTransaction, serializeCredentialDeploymentPayload, getAccountAddress,
} from '@concordium/web-sdk/wasm';
import { readSecret, writeSecret } from '../src/secrets.mjs';
import { TESTNET, testnetClient, explorerAccount } from '../src/net.mjs';
import { hdWallet, newEd25519 } from '../src/keys.mjs';

const ROLES = ['owner', 'agent', 'wallet', 'cosigner', 'seller', 'facilitator'];
const id = readSecret('identity-owner');
if (!id?.idObject) throw new Error('identity missing');
const client = testnetClient();
const global = await client.getCryptographicParameters();
const ips = await (await fetch(`${TESTNET.walletProxy}/v1/ip_info`)).json();
const ip = ips.find((x) => x.ipInfo.ipIdentity === id.ipIdentity);
const w = hdWallet(id);
const accounts = readSecret('accounts') || {};
const ATTRS = ['firstName','lastName','sex','dob','countryOfResidence','nationality','idDocType','idDocNo','idDocIssuer','idDocIssuedAt','idDocExpiresAt','nationalIdNo','taxIdNo'];

// Credential numbers start at CRED_BASE (6: numbers 0-5 were an earlier run, see docs/TESTNET.md).
const CRED_BASE = Number(process.env.CRED_BASE ?? 6);
for (const [i, role] of ROLES.entries()) {
  const credNumber = CRED_BASE + i;
  if (accounts[role]?.address) continue;
  const key0 = { privateKey: w.getAccountSigningKey(0, id.identityIndex, credNumber).toString('hex'), publicKey: w.getAccountPublicKey(0, id.identityIndex, credNumber).toString('hex') };
  const keys = [key0];
  if (role === 'wallet') keys.push(newEd25519()); // key 1 belongs to the co-signer
  const attributeRandomness = Object.fromEntries(ATTRS.map((a) => [a, w.getAttributeCommitmentRandomness(0, id.identityIndex, credNumber, AttributesKeys[a]).toString('hex')]));
  const expiry = TransactionExpiry.futureMinutes(10);
  const payload = createCredentialPayloadNoSeed({
    ipInfo: ip.ipInfo, globalContext: global, arsInfos: ip.arsInfos, idObject: id.idObject,
    revealedAttributes: [], credNumber,
    idCredSec: w.getIdCredSec(0, id.identityIndex).toString('hex'),
    prfKey: w.getPrfKey(0, id.identityIndex).toString('hex'),
    sigRetrievelRandomness: w.getSignatureBlindingRandomness(0, id.identityIndex).toString('hex'),
    credentialPublicKeys: { keys: Object.fromEntries(keys.map((k, i) => [i, { schemeId: 'Ed25519', verifyKey: k.publicKey }])), threshold: keys.length },
    attributeRandomness,
  }, expiry);
  const sigs = [];
  for (const k of keys) sigs.push(await signCredentialTransaction(payload, k.privateKey));
  const raw = serializeCredentialDeploymentPayload(sigs, payload);
  const hash = await client.sendCredentialDeploymentTransaction(raw, expiry);
  const address = getAccountAddress(payload.unsignedCdi.credId).address;
  console.log(role, 'credential deployment sent', hash.toString?.() ?? String(hash));
  accounts[role] = { address, credNumber, deployTx: (hash.toString?.() ?? String(hash)), keys: Object.fromEntries(keys.map((k, i) => [i, k])), threshold: keys.length };
  writeSecret('accounts', accounts);
}
for (const role of ROLES) {
  const a = accounts[role];
  await client.waitForTransactionFinalization(TransactionHash.fromHexString(a.deployTx));
  console.log(role, a.address, explorerAccount(a.address));
}
